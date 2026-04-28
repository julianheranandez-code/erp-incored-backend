'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware: Verify JWT Token
 * Extracts token from Authorization header and verifies it
 */
const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Token de acceso requerido.'
      });
    }

    // Extract token from "Bearer <token>"
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Token de acceso inválido.'
      });
    }

    // Verify JWT
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.error('Token verification failed:', err.message);
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'token_expired',
        message: 'Token expirado.'
      });
    }

    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'invalid_token',
        message: 'Token inválido.'
      });
    }

    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Error de autenticación.'
    });
  }
};

/**
 * Middleware: Verify user role
 */
const authorizeRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
        message: 'Usuario no autenticado.'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'Permisos insuficientes.'
      });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  authorizeRole,
};
