'use strict';
/**
 * Document Service — Sprint P4.3A
 * Handles document uploads/downloads for Clients & Suppliers.
 * Uses existing incored-erp-files bucket with documents/ prefix.
 * 
 * SUPPORTED TYPES:
 *   Clients:   MSA, SOW, NDA, COI, GENERAL
 *   Suppliers: MSA, W9, CFS, ALTA_IMSS, GENERAL
 */

const { S3Client, PutObjectCommand, GetObjectCommand,
        DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 }   = require('uuid');
const path             = require('path');
const logger           = require('../utils/logger');

// ─── CONFIG ──────────────────────────────────────────────────
const BUCKET   = process.env.AWS_S3_BUCKET   || 'incored-erp-files';
const REGION   = process.env.AWS_REGION      || 'us-east-1';
const EXPIRY   = parseInt(process.env.AWS_S3_PRESIGNED_EXPIRY || '3600');

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

// ─── DOCUMENT TYPES ──────────────────────────────────────────
const CLIENT_DOC_TYPES   = ['MSA','SOW','NDA','COI','GENERAL'];
const SUPPLIER_DOC_TYPES = ['MSA','W9','CFS','ALTA_IMSS','GENERAL'];
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg','image/png','image/webp',
];
const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ─── KEY BUILDER ─────────────────────────────────────────────
// documents/clients/{clientId}/msa/2026-06-filename-uuid.pdf
function buildS3Key(entityType, entityId, docType, originalFilename) {
  const ext       = path.extname(originalFilename).toLowerCase() || '.pdf';
  const date      = new Date().toISOString().slice(0,10);
  const safeName  = path.basename(originalFilename, path.extname(originalFilename))
    .replace(/[^a-zA-Z0-9-_]/g, '-').slice(0,50);
  const uid       = uuidv4().slice(0,8);
  const folder    = docType.toLowerCase().replace('_','-');
  return `documents/${entityType}/${entityId}/${folder}/${date}-${safeName}-${uid}${ext}`;
}

// ─── VALIDATION ──────────────────────────────────────────────
function validateDocumentType(entityType, docType) {
  const allowed = entityType === 'clients' ? CLIENT_DOC_TYPES : SUPPLIER_DOC_TYPES;
  if (!allowed.includes(docType.toUpperCase()))
    throw Object.assign(new Error(`Invalid document type '${docType}' for ${entityType}. Allowed: ${allowed.join(', ')}`),
      { code:'INVALID_DOC_TYPE', statusCode:400 });
}

function validateFile(mimetype, sizeBytes) {
  if (!ALLOWED_MIME_TYPES.includes(mimetype))
    throw Object.assign(new Error(`File type not allowed: ${mimetype}`),
      { code:'INVALID_FILE_TYPE', statusCode:400 });
  if (sizeBytes > MAX_FILE_SIZE_BYTES)
    throw Object.assign(new Error(`File too large. Max ${MAX_FILE_SIZE_MB}MB`),
      { code:'FILE_TOO_LARGE', statusCode:400 });
}

// ─── UPLOAD ──────────────────────────────────────────────────
async function uploadDocument({ entityType, entityId, docType, file, uploadedBy, companyId }) {
  validateDocumentType(entityType, docType);
  validateFile(file.mimetype, file.size);

  const key = buildS3Key(entityType, entityId, docType, file.originalname);

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        file.buffer,
    ContentType: file.mimetype,
    Metadata: {
      entity_type:   entityType,
      entity_id:     String(entityId),
      doc_type:      docType.toUpperCase(),
      uploaded_by:   String(uploadedBy),
      company_id:    String(companyId),
      original_name: file.originalname,
    }
  }));

  logger.info('[DocumentService] Uploaded', {
    key, entity_type:entityType, entity_id:entityId,
    doc_type:docType, size:file.size, uploaded_by:uploadedBy
  });

  return {
    key,
    bucket:        BUCKET,
    entity_type:   entityType,
    entity_id:     entityId,
    doc_type:      docType.toUpperCase(),
    original_name: file.originalname,
    size_bytes:    file.size,
    mime_type:     file.mimetype,
    uploaded_by:   uploadedBy,
    uploaded_at:   new Date().toISOString(),
    url:           `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`,
  };
}

// ─── PRESIGNED URL (secure download) ─────────────────────────
async function getDownloadUrl(key) {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket:BUCKET, Key:key }),
    { expiresIn: EXPIRY });
  logger.info('[DocumentService] Generated presigned URL', { key, expiry:EXPIRY });
  return { url, expires_in: EXPIRY, key };
}

// ─── LIST ────────────────────────────────────────────────────
async function listDocuments(entityType, entityId, docType = null) {
  const prefix = docType
    ? `documents/${entityType}/${entityId}/${docType.toLowerCase().replace('_','-')}/`
    : `documents/${entityType}/${entityId}/`;

  const res = await s3.send(new ListObjectsV2Command({ Bucket:BUCKET, Prefix:prefix }));

  return (res.Contents || []).map(obj => ({
    key:          obj.Key,
    size_bytes:   obj.Size,
    last_modified: obj.LastModified,
    doc_type:     obj.Key.split('/')[3]?.toUpperCase().replace('-','_') || 'GENERAL',
    download_url: `/api/documents/download?key=${encodeURIComponent(obj.Key)}`,
  }));
}

// ─── DELETE ──────────────────────────────────────────────────
async function deleteDocument(key) {
  // Validate key starts with documents/ (security guard)
  if (!key.startsWith('documents/'))
    throw Object.assign(new Error('Invalid document key'),
      { code:'INVALID_KEY', statusCode:400 });

  await s3.send(new DeleteObjectCommand({ Bucket:BUCKET, Key:key }));
  logger.info('[DocumentService] Deleted', { key });
  return { deleted:true, key };
}

// ─── SUPPORTED TYPES ─────────────────────────────────────────
function getSupportedTypes(entityType) {
  return entityType === 'clients' ? CLIENT_DOC_TYPES : SUPPLIER_DOC_TYPES;
}

module.exports = {
  uploadDocument, getDownloadUrl, listDocuments,
  deleteDocument, getSupportedTypes,
  validateDocumentType, validateFile,
  CLIENT_DOC_TYPES, SUPPLIER_DOC_TYPES,
  MAX_FILE_SIZE_MB, ALLOWED_MIME_TYPES,
};
