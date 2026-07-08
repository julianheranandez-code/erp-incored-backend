'use strict';
/**
 * Project Documents Routes — Sprint RC1
 * Doc types: DRAWING, PRINT, PLANO, ENGINEERING, PICTURE_REPORT, GENERAL
 */
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { verifyToken } = require('../middleware/auth');
const { query } = require('../config/database');
const multer = require('multer');
const logger = require('../utils/logger');

const PROJECT_DOC_TYPES = ['DRAWING','PRINT','PLANO','ENGINEERING','PICTURE_REPORT','GENERAL'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf','application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/jpeg','image/png','image/webp','image/tiff',
    ];
    if (allowed.includes(file.mimetype) || /\.(dwg|dxf|rvt|skp)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

router.use(verifyToken);

// GET /api/projects/:projectId/documents
router.get('/', async (req, res, next) => {
  try {
    const projectId = req.params.projectId || req.query.project_id;
    const { doc_type } = req.query;
    let sql = `SELECT pd.*, CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name
               FROM project_documents pd
               LEFT JOIN users u ON u.id = pd.uploaded_by
               WHERE pd.project_id = $1`;
    const params = [parseInt(projectId)];
    if (doc_type) { sql += ' AND pd.doc_type = $2'; params.push(doc_type); }
    sql += ' ORDER BY pd.created_at DESC';
    const result = await query(sql, params);
    return res.json({ success: true, data: result.rows,
      metadata: { count: result.rows.length, generated_at: new Date().toISOString() } });
  } catch(e) { next(e); }
});

// GET /api/projects/:projectId/documents/types
router.get('/types', (req, res) => {
  res.json({ success: true, data: {
    doc_types: PROJECT_DOC_TYPES,
    max_file_size_mb: 25,
    allowed_extensions: ['pdf','doc','docx','ppt','pptx','jpg','jpeg','png','webp','tiff','dwg','dxf']
  }});
});

// POST /api/projects/:projectId/documents/upload
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    const projectId = req.params.projectId || req.query.project_id;
    if (!req.file) return res.status(400).json({ success: false,
      error: { code: 'NO_FILE', message: 'No file provided' } });

    const docType     = (req.body.doc_type || 'GENERAL').toUpperCase();
    const isSensitive = req.body.is_sensitive === 'true';
    const notes       = req.body.notes || null;

    if (!PROJECT_DOC_TYPES.includes(docType))
      return res.status(400).json({ success: false,
        error: { code: 'INVALID_DOC_TYPE', message: `doc_type must be: ${PROJECT_DOC_TYPES.join(', ')}` } });

    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    });

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '-');
    const key = `documents/projects/${projectId}/${docType.toLowerCase()}/${new Date().toISOString().slice(0,10)}-${safeName}-${Date.now()}`;
    const bucket = process.env.AWS_S3_BUCKET || 'incored-erp-files';

    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key,
      Body: req.file.buffer, ContentType: req.file.mimetype,
      Metadata: {
        project_id: String(projectId), doc_type: docType,
        uploaded_by: String(req.user.id), is_sensitive: String(isSensitive)
      }
    }));

    const projectResult = await query('SELECT company_id FROM projects WHERE id=$1', [parseInt(projectId)]);
    const companyId = projectResult.rows[0]?.company_id;

    const result = await query(
      `INSERT INTO project_documents
        (project_id, company_id, doc_type, original_name, s3_key, s3_bucket,
         file_size, mime_type, uploaded_by, is_sensitive, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [parseInt(projectId), companyId, docType, req.file.originalname, key, bucket,
       req.file.size, req.file.mimetype, req.user.id, isSensitive, notes]
    );

    logger.info('[ProjectDocs] Uploaded', { project_id: projectId, doc_type: docType, key });
    return res.status(201).json({ success: true, data: result.rows[0],
      metadata: { generated_at: new Date().toISOString() } });
  } catch(e) { next(e); }
});

// GET /api/projects/:projectId/documents/:docId/download
router.get('/:docId/download', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM project_documents WHERE id=$1 AND project_id=$2',
      [parseInt(req.params.docId), parseInt(req.query.project_id || req.params.projectId || 0)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false,
      error: { code: 'NOT_FOUND', message: 'Document not found' } });

    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    });
    const url = await getSignedUrl(s3,
      new GetObjectCommand({ Bucket: result.rows[0].s3_bucket, Key: result.rows[0].s3_key }),
      { expiresIn: 3600 }
    );
    return res.json({ success: true,
      data: { url, expires_in: 3600, filename: result.rows[0].original_name },
      metadata: { generated_at: new Date().toISOString() } });
  } catch(e) { next(e); }
});

// DELETE /api/projects/:projectId/documents/:docId
router.delete('/:docId', async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM project_documents WHERE id=$1 AND project_id=$2 RETURNING *',
      [parseInt(req.params.docId), parseInt(req.query.project_id || req.params.projectId || 0)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false,
      error: { code: 'NOT_FOUND', message: 'Document not found' } });
    return res.json({ success: true, data: { deleted: true, id: req.params.docId },
      metadata: { generated_at: new Date().toISOString() } });
  } catch(e) { next(e); }
});

module.exports = router;
