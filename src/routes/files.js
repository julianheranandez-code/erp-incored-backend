'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { uploadLimiter } = require('../middleware/rateLimit');
const { generateSecureToken } = require('../utils/encryption');
const logger = require('../utils/logger');

router.use(verifyToken, auditLog);

// ─── S3 Setup ─────────────────────────────────────────────────────────────────
let s3Client = null;
let upload = null;

const initStorage = () => {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_S3_BUCKET) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const multerS3 = require('multer-s3');

    s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    upload = multer({
      storage: multerS3({
        s3: s3Client,
        bucket: process.env.AWS_S3_BUCKET,
        acl: 'private',
        metadata: (req, file, cb) => {
          cb(null, { fieldName: file.fieldname, uploadedBy: String(req.user.id) });
        },
        key: (req, file, cb) => {
          const entityType = req.body.entity_type || 'general';
          const entityId = req.body.entity_id || 'unknown';
          const ext = path.extname(file.originalname);
          const key = `uploads/${entityType}/${entityId}/${uuidv4()}${ext}`;
          cb(null, key);
        },
      }),
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
      fileFilter: (req, file, cb) => {
        const allowed = [
          'image/jpeg', 'image/png', 'image/gif', 'image/webp',
          'application/pdf', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/plain', 'text/csv',
        ];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
        }
      },
    });
  } else {
    // Local storage fallback for development
    const fs = require('fs');
    const uploadDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    upload = multer({
      storage: multer.diskStorage({
        destination: uploadDir,
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname);
          cb(null, `${uuidv4()}${ext}`);
        },
      }),
      limits: { fileSize: 50 * 1024 * 1024 },
    });

    logger.warn('S3 not configured — using local file storage (not recommended for production)');
  }
};

// Initialize storage lazily
const getUpload = () => {
  if (!upload) initStorage();
  return upload;
};

// ─── POST /api/files/upload ───────────────────────────────────────────────────
router.post('/upload', uploadLimiter, (req, res, next) => {
  const uploader = getUpload();
  uploader.single('file')(req, res, async (err) => {
    if (err) {
      logger.error('Upload error:', err.message);
      return res.status(400).json({
        success: false,
        error: 'upload_error',
        message: err.message || 'Error al subir archivo.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: 'No se recibió ningún archivo.',
      });
    }

    try {
      const s3Key = req.file.key || req.file.filename;
      const result = await query(
        `INSERT INTO attachments
           (original_filename, s3_key, s3_bucket, file_size, mime_type,
            entity_type, entity_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          req.file.originalname,
          s3Key,
          process.env.AWS_S3_BUCKET || 'local',
          req.file.size,
          req.file.mimetype,
          req.body.entity_type || null,
          req.body.entity_id ? parseInt(req.body.entity_id) : null,
          req.user.id,
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Archivo subido correctamente.',
        data: {
          id: result.rows[0].id,
          filename: result.rows[0].original_filename,
          size: result.rows[0].file_size,
          mime_type: result.rows[0].mime_type,
          entity_type: result.rows[0].entity_type,
          entity_id: result.rows[0].entity_id,
          uploaded_at: result.rows[0].uploaded_at,
        },
      });
    } catch (error) {
      next(error);
    }
  });
});

// ─── GET /api/files/:id/download ─────────────────────────────────────────────
router.get('/:id/download', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM attachments WHERE id = $1`,
      [parseInt(req.params.id)]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Archivo no encontrado.',
      });
    }

    const file = result.rows[0];

    // Generate presigned URL if S3
    if (s3Client && process.env.AWS_S3_BUCKET) {
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const { GetObjectCommand } = require('@aws-sdk/client-s3');

      const command = new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: file.s3_key,
        ResponseContentDisposition: `attachment; filename="${file.original_filename}"`,
      });

      const url = await getSignedUrl(s3Client, command, {
        expiresIn: parseInt(process.env.AWS_S3_PRESIGNED_EXPIRY) || 3600,
      });

      return res.json({
        success: true,
        data: { downloadUrl: url, expiresIn: 3600 },
      });
    }

    // Local fallback
    const localPath = path.join(process.cwd(), 'uploads', file.s3_key);
    res.download(localPath, file.original_filename);
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/files/:id ────────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM attachments WHERE id = $1`,
      [parseInt(req.params.id)]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Archivo no encontrado.' });
    }

    const file = result.rows[0];

    // Only the uploader or admin can delete
    if (file.uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'No puedes eliminar este archivo.' });
    }

    // Delete from S3
    if (s3Client && process.env.AWS_S3_BUCKET) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: file.s3_key,
      })).catch((err) => logger.warn('S3 delete warning:', err.message));
    }

    await query(`DELETE FROM attachments WHERE id = $1`, [file.id]);

    res.json({ success: true, message: 'Archivo eliminado.' });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/files/:id/share ────────────────────────────────────────────────
router.post('/:id/share', async (req, res, next) => {
  try {
    const { expires_hours = 24 } = req.body;
    const expiresAt = new Date(Date.now() + expires_hours * 3600000);
    const shareToken = generateSecureToken(24);

    const result = await query(
      `UPDATE attachments SET share_token = $1, share_expires_at = $2
       WHERE id = $3 AND uploaded_by = $4
       RETURNING id, share_token, share_expires_at`,
      [shareToken, expiresAt, parseInt(req.params.id), req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Archivo no encontrado.' });
    }

    const shareUrl = `${process.env.API_URL}/api/files/shared/${shareToken}`;

    res.json({
      success: true,
      data: {
        shareUrl,
        expiresAt: result.rows[0].share_expires_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/files/shared/:token (public endpoint) ──────────────────────────
router.get('/shared/:token', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM attachments
       WHERE share_token = $1 AND share_expires_at > NOW()`,
      [req.params.token]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Enlace no encontrado o expirado.' });
    }

    const file = result.rows[0];

    if (s3Client && process.env.AWS_S3_BUCKET) {
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const command = new GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: file.s3_key,
        ResponseContentDisposition: `attachment; filename="${file.original_filename}"`,
      });
      const url = await getSignedUrl(s3Client, command, { expiresIn: 900 });
      return res.redirect(url);
    }

    const localPath = path.join(process.cwd(), 'uploads', file.s3_key);
    res.download(localPath, file.original_filename);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
