'use strict';

const { query } = require('../config/database');
const logger = require('../utils/logger');

// Map HTTP methods to audit action names
const METHOD_ACTION_MAP = {
  POST:   'create',
  PUT:    'update',
  PATCH:  'update',
  DELETE: 'delete',
  GET:    'read',
};

const getEntityType = (path) => {
  const segments = path.replace(/^\/api\//, '').split('/');
  return segments[0] || 'unknown';
};

const getEntityId = (req) => {
  const id = req.params?.id;
  return id ? parseInt(id) || null : null;
};

const sanitizeBody = (body) => {
  if (!body) return null;
  const sanitized = { ...body };
  delete sanitized.password;
  delete sanitized.password_hash;
  delete sanitized.newPassword;
  delete sanitized.currentPassword;
  delete sanitized.two_fa_secret;
  delete sanitized.refreshToken;
  return sanitized;
};

// ─── JSON DIFF HELPER ─────────────────────────────────────────
// Returns only changed fields between old and new
const diffObjects = (oldObj, newObj) => {
  if (!oldObj || !newObj) return { old: oldObj, new: newObj };
  const diff = { old: {}, new: {} };
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of allKeys) {
    if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
      diff.old[key] = oldObj[key];
      diff.new[key] = newObj[key];
    }
  }
  return Object.keys(diff.old).length > 0 ? diff : null;
};

// ─── CORE WRITE FUNCTION ──────────────────────────────────────
const writeAuditEntry = async ({
  userId, action, entityType, entityId,
  companyId, oldValues, newValues, changes,
  ip, userAgent, statusCode
}) => {
  try {
    await query(
      `INSERT INTO audit_logs (
        user_id, action, entity_type, entity_id,
        company_id, old_values, new_values, changes,
        ip_address, user_agent, status_code
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::inet,$10,$11)`,
      [
        userId,
        action,
        entityType,
        entityId || null,
        companyId || null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        changes   ? JSON.stringify(changes)   : null,
        ip || '0.0.0.0',
        userAgent || '',
        statusCode || null
      ]
    );
  } catch (err) {
    // NEVER block financial operations if audit fails
    logger.error('Audit log write failed:', err.message);
  }
};

// ─── MIDDLEWARE: Auto-log all mutating requests ───────────────
const auditLog = (req, res, next) => {
  if (!req.user) return next();

  const action     = METHOD_ACTION_MAP[req.method] || req.method.toLowerCase();
  const entityType = getEntityType(req.path);
  const entityId   = getEntityId(req);
  const originalBody = sanitizeBody(req.body);

  res.on('finish', async () => {
    const shouldLog = req.method !== 'GET' ||
      ['users','auth','transactions','employees','payroll'].includes(entityType);

    if (!shouldLog) return;
    if (res.statusCode >= 500) return;

    await writeAuditEntry({
      userId:     req.user.id,
      action,
      entityType,
      entityId,
      companyId:  req.user.company_id || null,
      changes:    originalBody,
      ip:         req.ip,
      userAgent:  req.get('user-agent'),
      statusCode: res.statusCode
    });
  });

  next();
};

// ─── MANUAL AUDIT: For specific operations with old/new values ─
const writeAudit = async ({
  userId, action, entityType, entityId,
  companyId, oldValues, newValues,
  ip, userAgent
}) => {
  const diff = diffObjects(oldValues, newValues);
  await writeAuditEntry({
    userId, action, entityType, entityId,
    companyId,
    oldValues: diff?.old || oldValues,
    newValues: diff?.new || newValues,
    ip, userAgent
  });
};

// ─── AR-SPECIFIC AUDIT HELPERS ────────────────────────────────

const auditInvoiceCreated = async (req, invoice) => {
  await writeAuditEntry({
    userId:     req.user.id,
    action:     'invoice_created',
    entityType: 'ar_invoices',
    entityId:   invoice.id,
    companyId:  invoice.company_id,
    newValues:  invoice,
    ip:         req.ip,
    userAgent:  req.get('user-agent')
  });
};

const auditInvoiceUpdated = async (req, oldInvoice, newInvoice) => {
  const diff = diffObjects(oldInvoice, newInvoice);
  if (!diff) return; // No changes
  await writeAuditEntry({
    userId:     req.user.id,
    action:     'invoice_updated',
    entityType: 'ar_invoices',
    entityId:   newInvoice.id,
    companyId:  newInvoice.company_id,
    oldValues:  diff.old,
    newValues:  diff.new,
    ip:         req.ip,
    userAgent:  req.get('user-agent')
  });
};

const auditStatusChange = async (req, invoice, oldStatus, newStatus) => {
  await writeAuditEntry({
    userId:     req.user.id,
    action:     `status_${newStatus}`,
    entityType: 'ar_invoices',
    entityId:   invoice.id,
    companyId:  invoice.company_id,
    oldValues:  { status: oldStatus },
    newValues:  { status: newStatus },
    ip:         req.ip,
    userAgent:  req.get('user-agent')
  });
};

const auditPaymentRegistered = async (req, invoice, payment) => {
  await writeAuditEntry({
    userId:     req.user.id,
    action:     'payment_registered',
    entityType: 'ar_invoices',
    entityId:   invoice.id,
    companyId:  invoice.company_id,
    newValues:  {
      payment_id:     payment.id,
      amount:         payment.amount,
      payment_date:   payment.payment_date,
      payment_method: payment.payment_method,
      reference:      payment.reference,
      invoice_status: invoice.status,
      total_paid:     invoice.total_paid,
      outstanding:    invoice.outstanding_balance
    },
    ip:         req.ip,
    userAgent:  req.get('user-agent')
  });
};

const auditOverdueTransition = async (req, invoices) => {
  for (const inv of invoices) {
    await writeAuditEntry({
      userId:     req.user.id,
      action:     'status_overdue',
      entityType: 'ar_invoices',
      entityId:   inv.id,
      companyId:  inv.company_id,
      oldValues:  { status: 'issued' },
      newValues:  { status: 'overdue', due_date: inv.due_date },
      ip:         req.ip,
      userAgent:  req.get('user-agent')
    });
  }
};

module.exports = {
  auditLog,
  writeAudit,
  // AR-specific helpers
  auditInvoiceCreated,
  auditInvoiceUpdated,
  auditStatusChange,
  auditPaymentRegistered,
  auditOverdueTransition
};
