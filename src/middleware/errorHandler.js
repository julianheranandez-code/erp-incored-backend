'use strict';

const logger = require('../utils/logger');

/**
 * Central error handler middleware (must be registered LAST in Express)
 */
const errorHandler = (err, req, res, next) => {
  // Log error
  logger.error({
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    user: req.user?.id,
  });

  // Sentry capture
  if (process.env.SENTRY_DSN) {
    try {
      const Sentry = require('@sentry/node');
      Sentry.withScope((scope) => {
        if (req.user) {
          scope.setUser({ id: req.user.id, email: req.user.email });
        }
        scope.setExtra('url', req.originalUrl);
        scope.setExtra('method', req.method);
        Sentry.captureException(err);
      });
    } catch (_) {}
  }

  // PostgreSQL constraint violations
  if (err.code) {
    switch (err.code) {
      case '23505': // unique_violation
        return res.status(409).json({
          success: false,
          error: 'conflict',
          message: 'Ya existe un registro con esos datos.',
          detail: process.env.NODE_ENV !== 'production' ? err.detail : undefined,
        });
      case '23503': // foreign_key_violation
        return res.status(409).json({
          success: false,
          error: 'conflict',
          message: 'El recurso relacionado no existe.',
          detail: process.env.NODE_ENV !== 'production' ? err.detail : undefined,
        });
      case '23502': // not_null_violation
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: 'Un campo requerido está vacío.',
        });
      case '22P02': // invalid_text_representation
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: 'Formato de datos inválido.',
        });
    }
  }

  // Custom app errors
  const statusCode = err.statusCode || err.status || 500;
  const isProd = process.env.NODE_ENV === 'production';

  res.status(statusCode).json({
    success: false,
    error: err.error || (statusCode >= 500 ? 'internal_error' : 'error'),
    message: isProd && statusCode >= 500
      ? 'Error interno del servidor. Por favor intenta más tarde.'
      : err.message || 'Error desconocido.',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
};

/**
 * 404 Not Found handler (register BEFORE errorHandler)
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: 'not_found',
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
};

/**
 * Create a custom AppError
 */
class AppError extends Error {
  constructor(message, statusCode = 500, errorCode = 'error') {
    super(message);
    this.statusCode = statusCode;
    this.error = errorCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { errorHandler, notFoundHandler, AppError };
