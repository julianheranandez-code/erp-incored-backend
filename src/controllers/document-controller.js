'use strict';
/**
 * Document Controller — Sprint P4.3A
 * Handles uploads for Clients & Suppliers modules.
 * Uses multer for multipart/form-data.
 * Zero business logic — delegates to DocumentService.
 */
const multer  = require('multer');
const service = require('../services/document-service');
const logger  = require('../utils/logger');

// Memory storage — file goes directly to S3, never touches disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: service.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (service.ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}`));
  }
});

// ── MIDDLEWARE EXPORT (used in routes) ──────────────────────
const uploadSingle = upload.single('file');

// ── HANDLERS ────────────────────────────────────────────────

// POST /api/documents/clients/:clientId/upload
// POST /api/documents/suppliers/:supplierId/upload
async function uploadDocument(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success:false,
      error:{ code:'NO_FILE', message:'No file provided.' } });

    const entityType = req.params.clientId ? 'clients' : 'suppliers';
    const entityId   = req.params.clientId || req.params.supplierId;
    const docType    = (req.body.doc_type || 'GENERAL').toUpperCase();
    const companyId  = req.user?.company_id || 1;

    const result = await service.uploadDocument({
      entityType, entityId, docType,
      file:       req.file,
      uploadedBy: req.user?.id,
      companyId,
    });

    return res.status(201).json({ success:true, data:result,
      metadata:{ generated_at: new Date().toISOString() } });
  } catch(e) {
    logger.warn('[DocumentController] Upload error', { error:e.message, code:e.code });
    return res.status(e.statusCode||500).json({ success:false,
      error:{ code:e.code||'UPLOAD_ERROR', message:e.message } });
  }
}

// GET /api/documents/clients/:clientId
// GET /api/documents/suppliers/:supplierId
async function listDocuments(req, res) {
  try {
    const entityType = req.params.clientId ? 'clients' : 'suppliers';
    const entityId   = req.params.clientId || req.params.supplierId;
    const docType    = req.query.doc_type?.toUpperCase() || null;
    const docs       = await service.listDocuments(entityType, entityId, docType);
    return res.json({ success:true, data:docs,
      metadata:{ count:docs.length, generated_at:new Date().toISOString() } });
  } catch(e) {
    return res.status(500).json({ success:false,
      error:{ code:'LIST_ERROR', message:e.message } });
  }
}

// GET /api/documents/download?key=documents/clients/...
async function getDownloadUrl(req, res) {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ success:false,
      error:{ code:'MISSING_KEY', message:'key parameter required' } });
    const result = await service.getDownloadUrl(key);
    return res.json({ success:true, data:result,
      metadata:{ generated_at:new Date().toISOString() } });
  } catch(e) {
    return res.status(500).json({ success:false,
      error:{ code:'DOWNLOAD_ERROR', message:e.message } });
  }
}

// DELETE /api/documents?key=documents/clients/...
async function deleteDocument(req, res) {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ success:false,
      error:{ code:'MISSING_KEY', message:'key parameter required' } });
    const result = await service.deleteDocument(key);
    return res.json({ success:true, data:result,
      metadata:{ generated_at:new Date().toISOString() } });
  } catch(e) {
    return res.status(e.statusCode||500).json({ success:false,
      error:{ code:e.code||'DELETE_ERROR', message:e.message } });
  }
}

// GET /api/documents/types/:entityType
function getSupportedTypes(req, res) {
  const entityType = req.params.entityType;
  if (!['clients','suppliers'].includes(entityType))
    return res.status(400).json({ success:false,
      error:{ code:'INVALID_ENTITY', message:'entityType must be clients or suppliers' } });
  return res.json({ success:true, data:{
    entity_type: entityType,
    supported_types: service.getSupportedTypes(entityType),
    max_file_size_mb: service.MAX_FILE_SIZE_MB,
    allowed_mime_types: service.ALLOWED_MIME_TYPES,
  }});
}

module.exports = { uploadSingle, uploadDocument, listDocuments,
  getDownloadUrl, deleteDocument, getSupportedTypes };
