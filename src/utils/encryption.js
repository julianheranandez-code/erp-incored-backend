'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCODING = 'hex';

const getKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is not set');
  // Accept 64-char hex key (32 bytes) or convert from utf8
  if (key.length === 64) return Buffer.from(key, 'hex');
  return crypto.scryptSync(key, 'incored-erp-salt', 32);
};

/**
 * Encrypt a string using AES-256-GCM
 * @param {string} text - Plain text to encrypt
 * @returns {string} Encrypted string in format: iv:tag:encrypted (hex)
 */
const encrypt = (text) => {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString(ENCODING)}:${tag.toString(ENCODING)}:${encrypted.toString(ENCODING)}`;
};

/**
 * Decrypt an AES-256-GCM encrypted string
 * @param {string} encryptedText - Encrypted string
 * @returns {string} Decrypted plain text
 */
const decrypt = (encryptedText) => {
  if (!encryptedText) return null;
  const [ivHex, tagHex, dataHex] = encryptedText.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted format');

  const iv = Buffer.from(ivHex, ENCODING);
  const tag = Buffer.from(tagHex, ENCODING);
  const data = Buffer.from(dataHex, ENCODING);
  const key = getKey();

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
};

/**
 * Hash a value using SHA-256 (one-way, for lookups)
 * @param {string} value
 * @returns {string}
 */
const hashValue = (value) => {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
};

/**
 * Generate a cryptographically secure random token
 * @param {number} bytes - Token length in bytes (default 32)
 * @returns {string} Hex token
 */
const generateSecureToken = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString('hex');
};

/**
 * Generate backup codes for 2FA (array of 8 codes)
 * @returns {string[]}
 */
const generateBackupCodes = () => {
  return Array.from({ length: 8 }, () =>
    crypto.randomBytes(5).toString('hex').toUpperCase()
  );
};

/**
 * Hash backup codes for storage
 * @param {string[]} codes
 * @returns {string[]} Hashed codes
 */
const hashBackupCodes = (codes) => {
  return codes.map((code) => hashValue(code));
};

module.exports = {
  encrypt,
  decrypt,
  hashValue,
  generateSecureToken,
  generateBackupCodes,
  hashBackupCodes,
};
