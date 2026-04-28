'use strict';

const rateLimit = require('express-rate-limit');

const {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  LOGIN_RATE_LIMIT_MAX,
} = process.env;

const windowMs = parseInt(RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 min

/**
 * General API rate limiter
 */
const generalLimiter = rateLimit({
  windowMs,
  max: parseInt(RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Demasiadas solicitudes. Por favor espera un momento.',
  },
  skip: (req) => {
    // Skip health checks
    return req.path.startsWith('/health');
  },
});

/**
 * Strict login limiter – 5 attempts per 15 minutes per IP
 */
const loginLimiter = rateLimit({
  windowMs,
  max: parseInt(LOGIN_RATE_LIMIT_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Key by IP + email combo to prevent distributed attacks
    const email = req.body?.email || 'unknown';
    return `${req.ip}_${email}`;
  },
  message: {
    success: false,
    error: 'too_many_attempts',
    message: 'Demasiados intentos de inicio de sesión. Tu cuenta ha sido bloqueada por 15 minutos.',
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'too_many_attempts',
      message: 'Demasiados intentos fallidos. Espera 15 minutos antes de intentar de nuevo.',
      retryAfter: Math.ceil(windowMs / 1000 / 60),
    });
  },
});

/**
 * File upload limiter – 20 uploads per 15 minutes
 */
const uploadLimiter = rateLimit({
  windowMs,
  max: 20,
  message: {
    success: false,
    error: 'upload_limit_exceeded',
    message: 'Límite de subida de archivos alcanzado. Intenta más tarde.',
  },
});

/**
 * Password reset limiter – 3 requests per hour
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req) => req.body?.email || req.ip,
  message: {
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Demasiadas solicitudes de restablecimiento. Espera 1 hora.',
  },
});

/**
 * Report export limiter – 10 exports per hour
 */
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Límite de exportaciones alcanzado. Espera una hora.',
  },
});

module.exports = {
  generalLimiter,
  loginLimiter,
  uploadLimiter,
  passwordResetLimiter,
  exportLimiter,
};
