'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getEffectivePermissions } = require('../lib/iam/effective-permissions');
const logger = require('../utils/logger');

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
router.use(verifyToken);

// ─── HELPERS ─────────────────────────────────────────────────
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

function getCompanyScope(user, queryCompanyId) {
  const roles = getEffectiveRoles(user);
  if (roles.includes('super_admin')) return queryCompanyId ? parseInt(queryCompanyId) : null;
  return parseInt(user.active_company_id || user.company_id);
}

/**
 * Permission-driven treasury access — uses effective permissions engine
 * Supports: treasury.view / treasury.create / treasury.update / treasury.approve / treasury.admin
 */
async function assertTreasuryPermission(req, res, permission = 'treasury.view') {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;

  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const effective = await getEffectivePermissions(req.user.id, companyId);
    const perms = effective.effective_permissions || [];

    const hasAccess = perms.includes('*') ||
                      perms.includes(permission) ||
                      perms.includes('treasury.*') ||
                      perms.some(p => p.endsWith('.*') &&
                        permission.startsWith(p.slice(0, -2) + '.'));

    if (!hasAccess) {
      res.status(403).json({ success: false, error: 'permission_denied',
        permission, message: `Access denied. Required: ${permission}` });
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`[TREASURY] permission check failed: ${err.message}`);
    res.status(403).json({ success: false, error: 'permission_check_failed' });
    return false;
  }
}

/**
 * Company isolation — validates company_id against user's authorized scope
 * Prevents cross-company record creation via payload manipulation
 */
async function assertCompanyAccess(req, res, companyId) {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;

  const userCompanyId = parseInt(req.user.active_company_id || req.user.company_id);
  if (userCompanyId === parseInt(companyId)) return true;

  try {
    const access = await query(
      `SELECT 1 FROM user_company_access WHERE user_id = $1 AND company_id = $2 AND is_active = TRUE`,
      [req.user.id, parseInt(companyId)]
    );

    if (!access.rows[0]) {
      res.status(403).json({ success: false, error: 'company_access_denied',
        message: 'You are not authorized to create treasury records for this company.' });
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`[TREASURY] company access check failed: ${err.message}`);
    res.status(403).json({ success: false, error: 'company_access_check_failed' });
    return false;
  }
}

// ─── BANK ACCOUNTS ───────────────────────────────────────────

// GET /api/treasury/accounts
router.get('/accounts', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    // Default: exclude closed accounts unless status explicitly provided
    if (req.query.status) {
      conditions.push(`a.status = $${idx++}`);
      values.push(req.query.status);
    } else {
      conditions.push(`a.status != $${idx++}`);
      values.push('closed');
    }

    if (companyId) { conditions.push(`a.company_id = $${idx++}`); values.push(companyId); }
    if (req.query.currency) { conditions.push(`a.currency = $${idx++}`); values.push(req.query.currency); }

    const result = await query(`
      SELECT a.*, c.name AS company_name
      FROM treasury_bank_accounts a
      JOIN companies c ON c.id = a.company_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.is_primary DESC, a.bank_name ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/treasury/accounts
router.post('/accounts', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const {
      company_id, bank_name, account_name, account_type,
      currency, country, account_number_masked, is_primary = false,
      opening_balance = 0, current_balance, available_balance
    } = req.body;

    if (!company_id || !bank_name || !account_name || !account_type || !currency || !country) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, bank_name, account_name, account_type, currency, country' });
    }

    const VALID_TYPES = ['checking','receivables','payables','savings'];
    const VALID_CURRENCIES = ['USD','MXN'];
    const VALID_COUNTRIES = ['USA','MEXICO'];

    if (!VALID_TYPES.includes(account_type))
      return res.status(400).json({ success: false, error: 'invalid_account_type',
        message: `account_type must be: ${VALID_TYPES.join(', ')}` });
    if (!VALID_CURRENCIES.includes(currency))
      return res.status(400).json({ success: false, error: 'invalid_currency' });
    if (!VALID_COUNTRIES.includes(country))
      return res.status(400).json({ success: false, error: 'invalid_country' });

    // Fix 1: Company isolation — prevent cross-company payload manipulation
    if (!await assertCompanyAccess(req, res, company_id)) return;

    const result = await withTransaction(async (client) => {
      // If is_primary, unset existing primary for this company+currency
      if (is_primary) {
        await client.query(
          `UPDATE treasury_bank_accounts SET is_primary = FALSE WHERE company_id = $1 AND currency = $2`,
          [parseInt(company_id), currency]
        );
      }

      return await client.query(`
        INSERT INTO treasury_bank_accounts (
          company_id, bank_name, account_name, account_type,
          currency, country, account_number_masked, is_primary,
          opening_balance, current_balance, available_balance, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')
        RETURNING *
      `, [parseInt(company_id), bank_name, account_name, account_type,
          currency, country, account_number_masked || null, is_primary,
          parseFloat(opening_balance), parseFloat(current_balance || opening_balance),
          parseFloat(available_balance || opening_balance)]);
    });

    writeAudit({
      userId: req.user.id, action: 'bank_account_created',
      entityType: 'treasury_bank_accounts', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { bank_name, account_name, account_type, currency, country },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Bank account created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── BANK CARDS ───────────────────────────────────────────────

// GET /api/treasury/cards
router.get('/cards', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`c.company_id = $${idx++}`); values.push(companyId); }
    if (req.query.status) { conditions.push(`c.status = $${idx++}`); values.push(req.query.status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT c.*, a.bank_name, a.account_name, a.currency,
        CONCAT(e.first_name,' ',e.last_name) AS employee_name
      FROM treasury_cards c
      LEFT JOIN treasury_bank_accounts a ON a.id = c.bank_account_id
      LEFT JOIN employees e ON e.id = c.employee_id
      ${where}
      ORDER BY c.card_holder ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/treasury/cards
router.post('/cards', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const {
      company_id, bank_account_id, employee_id, card_holder,
      card_type, last4, monthly_limit, transaction_limit
    } = req.body;

    if (!company_id || !card_holder || !card_type || !last4) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, card_holder, card_type, last4' });
    }

    const VALID_CARD_TYPES = ['debit','credit'];
    if (!VALID_CARD_TYPES.includes(card_type))
      return res.status(400).json({ success: false, error: 'invalid_card_type' });

    // Fix 1: Company isolation
    if (!await assertCompanyAccess(req, res, company_id)) return;

    const result = await query(`
      INSERT INTO treasury_cards (
        company_id, bank_account_id, employee_id, card_holder,
        card_type, last4, monthly_limit, transaction_limit, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
      RETURNING *
    `, [parseInt(company_id), bank_account_id||null, employee_id||null,
        card_holder, card_type, last4,
        monthly_limit ? parseFloat(monthly_limit) : null,
        transaction_limit ? parseFloat(transaction_limit) : null]);

    writeAudit({
      userId: req.user.id, action: 'card_created',
      entityType: 'treasury_cards', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { card_holder, card_type, last4 },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Card created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── FX RATES ─────────────────────────────────────────────────

// GET /api/treasury/fx-rates
router.get('/fx-rates', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const { currency_from, currency_to, date } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (currency_from) { conditions.push(`f.currency_from = $${idx++}`); values.push(currency_from.toUpperCase()); }
    if (currency_to)   { conditions.push(`f.currency_to = $${idx++}`);   values.push(currency_to.toUpperCase()); }
    if (date)          { conditions.push(`f.effective_date = $${idx++}`); values.push(date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT * FROM treasury_fx_rates ${where}
      ORDER BY effective_date DESC, created_at DESC
      LIMIT 100
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/treasury/fx-rates
router.post('/fx-rates', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.admin')) return;
  try {
    const { currency_from, currency_to, rate, source = 'MANUAL',
            effective_date, is_manual_override = false } = req.body;

    if (!currency_from || !currency_to || !rate || !effective_date) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: currency_from, currency_to, rate, effective_date' });
    }

    const VALID_SOURCES = ['DOF','MANUAL'];
    if (!VALID_SOURCES.includes(source))
      return res.status(400).json({ success: false, error: 'invalid_source' });

    // Never overwrite — always insert new record
    const result = await query(`
      INSERT INTO treasury_fx_rates (
        currency_from, currency_to, rate, source, effective_date, is_manual_override
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [currency_from.toUpperCase(), currency_to.toUpperCase(),
        parseFloat(rate), source, effective_date, is_manual_override]);

    res.status(201).json({ success: true, message: 'FX rate recorded.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── APPROVAL RULES ───────────────────────────────────────────

// GET /api/treasury/approval-rules
router.get('/approval-rules', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.admin')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = ['r.is_active = TRUE'];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`r.company_id = $${idx++}`); values.push(companyId); }
    if (req.query.approval_type) { conditions.push(`r.approval_type = $${idx++}`); values.push(req.query.approval_type); }

    const result = await query(`
      SELECT r.*, c.name AS company_name
      FROM treasury_approval_rules r
      JOIN companies c ON c.id = r.company_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.approval_type, r.approval_order ASC
    `, values);

    // Group by approval_type
    const grouped = result.rows.reduce((acc, row) => {
      if (!acc[row.approval_type]) acc[row.approval_type] = [];
      acc[row.approval_type].push(row);
      return acc;
    }, {});

    res.json({ success: true, count: result.rows.length, data: result.rows, grouped });
  } catch (error) { next(error); }
});

// ─── INTERCOMPANY TRANSFERS ───────────────────────────────────

// GET /api/treasury/intercompany-transfers
router.get('/intercompany-transfers', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) {
      conditions.push(`(t.source_company_id = $${idx} OR t.target_company_id = $${idx})`);
      values.push(companyId); idx++;
    }
    if (req.query.status) { conditions.push(`t.status = $${idx++}`); values.push(req.query.status); }
    if (req.query.transfer_type) { conditions.push(`t.transfer_type = $${idx++}`); values.push(req.query.transfer_type); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT t.*,
        sc.name AS source_company_name,
        tc.name AS target_company_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name,
        CONCAT(a.first_name,' ',a.last_name) AS approved_by_name
      FROM treasury_intercompany_transfers t
      JOIN companies sc ON sc.id = t.source_company_id
      JOIN companies tc ON tc.id = t.target_company_id
      LEFT JOIN users u ON u.id = t.created_by
      LEFT JOIN users a ON a.id = t.approved_by
      ${where}
      ORDER BY t.created_at DESC
      LIMIT 100
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/treasury/intercompany-transfers
router.post('/intercompany-transfers', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const {
      source_company_id, target_company_id, transfer_type,
      currency, amount, fx_rate_snapshot, description
    } = req.body;

    if (!source_company_id || !target_company_id || !transfer_type || !currency || !amount) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: source_company_id, target_company_id, transfer_type, currency, amount' });
    }

    const VALID_TYPES = ['PROJECT_FUNDING','MATERIAL_FUNDING','EXPENSE_REIMBURSEMENT',
                         'INTERCOMPANY_LOAN','LOAN_PAYMENT','INTEREST_PAYMENT','ADMIN_SERVICE'];
    if (!VALID_TYPES.includes(transfer_type))
      return res.status(400).json({ success: false, error: 'invalid_transfer_type',
        message: `transfer_type must be: ${VALID_TYPES.join(', ')}` });

    if (parseInt(source_company_id) === parseInt(target_company_id))
      return res.status(400).json({ success: false, error: 'same_company',
        message: 'Source and target companies must be different.' });

    // Fix 1: Company isolation — validate source company access
    if (!await assertCompanyAccess(req, res, source_company_id)) return;

    const result = await query(`
      INSERT INTO treasury_intercompany_transfers (
        source_company_id, target_company_id, transfer_type,
        currency, amount, fx_rate_snapshot, description,
        status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
      RETURNING *
    `, [parseInt(source_company_id), parseInt(target_company_id),
        transfer_type, currency, parseFloat(amount),
        fx_rate_snapshot ? parseFloat(fx_rate_snapshot) : null,
        description || null, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'intercompany_transfer_created',
      entityType: 'treasury_intercompany_transfers', entityId: result.rows[0].id,
      companyId: parseInt(source_company_id),
      newValues: { source_company_id, target_company_id, transfer_type, currency, amount },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Intercompany transfer created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── SPRINT 1B: TRANSACTIONS ─────────────────────────────────

// GET /api/treasury/transactions
router.get('/transactions', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`t.company_id = $${idx++}`); values.push(companyId); }
    if (req.query.bank_account_id) { conditions.push(`t.bank_account_id = $${idx++}`); values.push(req.query.bank_account_id); }
    if (req.query.status)    { conditions.push(`t.status = $${idx++}`);    values.push(req.query.status); }
    if (req.query.direction) { conditions.push(`t.direction = $${idx++}`); values.push(req.query.direction); }
    if (req.query.category_id) { conditions.push(`t.category_id = $${idx++}`); values.push(req.query.category_id); }
    if (req.query.project_id)  { conditions.push(`t.project_id = $${idx++}`);  values.push(req.query.project_id); }
    if (req.query.date_from)   { conditions.push(`t.transaction_date >= $${idx++}`); values.push(req.query.date_from); }
    if (req.query.date_to)     { conditions.push(`t.transaction_date <= $${idx++}`); values.push(req.query.date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    const [result, total] = await Promise.all([
      query(`
        SELECT t.*, a.bank_name, a.bank_code, a.currency, a.account_name,
          cat.name AS category_name,
          CONCAT(u.first_name,' ',u.last_name) AS created_by_name
        FROM treasury_bank_transactions t
        JOIN treasury_bank_accounts a ON a.id = t.bank_account_id
        LEFT JOIN treasury_transaction_categories cat ON cat.id = t.category_id
        LEFT JOIN users u ON u.id = t.created_by
        ${where}
        ORDER BY t.transaction_date DESC, t.created_at DESC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, limit, offset]),
      query(`SELECT COUNT(*) FROM treasury_bank_transactions t ${where}`, values)
    ]);

    res.json({
      success: true, count: result.rows.length,
      total: parseInt(total.rows[0].count),
      data: result.rows
    });
  } catch (error) { next(error); }
});

// POST /api/treasury/transactions
router.post('/transactions', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const {
      company_id, bank_account_id, transaction_date, bank_reference,
      bank_description, amount, direction, category_id, project_id,
      vendor_id, client_id, invoice_id, notes,
      import_source = 'MANUAL', status = 'pending'
    } = req.body;

    if (!company_id || !bank_account_id || !transaction_date || !bank_description || !amount || !direction)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, bank_account_id, transaction_date, bank_description, amount, direction' });

    if (!await assertCompanyAccess(req, res, company_id)) return;

    if (!['INFLOW','OUTFLOW'].includes(direction))
      return res.status(400).json({ success: false, error: 'invalid_direction' });

    if (!['pending','posted'].includes(status))
      return res.status(400).json({ success: false, error: 'invalid_status' });

    // Verify bank account belongs to company
    const accountCheck = await query(
      `SELECT id FROM treasury_bank_accounts WHERE id = $1 AND company_id = $2 AND status = 'active'`,
      [parseInt(bank_account_id), parseInt(company_id)]
    );
    if (!accountCheck.rows[0])
      return res.status(400).json({ success: false, error: 'invalid_bank_account',
        message: 'Bank account not found or does not belong to this company.' });

    const result = await query(`
      INSERT INTO treasury_bank_transactions (
        company_id, bank_account_id, transaction_date, bank_reference,
        bank_description, amount, direction, status, category_id,
        project_id, vendor_id, client_id, invoice_id, notes, import_source, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [parseInt(company_id), parseInt(bank_account_id), transaction_date,
        bank_reference||null, bank_description, parseFloat(amount), direction,
        status, category_id||null, project_id||null, vendor_id||null,
        client_id||null, invoice_id||null, notes||null, import_source, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'transaction_created',
      entityType: 'treasury_bank_transactions', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { bank_account_id, amount, direction, transaction_date, import_source },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Transaction created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── CATEGORIES ───────────────────────────────────────────────

// GET /api/treasury/categories
router.get('/categories', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const result = await query(
      `SELECT * FROM treasury_transaction_categories WHERE is_active = TRUE ORDER BY name ASC`
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── CASH POSITION ────────────────────────────────────────────

// GET /api/treasury/cash-position
router.get('/cash-position', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`company_id = $${idx++}`); values.push(companyId); }
    if (req.query.currency) { conditions.push(`currency = $${idx++}`); values.push(req.query.currency); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM treasury_cash_position_view ${where} ORDER BY country, currency, is_primary DESC`,
      values
    );

    // Group by currency for totals
    const totals = result.rows.reduce((acc, row) => {
      if (!acc[row.currency]) acc[row.currency] = { currency: row.currency, total_cash_position: 0, accounts: 0 };
      acc[row.currency].total_cash_position += parseFloat(row.current_cash_position || 0);
      acc[row.currency].accounts++;
      return acc;
    }, {});

    res.json({
      success: true, count: result.rows.length,
      data: result.rows,
      totals: Object.values(totals)
    });
  } catch (error) { next(error); }
});

// ─── ACTIVITY FEED ────────────────────────────────────────────

// GET /api/treasury/activity-feed
router.get('/activity-feed', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`company_id = $${idx++}`); values.push(companyId); }
    if (req.query.event_type) { conditions.push(`event_type = $${idx++}`); values.push(req.query.event_type); }
    if (req.query.date_from)  { conditions.push(`event_date >= $${idx++}`); values.push(req.query.date_from); }
    if (req.query.date_to)    { conditions.push(`event_date <= $${idx++}`); values.push(req.query.date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const result = await query(
      `SELECT * FROM treasury_activity_feed ${where} ORDER BY event_date DESC, created_at DESC LIMIT $${idx}`,
      [...values, limit]
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
