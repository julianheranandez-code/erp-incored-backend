'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('./database');
const logger = require('../utils/logger');

const {
  JWT_SECRET,
  JWT_EXPIRY,
  REFRESH_TOKEN_SECRET,
  REFRESH_TOKEN_EXPIRY,
} = process.env;

/**
 * Generate Access JWT Token
 * @param {object} payload - User data to embed
 * @returns {string} Signed JWT
 */
const generateAccessToken = (payload) => {
  return jwt.sign(
    {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      company_id: payload.company_id,
      name: payload.name,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRY || '24h',
      issuer: 'IncorERP',
      audience: 'erp.incored.com.mx',
    }
  );
};

/**
 * Generate Refresh Token (hash-based, stored in DB)
 * @param {number} userId
 * @returns {Promise<string>} Refresh token
 */
const generateRefreshToken = async (userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  return token;
};

/**
 * Validate and rotate refresh token
 * @param {string} token
 * @returns {Promise<object>} User data from token
 */
const validateRefreshToken = async (token) => {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  const result = await query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
            u.id, u.email, u.role, u.company_id, CONCAT(u.first_name, ' ', u.last_name) AS name, u.status
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid or expired refresh token');
  }

  const row = result.rows[0];

  // Check user is still active
  if (row.status !== 'active') {
    await revokeRefreshToken(token);
    throw new Error('User account is not active');
  }

  return row;
};

/**
 * Revoke a single refresh token
 * @param {string} token
 */
const revokeRefreshToken = async (token) => {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
    [tokenHash]
  );
};

/**
 * Revoke all refresh tokens for a user (global logout)
 * @param {number} userId
 */
const revokeAllRefreshTokens = async (userId) => {
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
};

/**
 * Verify JWT Token
 * @param {string} token
 * @param {string} secret
 * @returns {object} Decoded token
 */
const verifyToken = (token, secret = JWT_SECRET) => {
  try {
    return jwt.verify(token, secret);
  } catch (err) {
    logger.error('Token verification failed:', err.message);
    return null;
  }
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  verifyToken,
};
