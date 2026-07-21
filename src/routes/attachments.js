'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');
const storageAdapter = require('../services/storageAdapter');

const BASE_URL = process.env.API_URL || 'https://incored-api.onrender.com';
const ALLOWED_IMAGE_TYPES = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];

// ─── FINAL ISSUE 1: Public preview access rules ───────────────
// STRICT WHITELIST: Only materials use public preview
// Everything else requires authenticated access
const SAFE_PUBLIC_PREVIEW_TYPES = ['material'];

function canUsePublicPreview(documentType) {
  return SAFE_PUBLIC_PREVIEW_TYPES.includes(documentType);
}

// ─── PREVIEW ENDPOINT ─────────────────────────────────────────
// FINAL ISSUE 1: ALL employee docs require auth
// Only materials + non-employee non-sensitive images use public redirect
router.get('/attachments/:id/preview', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const result = await query(
      `SELECT id, mime_type, storage_path, storage_adapter, original_filename,
              document_type, document_category, company_id
       FROM document_attachments WHERE id = $1 AND is_deleted = FALSE`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found' });
    }

    const attachment = result.rows[0];

    if (!ALLOWED_IMAGE_TYPES.includes(attachment.mime_type)) {
      return res.status(415).json({ success: false, error: 'not_image' });
    }

    // FINAL ISSUE 1: Employee docs ALWAYS require auth — no exceptions
    if (attachment.document_type === 'employee') {
      return res.status(403).json({
        success: false,
        error: 'access_forbidden',
        message: 'Employee documents require authenticated access. Use GET /api/attachments/:id/download with Bearer token.'
      });
    }

    // Strict whitelist: only materials use public preview
    if (!canUsePublicPreview(attachment.document_type)) {
      return res.status(403).json({
        success: false,
        error: 'access_forbidden',
        message: 'This document requires authenticated access. Use GET /api/attachments/:id/download with Bearer token.'
      });
    }

    // Safe public redirect — materials + non-sensitive operational images
    const storageAdapterSvc = require('../services/storageAdapter');
    const publicUrl = storageAdapterSvc.getPublicUrl(attachment.storage_path, attachment.storage_adapter);
    logger.info(`[PREVIEW] id=${id} type=${attachment.document_type} adapter=${attachment.storage_adapter} → public redirect`);

    return res.redirect(302, publicUrl);
  } catch (error) {
    logger.error('[Attachments] preview error:', error.message);
    next(error);
  }
});

router.use(verifyToken);

// ─── CONSTANTS ────────────────────────────────────────────────
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// FIX 1: Enterprise role separation
// SUPER_ADMIN → delete, force delete, manage sensitive docs
// ADMIN       → upload, view, download
// Future: sensitive docs (NDA, MSA, W9, COI, CONTRACT) may require
//   role-based visibility, restricted downloads, signed URLs (HR/Legal/Payroll)
const ROLES_CAN_VIEW   = ['admin','super_admin','finance','manager','supervisor','project_manager','operative','technician'];
const ROLES_CAN_UPLOAD = ['admin','super_admin','finance','manager','supervisor','project_manager','operative','technician'];
const ROLES_CAN_DELETE = ['admin','super_admin'];

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/xml', 'application/xml',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/zip', 'application/x-zip-compressed',
  'application/octet-stream',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

const DOCUMENT_TYPE_MAP = {
  'ar-invoices':   'ar_invoice',
  'ap-bills':      'ap_bill',
  'expenses':      'expense',
  'internal-pos':  'internal_po',
  'projects':      'project',
  'materials':     'material',
  'clients':       'client',
  'providers':     'client',
  'suppliers':     'client',
  'opportunities': 'opportunity',
  'leads':         'lead',
  'employees':     'employee'    // ← NEW
};

// Attachment categories by document type
const ATTACHMENT_CATEGORIES = {
  material: ['material_image','spec_sheet','vendor_catalog','installation_guide','safety_sheet','other'],
  client: [
    'CONTRACT','NDA','SAT','RFC','CONSTANCIA_FISCAL','PURCHASE_ORDER','AGREEMENT',
    'MSA','SOW','W9','COI','RATE_CARD','INSURANCE','VENDOR_PACKAGE','SAFETY','OTHER'
  ],
  ar_invoice: ['invoice','receipt','xml_cfdi','other'],
  ap_bill: ['invoice','receipt','xml_cfdi','purchase_order','other'],
  default: ['invoice','receipt','contract','permit','photo','report','other']
};

const SENSITIVE_DOC_TYPES = ['NDA','MSA','W9','COI','CONTRACT','RATE_CARD'];

// Opportunity document categories
const OPPORTUNITY_DOC_CATEGORIES = ['PURCHASE_ORDER','CONTRACT','AWARD_LETTER','SOW','MSA','CHANGE_ORDER','OTHER'];

// ─── MULTER CONFIG ────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`FILE_TYPE_NOT_ALLOWED: ${file.mimetype}`));
    }
  }
});

// ─── HELPERS ─────────────────────────────────────────────────
function getDocumentType(kind) {
  return DOCUMENT_TYPE_MAP[kind] || null;
}

function generateStoredFilename(originalName) {
  const ext = path.extname(originalName);
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  return `${timestamp}-${random}${ext}`;
}

function computeChecksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// FIX: resolve company_id from multiple possible user object shapes
// ─── HR SENSITIVE DOCUMENT TYPES ─────────────────────────────
// PATCH 2: Only admin/finance can access these for employees
const HR_SENSITIVE_DOC_TYPES = [
  'RFC','CURP','IMSS','TAX_ID','W7','W9','NDA','CONTRACT',
  'INSURANCE','PAYROLL_SUPPORT','WORK_AUTHORIZATION','identification',
  'tax_document','contract','payroll_support'
];

const HR_AUTHORIZED_ROLES = ['admin','super_admin','finance'];

// FIX 2: Roles that bypass company-level restrictions
const COMPANY_ACCESS_BYPASS_ROLES = ['admin', 'super_admin', 'finance'];

// FIX 3: Normalized case-insensitive sensitive doc check
function isSensitiveEmployeeDoc(documentType, documentCategory) {
  if (documentType !== 'employee') return false;
  const cat = String(documentCategory || '').trim().toUpperCase();
  return HR_SENSITIVE_DOC_TYPES.map(t => t.toUpperCase()).includes(cat);
}

function resolveCompanyId(user) {
  return parseInt(
    user.active_company_id ||
    user.company_id ||
    user.companyId ||
    user.selected_company_id ||
    0
  ) || null;
}

async function assertDocumentAccess(documentType, documentId, user) {
  const resolvedCompanyId = resolveCompanyId(user);

  // PATCH 1: Employee access — multi-company isolation
  if (documentType === 'employee') {
    const result = await query(
      `SELECT id FROM employees WHERE id = $1`,
      [parseInt(documentId)]
    );
    if (!result.rows[0]) return { error: 'not_found' };

    // Validate user has access via at least one company profile
    if (!COMPANY_ACCESS_BYPASS_ROLES.includes(user.role)) {
      const access = await query(`
        SELECT 1 FROM employee_company_profiles ecp
        WHERE ecp.emp_id = $1 AND ecp.company_id = $2
        LIMIT 1
      `, [parseInt(documentId), resolvedCompanyId]);
      if (!access.rows[0]) return { error: 'forbidden' };
    }
    return { companyId: resolvedCompanyId };
  }

  const tableMap = {
    ar_invoice:    { table: 'ar_invoices', col: 'company_id' },
    ap_bill:       { table: 'ap_bills',    col: 'company_id' },
    expense_report:{ table: 'expense_reports', col: 'company_id' },
    expense:       { table: 'expenses',                 col: 'company_id' },
    internal_po:   { table: 'internal_purchase_orders', col: 'company_id' },
    project:       { table: 'projects',    col: 'company_id' },
    material:      { table: 'materials',   col: 'company_id' },
    client:        { table: 'clients',     col: 'company_id' },
    opportunity:   { table: 'leads',       col: 'company_id' },
    lead:          { table: 'leads',       col: 'company_id' }
    // Note: providers/suppliers also map to 'client' doc type using clients table
  };

  const mapping = tableMap[documentType];
  if (!mapping) return { error: 'invalid_document_type' };

  const result = await query(
    `SELECT ${mapping.col} AS company_id FROM ${mapping.table} WHERE id = $1`,
    [parseInt(documentId)]
  );
  if (!result.rows[0]) return { error: 'not_found' };

  const recordCompanyId = result.rows[0].company_id || parseInt(resolvedCompanyId);

  logger.info(`[ATTACHMENTS] resolvedCompanyId: ${resolvedCompanyId}`);
  logger.info(`[ATTACHMENTS] recordCompanyId: ${recordCompanyId}`);
  logger.info(`[ATTACHMENTS] user role: ${user.role}`);

  if (!COMPANY_ACCESS_BYPASS_ROLES.includes(user.role) && recordCompanyId !== parseInt(resolvedCompanyId)) {
    return { error: 'forbidden' };
  }
  return { companyId: recordCompanyId };
}

// ─── GET /:kind/:id/attachments ───────────────────────────────
router.get('/:kind/:id/attachments', async (req, res, next) => {
  try {
    const { kind, id } = req.params;
    logger.info('[ATTACHMENTS] kind received:', kind, '| documentType:', getDocumentType(kind));
    const documentType = getDocumentType(kind);
    if (!documentType) return res.status(400).json({ success: false, error: 'invalid_kind', message: `Invalid document kind: ${kind}` });

    // View permissions
    if (!ROLES_CAN_VIEW.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Insufficient permissions.' });
    }

    const access = await assertDocumentAccess(documentType, parseInt(id), req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error
      });
    }

    const BASE_URL = process.env.API_URL || 'https://incored-api.onrender.com';

    // PATCH 2: HR sensitive document RBAC — employee docs only
    if (documentType === 'employee' && !HR_AUTHORIZED_ROLES.includes(req.user.role)) {
      // Non-HR roles: filter out sensitive docs using normalized check
      const result = await query(`
        SELECT a.id, a.original_filename, a.stored_filename,
          a.mime_type, a.file_size, a.document_category,
          a.storage_path, a.storage_adapter, a.uploaded_at,
          a.expiration_date, a.notes,
          COALESCE(a.is_sensitive, FALSE) AS is_sensitive,
          a.is_verified, a.verified_at, a.verification_notes,
          CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name
        FROM document_attachments a
        LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.document_type = $1 AND a.document_id = $2
          AND a.is_deleted = FALSE
          AND (a.is_sensitive = FALSE OR a.is_sensitive IS NULL)
          AND UPPER(COALESCE(a.document_category,'')) != ALL($3::text[])
        ORDER BY a.uploaded_at DESC
      `, [documentType, parseInt(id), HR_SENSITIVE_DOC_TYPES.map(t => t.toUpperCase())]);

      const attachments = result.rows.map(a => {
        const isImage = ALLOWED_IMAGE_TYPES.includes(a.mime_type);
        const downloadUrl = `${BASE_URL}/api/attachments/${a.id}/download`;
        return {
          ...a,
          file_url:     downloadUrl,
          // V8 SEMANTIC: employee docs never have public_url
          public_url:   null,
          preview_url:  null,
          url:          downloadUrl,
          path:         a.storage_path,
          is_image:     isImage,
          requires_auth: true
        };
      });

      return res.json({ success: true, count: attachments.length, data: attachments });
    }

    // Standard query for non-employee or HR-authorized roles
    const result = await query(`
      SELECT
        a.id, a.original_filename, a.stored_filename,
        a.mime_type, a.file_size,
        a.document_category, a.storage_path, a.storage_adapter,
        a.uploaded_at, a.cfdi_uuid, a.cfdi_validated,
        a.expiration_date, a.notes,
        COALESCE(a.is_sensitive, FALSE) AS is_sensitive,
        a.is_verified, a.verified_at, a.verification_notes,
        CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name
      FROM document_attachments a
      LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.document_type = $1
        AND a.document_id = $2
        AND a.is_deleted = FALSE
      ORDER BY a.uploaded_at DESC
    `, [documentType, parseInt(id)]);

    // Add frontend-compatible URL fields
    const attachments = result.rows.map(a => {
      const isImage   = ALLOWED_IMAGE_TYPES.includes(a.mime_type);
      const downloadUrl = `${BASE_URL}/api/attachments/${a.id}/download`;

      // FINAL ISSUE 2: ALL employee docs require auth — no public URLs
      const isSensitiveEmpDoc = documentType === 'employee'; // entire employee namespace locked
      const publicUrl = (!isSensitiveEmpDoc && isImage)
        ? storageAdapter.getPublicUrl(a.storage_path, a.storage_adapter, a.mime_type)
        : downloadUrl;

      return {
        ...a,
        file_url:    downloadUrl,
        // V8 SEMANTIC CLEANUP: employee docs → public_url=null (not a public URL)
        public_url:  isSensitiveEmpDoc ? null : (isImage ? publicUrl : downloadUrl),
        preview_url: isSensitiveEmpDoc ? null : (isImage ? publicUrl : null),
        url:         isSensitiveEmpDoc ? downloadUrl : (isImage ? publicUrl : downloadUrl),
        path:        a.storage_path,
        is_image:    isImage,
        requires_auth: isSensitiveEmpDoc
      };
    });

    res.json({ success: true, count: attachments.length, data: attachments });
  } catch (error) { next(error); }
});

// ─── POST /:kind/:id/attachments ──────────────────────────────
router.post('/:kind/:id/attachments', upload.any(), async (req, res, next) => {
  const startTime = Date.now();
  logger.info(`[Attachments] POST /${req.params.kind}/${req.params.id}/attachments`);

  // ── MULTER DIAGNOSTICS ─────────────────────────────────────
  console.log('[MULTER] content-type:', req.headers['content-type']);
  console.log('[MULTER] req.files:', req.files);
  console.log('[MULTER] req.files length:', req.files?.length);
  console.log('[MULTER] req.body keys:', Object.keys(req.body || {}));

  try {
    const { kind, id } = req.params;
    logger.info('[ATTACHMENTS] kind received:', kind, '| documentType:', getDocumentType(kind));
    const documentType = getDocumentType(kind);
    if (!documentType) return res.status(400).json({ success: false, error: 'invalid_kind', message: `Invalid document kind: ${kind}` });

    // Upload permissions
    if (!ROLES_CAN_UPLOAD.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Insufficient permissions to upload.' });
    }

    // Accept files from any field name
    const files = req.files || [];
    console.log('[FILES RECEIVED]:', files.length, files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype })));

    if (files.length === 0) {
      return res.status(400).json({
        success: false, error: 'no_files',
        message: 'No files received by server. Check FormData field name and Content-Type.',
        debug: {
          content_type: req.headers['content-type'],
          body_keys: Object.keys(req.body || {}),
          files_received: 0
        }
      });
    }

    const access = await assertDocumentAccess(documentType, parseInt(id), req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error
      });
    }

    const { expiration_date, notes: docNotes, is_sensitive } = req.body;
    const document_category = req.body.document_category || req.body.doc_type || 'other';
    const isSensitive = is_sensitive === 'true' || is_sensitive === true ||
      SENSITIVE_DOC_TYPES.includes((document_category || '').toUpperCase());
    const savedAttachments = [];

    for (const file of files) {
      try {
        const storedFilename = generateStoredFilename(file.originalname);
        const checksum = computeChecksum(file.buffer);

        // Save via storage adapter (S3 or local)
        const { storage_path, storage_adapter, public_url: storedPublicUrl } = await storageAdapter.save(
          file.buffer, storedFilename, documentType
        );

        logger.info(`[ATTACHMENTS INSERT] companyId: ${access.companyId}`);
        logger.info(`[ATTACHMENTS INSERT] documentType: ${documentType}`);
        logger.info(`[ATTACHMENTS INSERT] documentId: ${parseInt(id)}`);

        const result = await query(`
          INSERT INTO document_attachments (
            company_id, document_type, document_id,
            original_filename, stored_filename, mime_type, file_size,
            storage_path, storage_adapter, checksum,
            document_category, notes, is_sensitive, expiration_date,
            uploaded_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id, original_filename, stored_filename, mime_type, file_size,
                    storage_path, storage_adapter, uploaded_at,
                    document_category, is_sensitive, expiration_date, notes
        `, [
          access.companyId, documentType, parseInt(id),
          file.originalname, storedFilename, file.mimetype, file.size,
          storage_path, storage_adapter, checksum,
          document_category || null,
          docNotes || null,
          isSensitive || false,
          expiration_date || null,
          req.user.id
        ]);

        const att = result.rows[0];
        const isImage = ALLOWED_IMAGE_TYPES.includes(att.mime_type);
        // S3 URL if uploaded to S3, otherwise local
        const rawPublicUrl = storedPublicUrl;
        const downloadUrl  = `${BASE_URL}/api/attachments/${att.id}/download`;

        // FINAL ISSUE 2: ALL employee docs require auth — no profile photo exceptions
        const isSensitiveEmp = documentType === 'employee'; // ALL employee docs locked down

        logger.info(`[UPLOAD] storage_adapter=${att.storage_adapter} storage_path=${att.storage_path}`);
        logger.info(`[S3] public url: ${isSensitiveEmp ? '(employee doc - suppressed)' : rawPublicUrl}`);

        savedAttachments.push({
          ...att,
          file_url:      downloadUrl,
          public_url:    isSensitiveEmp ? null : (isImage ? rawPublicUrl : downloadUrl),
          preview_url:   isSensitiveEmp ? null : (isImage ? rawPublicUrl : null),
          url:           isSensitiveEmp ? downloadUrl : (isImage ? rawPublicUrl : downloadUrl),
          path:          att.storage_path,
          is_image:      isImage,
          requires_auth: isSensitiveEmp || false
        });
        logger.info(`[Attachments] Saved: ${file.originalname} (${file.size} bytes)`);
      } catch (fileErr) {
        // Don't fail entire request if one file fails
        logger.error(`[Attachments] Failed to save ${file.originalname}:`, fileErr.message);
      }
    }

    logger.info(`[Attachments] ${savedAttachments.length}/${files.length} files saved in ${Date.now()-startTime}ms`);

    // ── AUTO-UPDATE PRIMARY IMAGE for materials ───────────────
    if (documentType === 'material') {
      const firstImage = savedAttachments.find(a => a.is_image);
      if (firstImage) {
        const imageUrl = firstImage.public_url;
        await query(`
          UPDATE materials SET image_url=$1, thumbnail_url=$1, updated_at=NOW()
          WHERE id=$2
        `, [imageUrl, parseInt(id)]);
        logger.info(`[UPLOAD] persisted image_url: ${imageUrl}`);
      }
    }

    // Fire and forget audit
    writeAudit({
      userId: req.user.id, action: 'attachment_uploaded',
      entityType: documentType, entityId: parseInt(id),
      companyId: access.companyId,
      newValues: { files: savedAttachments.map(a => a.original_filename), count: savedAttachments.length },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Attachments] audit failed:', err.message));

    // Normalize response — maximum frontend compatibility
    const first = savedAttachments[0] || null;
    const s3Url = first?.is_image ? first?.public_url : null;

    res.status(201).json({
      success: true,
      message: `${savedAttachments.length} file(s) uploaded.`,
      // Top-level fields — different frontends expect different names
      image_url:   s3Url,
      public_url:  first?.public_url || null,
      preview_url: s3Url,
      file_url:    first?.file_url   || null,
      url:         first?.is_image ? first?.public_url : first?.file_url,
      path:        first?.path       || null,
      is_image:    first?.is_image   || false,
      // attachment object (some frontends expect this shape)
      attachment: first ? {
        id:          first.id,
        image_url:   s3Url,
        public_url:  first.public_url,
        preview_url: s3Url,
        file_url:    first.file_url,
        url:         first.is_image ? first.public_url : first.file_url,
        mime_type:   first.mime_type,
        is_image:    first.is_image,
        path:        first.path
      } : null,
      // data object
      data: savedAttachments.length === 1 ? {
        ...first,
        image_url:   s3Url,
        public_url:  first.public_url,
        preview_url: s3Url,
        url:         first.is_image ? first.public_url : first.file_url,
        path:        first.path,
        is_image:    first.is_image
      } : savedAttachments,
      attachments: savedAttachments
    });
  } catch (error) {
    if (error.message?.startsWith('FILE_TYPE_NOT_ALLOWED')) {
      return res.status(400).json({
        success: false, error: 'file_type_not_allowed',
        message: 'File type not supported. Allowed: PDF, XML, images, ZIP.'
      });
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false, error: 'file_too_large',
        message: 'File exceeds 20MB limit.'
      });
    }
    next(error);
  }
});

// ─── GET /attachments/:id/download ───────────────────────────
router.get('/attachments/:id/download', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);

    const result = await query(
      'SELECT * FROM document_attachments WHERE id = $1 AND is_deleted = FALSE',
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Attachment not found.' });
    }

    const attachment = result.rows[0];

    // Company isolation check — FIX 2: use COMPANY_ACCESS_BYPASS_ROLES
    const resolvedCompanyId = resolveCompanyId(req.user);
    if (!COMPANY_ACCESS_BYPASS_ROLES.includes(req.user.role) && attachment.company_id !== parseInt(resolvedCompanyId)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    // FIX 3: HR sensitive document protection — normalized case-insensitive check
    if (isSensitiveEmployeeDoc(attachment.document_type, attachment.document_category) &&
        !HR_AUTHORIZED_ROLES.includes(req.user.role)) {
      logger.warn(`[ATTACHMENTS] Unauthorized sensitive doc access attempt: user=${req.user.id} doc=${id} category=${attachment.document_category}`);
      return res.status(403).json({
        success: false, error: 'sensitive_document_access_denied',
        message: 'Access to this document requires HR/Finance authorization.'
      });
    }

    const buffer = await storageAdapter.read(attachment.storage_path, attachment.storage_adapter);
    if (!buffer) {
      return res.status(404).json({ success: false, error: 'file_not_found', message: 'File not found in storage.' });
    }

    // Log download (fire and forget)
    query(
      'INSERT INTO attachment_downloads (attachment_id, downloaded_by, ip_address) VALUES ($1,$2,$3::inet)',
      [id, req.user.id, req.ip || '0.0.0.0']
    ).catch(err => logger.error('[Attachments] download log failed:', err.message));

    res.set({
      'Content-Type': attachment.mime_type,
      'Content-Disposition': `attachment; filename="${attachment.original_filename}"`,
      'Content-Length': buffer.length
    });

    res.send(buffer);
  } catch (error) { next(error); }
});

// ─── DELETE /attachments/:id ──────────────────────────────────
router.delete('/attachments/:id', async (req, res, next) => {
  try {
    // FIX 1: super_admin or admin can delete
    if (!ROLES_CAN_DELETE.includes(req.user.role)) {
      return res.status(403).json({
        success: false, error: 'forbidden',
        message: 'Only administrators can delete attachments.'
      });
    }

    const id = parseInt(req.params.id);
    const result = await query(`
      UPDATE document_attachments SET
        is_deleted = TRUE,
        deleted_at = NOW(),
        deleted_by = $1
      WHERE id = $2 AND is_deleted = FALSE
      RETURNING id, original_filename, document_type, document_id, storage_path, storage_adapter
    `, [req.user.id, id]);

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Attachment not found.' });
    }

    // If deleted attachment was a material image → clear image_url
    if (result.rows[0].document_type === 'material') {
      const storageAdapterSvc = require('../services/storageAdapter');
      const deletedUrl = storageAdapterSvc.getPublicUrl(
        result.rows[0].storage_path,
        result.rows[0].storage_adapter
      );
      await query(`
        UPDATE materials SET
          image_url     = CASE WHEN image_url = $1 THEN NULL ELSE image_url END,
          thumbnail_url = CASE WHEN thumbnail_url = $1 THEN NULL ELSE thumbnail_url END,
          updated_at    = NOW()
        WHERE id = $2
      `, [deletedUrl, result.rows[0].document_id]);
      logger.info(`[Attachments] DELETE: cleared material image_url if matched ${deletedUrl}`);
    }

    // Audit log
    writeAudit({
      userId: req.user.id, action: 'attachment_deleted',
      entityType: result.rows[0].document_type,
      entityId: result.rows[0].document_id,
      oldValues: { filename: result.rows[0].original_filename },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Attachments] audit failed:', err.message));

    res.json({ success: true, message: 'Attachment deleted.', data: result.rows[0] });
  } catch (error) { next(error); }
});

module.exports = router;
