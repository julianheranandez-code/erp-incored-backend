'use strict';

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const { LOG_LEVEL, LOG_FILE, NODE_ENV } = process.env;

// Ensure logs directory exists
const logDir = path.dirname(LOG_FILE || 'logs/app.log');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

const transports = [];

// Console transport (always)
transports.push(
  new winston.transports.Console({
    format: consoleFormat,
    level: NODE_ENV === 'production' ? 'info' : 'debug',
  })
);

// File transports (production / non-test)
if (NODE_ENV !== 'test') {
  transports.push(
    new winston.transports.File({
      filename: LOG_FILE || 'logs/app.log',
      level: LOG_LEVEL || 'info',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    })
  );

  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    })
  );
}

const logger = winston.createLogger({
  level: LOG_LEVEL || 'info',
  format: logFormat,
  transports,
  exitOnError: false,
});

// Morgan stream integration
logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;
