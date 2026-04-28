'use strict';

require('dotenv').config();
require('express-async-errors');

const app = require('./app');
const { testConnection, pool } = require('./config/database');
const { verifyConnection: verifyEmail } = require('./config/email');
const { cleanExpiredTokens } = require('./config/auth');
const logger = require('./utils/logger');

const PORT = parseInt(process.env.PORT) || 5000;

// ─── Scheduled cleanup ────────────────────────────────────────────────────────
let cleanupInterval;

const startCleanupJob = () => {
  // Run token cleanup every 6 hours
  cleanupInterval = setInterval(async () => {
    try {
      await cleanExpiredTokens();
    } catch (err) {
      logger.error('Cleanup job error:', err.message);
    }
  }, 6 * 60 * 60 * 1000);

  logger.info('Token cleanup job started (every 6h)');
};

// ─── Startup ─────────────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    logger.info(`Starting IncorERP Backend v${require('../package.json').version}...`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

    // Test DB connection (required)
    const dbOk = await testConnection();
    if (!dbOk) {
      logger.error('Database connection failed — server will not start.');
      process.exit(1);
    }

    // Verify email (optional — warn but don't block)
    await verifyEmail().catch(() => {
      logger.warn('Email server not reachable — email features may not work.');
    });

    // Start HTTP server
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`✅ Server running on port ${PORT}`);
      logger.info(`   API:    http://localhost:${PORT}/api`);
      logger.info(`   Health: http://localhost:${PORT}/health`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully...`);

      clearInterval(cleanupInterval);

      server.close(async () => {
        logger.info('HTTP server closed.');
        await pool.end();
        logger.info('Database pool closed.');
        process.exit(0);
      });

      // Force exit after 15 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after 15s timeout');
        process.exit(1);
      }, 15000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // Unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught Exception:', err);
      process.exit(1);
    });

    startCleanupJob();

    return server;
  } catch (err) {
    logger.error('Startup error:', err);
    process.exit(1);
  }
};

startServer();
