'use strict';

const { verifyAccessToken, isTokenBlacklisted } = require('../config/auth');
const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Verify JWT Access Token middleware
 * Attaches req.user on success
 */
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Token de acceso requerido.',
      });
    }

    const token = authHeader.split(' ')[1];

    // Verify signature and expiry
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      const message = err.name === 'TokenExpiredError'
        ? 'Token expirado. Por favor, renueva tu sesión.'
        : 'Token inválido.';
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message,
      });
    }

    // Check blacklist
    const jti = decoded.jti || token.slice(-20);
    const blacklisted = await isTokenBlacklisted(jti);
    if (blacklisted) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Token revocado. Por favor, vuelve a iniciar sesión.',
      });
    }

    // Check user still exists and is active
    const userResult = await query(
      `SELECT id, email, name, role, company_id, status, two_fa_enabled
       FROM users WHERE id = $1`,
      [decoded.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Usuario no encontrado.',
      });
    }

    const user = userResult.rows[0];

    if (user.status !== 'active') {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Tu cuenta está suspendida o inactiva. Contacta al administrador.',
      });
    }

    // Attach to request
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      company_id: user.company_id,
      status: user.status,
    };

    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    next(error);
  }
};

/**
 * Optional token verification (for public-ish routes)
 * Does not fail if no token, but attaches user if present
 */
const optionalToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  return verifyToken(req, res, next);
};

module.exports = { verifyToken, optionalToken };
