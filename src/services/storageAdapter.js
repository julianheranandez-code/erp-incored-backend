'use strict';

const path = require('path');
const fs   = require('fs');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET   = process.env.AWS_S3_BUCKET  || 'incored-erp-uploads';
const REGION   = process.env.AWS_REGION     || 'us-east-2';
const S3_URL   = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
const BASE_URL = process.env.API_URL || 'https://incored-api.onrender.com';
const USE_S3   = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET);

let s3Client = null;
if (USE_S3) {
  s3Client = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
  console.log(`[Storage] S3 ACTIVE → bucket: ${BUCKET} region: ${REGION} url: ${S3_URL}`);
} else {
  console.log('[Storage] LOCAL adapter (S3 env vars missing)');
}

const MIME_MAP = {
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
  '.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf',
  '.xml':'application/xml','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.zip':'application/zip'
};

function getMime(filename) {
  return MIME_MAP[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

const storageAdapter = {
  isS3() { return USE_S3; },

  // Returns { storage_path, storage_adapter, public_url }
  async save(buffer, storedFilename, documentType) {
    const key = `${documentType}/${storedFilename}`;

    if (USE_S3) {
      const putParams = {
        Bucket: BUCKET, Key: key, Body: buffer,
        ContentType: getMime(storedFilename),
        CacheControl: 'public, max-age=31536000'
        // No ACL — bucket policy handles public read
      };
      await s3Client.send(new PutObjectCommand(putParams));
      const publicUrl = `${S3_URL}/${key}`;
      console.log(`[S3] uploaded: ${key}`);
      console.log(`[S3] public url: ${publicUrl}`);
      return { storage_path: key, storage_adapter: 's3', public_url: publicUrl };
    }

    // Local fallback
    const LOCAL_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
    const dir = path.join(LOCAL_DIR, documentType);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, storedFilename), buffer);
    const publicUrl = `${BASE_URL}/uploads/${key}`;
    return { storage_path: key, storage_adapter: 'local', public_url: publicUrl };
  },

  async read(storagePath, adapter) {
    if (adapter === 's3') {
      const res = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: storagePath }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    const LOCAL_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
    const fp = path.join(LOCAL_DIR, storagePath);
    return fs.existsSync(fp) ? fs.readFileSync(fp) : null;
  },

  async delete(storagePath, adapter) {
    if (adapter === 's3') {
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storagePath }));
    } else {
      const LOCAL_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
      const fp = path.join(LOCAL_DIR, storagePath);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  },

  // Always returns correct public URL based on adapter
  getPublicUrl(storagePath, adapter) {
    if (adapter === 's3') {
      const url = `${S3_URL}/${storagePath}`;
      console.log(`[IMG] resolved image_url: ${url} (S3)`);
      return url;
    }
    const url = `${BASE_URL}/uploads/${storagePath}`;
    console.log(`[IMG] resolved image_url: ${url} (local)`);
    return url;
  }
};

module.exports = storageAdapter;
