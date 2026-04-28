'use strict';

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
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
 * Generate Refresh Token (UUID-based, stored in DB)
 * @param {number} userId
 * @returns {Promise<string>} Refresh token
 */
const generateRefreshToken = async (userId) => {
  const token = uuidv4();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  return token;
};

/**
 * Validate and rotate refresh token
 * @param {string} token
 * @returns {Promise<object>} User data from token
 */
const validateRefreshToken = async (token) => {
  const result = await query(
    `SELECT rt.*, u.id as user_id, u.email, u.role, u.company_id, u.name, u.status
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token = $1 AND rt.revoked = false AND rt.expires_at > NOW()`,
    [token]
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
  await query(
    `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token = $1`,
    [token]
  );
};

/**
 * Revoke all refresh tokens for a user (global logout)
 * @param {number} userId
 */
const revokeAllUserTokens = async (userId) => {
  await query(
    `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW()
     WHERE user_id = $1 AND revoked = false`,
    [userId]
  );
  logger.info(`All tokens revoked for user ${userId}`);
};

/**
 * Add JWT to blacklist (for logout before expiry)
 * @param {string} token - Raw JWT
 * @param {object} decoded - Decoded JWT payload
 */
const blacklistToken = async (token, decoded) => {
  const expiresAt = new Date(decoded.exp * 1000);
  await query(
    `INSERT INTO token_blacklist (token_jti, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (token_jti) DO NOTHING`,
    [decoded.jti || token.slice(-20), decoded.id, expiresAt]
  );
};

/**
 * Check if a JWT is blacklisted
 * @param {string} jti - JWT ID or token slice
 * @returns {Promise<boolean>}
 */
const isTokenBlacklisted = async (jti) => {
  const result = await query(
    `SELECT id FROM token_blacklist WHERE token_jti = $1 AND expires_at > NOW()`,
    [jti]
  );
  return result.rows.length > 0;
};

/**
 * Verify JWT token fully
 * @param {string} token
 * @returns {object} Decoded payload
 */
const verifyAccessToken = (token) => {
  return jwt.verify(token, JWT_SECRET, {
    issuer: 'IncorERP',
    audience: 'erp.incored.com.mx',
  });
};

/**
 * Clean expired tokens from DB (run periodically)
 */
const cleanExpiredTokens = async () => {
  const r1 = await query(`DELETE FROM refresh_tokens WHERE expires_at < NOW()`);
  const r2 = await query(`DELETE FROM token_blacklist WHERE expires_at < NOW()`);
  logger.info(`Cleaned ${r1.rowCount} refresh tokens and ${r2.rowCount} blacklisted tokens`);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  blacklistToken,
  isTokenBlacklisted,
  verifyAccessToken,
  cleanExpiredTokens,
};
