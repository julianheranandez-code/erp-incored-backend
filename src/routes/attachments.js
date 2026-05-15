'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

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
  'materials':    'material'   // ← NEW
};

// Attachment categories by document type
const ATTACHMENT_CATEGORIES = {
  material: ['material_image','spec_sheet','vendor_catalog','installation_guide','safety_sheet','other'],
  ar_invoice: ['invoice','receipt','xml_cfdi','other'],
  ap_bill: ['invoice','receipt','xml_cfdi','purchase_order','other'],
  default: ['invoice','receipt','contract','permit','photo','report','other']
};

// ─── STORAGE ADAPTER (local → future S3) ─────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Storage abstraction layer
const storageAdapter = {
  // Save file locally
  async save(buffer, storedFilename, documentType) {
    const dir = path.join(UPLOAD_DIR, documentType);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, storedFilename);
    fs.writeFileSync(filePath, buffer);
    return {
      storage_path: `${documentType}/${storedFilename}`,
      storage_adapter: 'local'
    };
    // TODO: Replace with S3 adapter:
    // const s3 = new AWS.S3();
    // await s3.upload({ Bucket: process.env.S3_BUCKET, Key: `${documentType}/${storedFilename}`, Body: buffer }).promise();
    // return { storage_path: `s3://${process.env.S3_BUCKET}/${documentType}/${storedFilename}`, storage_adapter: 's3' };
  },

  // Read file
  async read(storagePath, storageAdapter) {
    if (storageAdapter === 'local') {
      const filePath = path.join(UPLOAD_DIR, storagePath);
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    }
    // TODO: S3 read
    return null;
  },

  // Delete file
  async delete(storagePath, storageAdapter) {
    if (storageAdapter === 'local') {
      const filePath = path.join(UPLOAD_DIR, storagePath);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    // TODO: S3 delete
  }
};

// ─── MULTER CONFIG ────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(), // Store in memory, then save via adapter
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
    material:      { table: 'materials',   col: 'company_id' }  // ← NEW
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
        CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name
      FROM document_attachments a
      LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.document_type = $1
        AND a.document_id = $2
        AND a.is_deleted = FALSE
      ORDER BY a.uploaded_at DESC
    `, [documentType, parseInt(id)]);

    // Add frontend-compatible URL fields
    const attachments = result.rows.map(a => ({
      ...a,
      file_url:   `${BASE_URL}/api/attachments/${a.id}/download`,
      public_url: `${BASE_URL}/api/attachments/${a.id}/download`,
      path:       a.storage_path,
      is_image:   a.mime_type?.startsWith('image/') || false
    }));

    res.json({ success: true, count: attachments.length, data: attachments });
  } catch (error) { next(error); }
});

// ─── POST /:kind/:id/attachments ──────────────────────────────
router.post('/:kind/:id/attachments', upload.array('files', 10), async (req, res, next) => {
  const startTime = Date.now();
  logger.info(`[Attachments] POST /${req.params.kind}/${req.params.id}/attachments`);

  try {
    const { kind, id } = req.params;
    const documentType = getDocumentType(kind);
    if (!documentType) return res.status(400).json({ success: false, error: 'invalid_kind', message: `Invalid document kind: ${kind}` });

    // Upload permissions — expand for inventory/operations
    if (!['admin','finance','manager','supervisor','project_manager','operative','technician'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Insufficient permissions to upload.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'no_files', message: 'No files uploaded.' });
    }

    const access = await assertDocumentAccess(documentType, parseInt(id), req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error
      });
    }

    const { document_category } = req.body;
    const savedAttachments = [];

    for (const file of req.files) {
      try {
        const storedFilename = generateStoredFilename(file.originalname);
        const checksum = computeChecksum(file.buffer);

        // Save via storage adapter (local or future S3)
        const { storage_path, storage_adapter } = await storageAdapter.save(
          file.buffer, storedFilename, documentType
        );

        const result = await query(`
          INSERT INTO document_attachments (
            company_id, document_type, document_id,
            original_filename, stored_filename, mime_type, file_size,
            storage_path, storage_adapter, checksum,
            document_category, uploaded_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id, original_filename, stored_filename, mime_type, file_size, storage_path, uploaded_at
        `, [
          access.companyId, documentType, parseInt(id),
          file.originalname, storedFilename, file.mimetype, file.size,
          storage_path, storage_adapter, checksum,
          document_category || null,
          req.user.id
        ]);

        const BASE_URL = process.env.API_URL || 'https://incored-api.onrender.com';
        const att = result.rows[0];
        savedAttachments.push({
          ...att,
          file_url:   `${BASE_URL}/api/attachments/${att.id}/download`,
          public_url: `${BASE_URL}/api/attachments/${att.id}/download`,
          path:       att.storage_path,
          is_image:   att.mime_type?.startsWith('image/') || false
        });
        logger.info(`[Attachments] Saved: ${file.originalname} (${file.size} bytes)`);
      } catch (fileErr) {
        // Don't fail entire request if one file fails
        logger.error(`[Attachments] Failed to save ${file.originalname}:`, fileErr.message);
      }
    }

    logger.info(`[Attachments] ${savedAttachments.length}/${req.files.length} files saved in ${Date.now()-startTime}ms`);

    // Fire and forget audit
    writeAudit({
      userId: req.user.id, action: 'attachment_uploaded',
      entityType: documentType, entityId: parseInt(id),
      companyId: access.companyId,
      newValues: { files: savedAttachments.map(a => a.original_filename), count: savedAttachments.length },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Attachments] audit failed:', err.message));

    res.status(201).json({
      success: true,
      message: `${savedAttachments.length} file(s) uploaded.`,
      data: savedAttachments
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
      RETURNING id, original_filename, document_type, document_id
    `, [req.user.id, id]);

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Attachment not found.' });
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
