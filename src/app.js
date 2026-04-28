'use strict';

// Load env first
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');

const logger = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { generalLimiter } = require('./middleware/rateLimit');

// Routes
const authRoutes        = require('./routes/auth');
const usersRoutes       = require('./routes/users');
const projectsRoutes    = require('./routes/projects');
const tasksRoutes       = require('./routes/tasks');
const crmRoutes         = require('./routes/crm');
const transactionsRoutes = require('./routes/transactions');
const inventoryRoutes   = require('./routes/inventory');
const employeesRoutes   = require('./routes/employees');
const reportsRoutes     = require('./routes/reports');
const filesRoutes       = require('./routes/files');

const app = express();

// ─── Sentry (error monitoring) ────────────────────────────────────────────────
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'production',
      tracesSampleRate: 0.2,
    });
    app.use(Sentry.Handlers.requestHandler());
    logger.info('Sentry initialized');
  } catch (e) {
    logger.warn('Sentry initialization failed:', e.message);
  }
}

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://erp.incored.com.mx',
  'https://incored.com.mx',
  'http://localhost:3000',   // dev
  'http://localhost:5173',   // Vite dev
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn(`CORS blocked origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Limit'],
  credentials: true,
  maxAge: 86400,
}));

// ─── Compression ──────────────────────────────────────────────────────────────
app.use(compression());

// ─── Body Parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Logging ─────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: logger.stream }));
}

// ─── Request ID ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || require('crypto').randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────
app.use('/api/', generalLimiter);

// ─── Health Checks ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: require('../package.json').version,
  });
});

app.get('/health/db', async (req, res) => {
  try {
    const { testConnection } = require('./config/database');
    const ok = await testConnection();
    if (ok) {
      res.json({ status: 'ok', database: 'connected' });
    } else {
      res.status(503).json({ status: 'error', database: 'disconnected' });
    }
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/users',        usersRoutes);
app.use('/api/projects',     projectsRoutes);
app.use('/api/tasks',        tasksRoutes);
app.use('/api',              crmRoutes);          // /api/clients, /api/quotes, /api/leads, /api/suppliers
app.use('/api/transactions', transactionsRoutes);
app.use('/api/inventory',    inventoryRoutes);
app.use('/api/employees',    employeesRoutes);
app.use('/api',              reportsRoutes);       // /api/reports/*, /api/dashboards/*
app.use('/api/files',        filesRoutes);

// ─── 404 & Error Handlers ─────────────────────────────────────────────────────
app.use(notFoundHandler);

if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    app.use(Sentry.Handlers.errorHandler());
  } catch (_) {}
}

app.use(errorHandler);

module.exports = app;
