'use strict';
/**
 * Security Middleware — Sprint P4.3B RC1
 * Applied on top of existing helmet/cors/rateLimit.
 * Fixes identified issues without breaking existing functionality.
 */
const rateLimit = require('express-rate-limit');

// ─── AUTH RATE LIMITER (stricter) ────────────────────────────
// Max 10 login attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many login attempts. Try again in 15 minutes.' }
  },
  skip: (req) => process.env.NODE_ENV === 'test'
});

// ─── UPLOAD RATE LIMITER ─────────────────────────────────────
// Max 20 file uploads per minute per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'UPLOAD_RATE_LIMIT', message: 'Too many upload requests. Try again in a minute.' }
  }
});

// ─── SECURITY HEADERS MIDDLEWARE ─────────────────────────────
function securityHeaders(req, res, next) {
  // Remove server fingerprint
  res.removeHeader('X-Powered-By');
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions policy
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

// ─── REQUEST SANITIZER ───────────────────────────────────────
// Removes null bytes and overly long strings (basic protection)
function sanitizeRequest(req, res, next) {
  const sanitize = (obj, depth = 0) => {
    if (depth > 5 || !obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        // Remove null bytes
        obj[key] = obj[key].replace(/\0/g, '');
        // Truncate extremely long strings (>10KB per field)
        if (obj[key].length > 10240) obj[key] = obj[key].slice(0, 10240);
      } else if (typeof obj[key] === 'object') {
        sanitize(obj[key], depth + 1);
      }
    }
  };
  sanitize(req.body);
  sanitize(req.query);
  next();
}

// ─── CORS ALLOWED ORIGINS ────────────────────────────────────
// Centralized — used in app.js cors() config
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'https://erp.incored.com.mx',
  'https://incored.com.mx',
  'https://incored-julian-erp.lovable.app',
  process.env.NODE_ENV !== 'production' && 'http://localhost:3000',
  process.env.NODE_ENV !== 'production' && 'http://localhost:5173',
].filter(Boolean);

function corsOriginValidator(origin, callback) {
  // Allow requests with no origin (mobile apps, Postman, server-to-server)
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
  callback(new Error(`CORS: Origin ${origin} not allowed`));
}

module.exports = {
  authLimiter,
  uploadLimiter,
  securityHeaders,
  sanitizeRequest,
  corsOriginValidator,
  ALLOWED_ORIGINS,
};
