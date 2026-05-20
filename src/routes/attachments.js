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

// ─── PUBLIC PREVIEW (no auth) ────────────────────────────────
// Redirects to S3 public URL — no local filesystem
router.get('/attachments/:id/preview', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const result = await query(
      'SELECT id, mime_type, storage_path, storage_adapter, original_filename FROM document_attachments WHERE id = $1 AND is_deleted = FALSE',
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found' });
    }

    const attachment = result.rows[0];

    if (!ALLOWED_IMAGE_TYPES.includes(attachment.mime_type)) {
      return res.status(415).json({ success: false, error: 'not_image' });
    }

    // Use storageAdapter to get correct public URL
    const storageAdapter = require('../services/storageAdapter');
    const publicUrl = storageAdapter.getPublicUrl(attachment.storage_path, attachment.storage_adapter);
    logger.info(`[PREVIEW] id=${id} adapter=${attachment.storage_adapter} → redirect: ${publicUrl}`);

    return res.redirect(302, publicUrl);
  } catch (error) {
    logger.error('[Attachments] preview error:', error.message);
    next(error);
  }
});

router.use(verifyToken);

// ─── CONSTANTS ────────────────────────────────────────────────
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB (materials need larger for specs)

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
  'ar-invoices':  'ar_invoice',
  'ap-bills':     'ap_bill',
  'expenses':     'expense_report',
  'internal-pos': 'internal_po',
  'projects':     'project',
  'materials':    'material',
  'clients':      'client'    // ← NEW
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

const SENSITIVE_DOC_TYPES = ['NDA','MSA','W9','COI','CONTRACT'];

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

async function assertDocumentAccess(documentType, documentId, user) {
  const tableMap = {
    ar_invoice:    { table: 'ar_invoices', col: 'company_id' },
    ap_bill:       { table: 'ap_bills',    col: 'company_id' },
    expense_report:{ table: 'expense_reports', col: 'company_id' },
    internal_po:   { table: 'internal_purchase_orders', col: 'company_id' },
    project:       { table: 'projects',    col: 'company_id' },
    material:      { table: 'materials',   col: 'company_id' },
    client:        { table: 'clients',     col: 'company_id' }  // ← NEW
  };

  const mapping = tableMap[documentType];
  if (!mapping) return { error: 'invalid_document_type' };

  const result = await query(
    `SELECT ${mapping.col} AS company_id FROM ${mapping.table} WHERE id = $1`,
    [documentId]
  );
  if (!result.rows[0]) return { error: 'not_found' };
  if (user.role !== 'admin' && result.rows[0].company_id !== parseInt(user.company_id)) {
    return { error: 'forbidden' };
  }
  return { companyId: result.rows[0].company_id };
}

// ─── GET /:kind/:id/attachments ───────────────────────────────
router.get('/:kind/:id/attachments', async (req, res, next) => {
  try {
    const { kind, id } = req.params;
    const documentType = getDocumentType(kind);
    if (!documentType) return res.status(400).json({ success: false, error: 'invalid_kind', message: `Invalid document kind: ${kind}` });

    // View permissions — inventory team can also view
    if (!['admin','finance','manager','supervisor','project_manager','operative','technician'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Insufficient permissions.' });
    }

    const access = await assertDocumentAccess(documentType, parseInt(id), req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error
      });
    }

    const BASE_URL = process.env.API_URL || 'https://incored-api.onrender.com';

    const result = await query(`
      SELECT
        a.id, a.original_filename, a.stored_filename,
        a.mime_type, a.file_size,
        a.document_category, a.storage_path, a.storage_adapter,
        a.uploaded_at, a.cfdi_uuid, a.cfdi_validated,
        a.expiration_date, a.notes,
        COALESCE(a.is_sensitive, FALSE) AS is_sensitive,
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
      const publicUrl  = storageAdapter.getPublicUrl(a.storage_path, a.storage_adapter, a.mime_type);
      const downloadUrl = `${BASE_URL}/api/attachments/${a.id}/download`;
      return {
        ...a,
        file_url:    downloadUrl,
        public_url:  isImage ? publicUrl : downloadUrl,
        preview_url: isImage ? publicUrl : null,
        url:         isImage ? publicUrl : downloadUrl,
        path:        a.storage_path,
        is_image:    isImage
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
    const documentType = getDocumentType(kind);
    if (!documentType) return res.status(400).json({ success: false, error: 'invalid_kind', message: `Invalid document kind: ${kind}` });

    // Upload permissions — expand for inventory/operations
    if (!['admin','finance','manager','supervisor','project_manager','operative','technician'].includes(req.user.role)) {
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

    const { document_category, expiration_date, notes: docNotes, is_sensitive } = req.body;
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
        const publicUrl = storedPublicUrl;

        logger.info(`[UPLOAD] storage_adapter=${att.storage_adapter} storage_path=${att.storage_path}`);
        logger.info(`[S3] public url: ${publicUrl}`);
        logger.info(`[FRONTEND IMG SRC]: ${isImage ? publicUrl : 'N/A (not image)'}`);

        savedAttachments.push({
          ...att,
          file_url:    `${BASE_URL}/api/attachments/${att.id}/download`,
          public_url:  isImage ? publicUrl : `${BASE_URL}/api/attachments/${att.id}/download`,
          preview_url: isImage ? publicUrl : null,
          url:         isImage ? publicUrl : `${BASE_URL}/api/attachments/${att.id}/download`,
          path:        att.storage_path,
          is_image:    isImage
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
        message: 'File exceeds 10MB limit.'
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

    // Company isolation check
    if (req.user.role !== 'admin' && attachment.company_id !== parseInt(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
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
    // Only super_admin can delete
    if (!['admin'].includes(req.user.role)) {
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
