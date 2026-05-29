'use strict';

/**
 * Treasury V2 Routes — Sprint 1A (Hardened)
 * ==========================================
 * ERP V2 Governance Hardening:
 *
 * C1: Permission-driven access (treasury.view/manage) NOT hardcoded roles
 * C2: Balance fields are bootstrap-only — future source: bank_transactions
 * C3: expected_repayment_date for intercompany loan tracking
 * C4: bank_code standardization (BOA, BANORTE, BBVA, etc.)
 * C5: Company isolation — validate company_id against user_company_access
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getEffectivePermissions } = require('../lib/iam/effective-permissions');
const logger = require('../utils/logger');

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
 * C1: Permission-driven treasury access check
 * Uses effective permissions engine — NOT hardcoded role list
 */
async function assertTreasuryPermission(req, res, permission = 'treasury.view') {
  const roles = getEffectiveRoles(req.user);

  // super_admin always has access
  if (roles.includes('super_admin')) return true;

  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const effective = await getEffectivePermissions(req.user.id, companyId);

    // Check exact permission or wildcard (treasury.*)
    const perms = effective.effective_permissions || [];
    const hasAccess = perms.includes('*') ||
                      perms.includes(permission) ||
                      perms.includes('treasury.*') ||
                      perms.some(p => p.endsWith('.*') && permission.startsWith(p.slice(0,-2)));

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
 * C5: Validate company_id against user's authorized company scope
 * Prevents cross-company treasury record creation
 */
async function assertCompanyAccess(req, res, companyId) {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;

  const userCompanyId = parseInt(req.user.active_company_id || req.user.company_id);

  if (userCompanyId === parseInt(companyId)) return true;

  // Check user_company_access table
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
}

// ─── BANK ACCOUNTS ───────────────────────────────────────────

router.get('/accounts', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = ["a.status != 'closed'"];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`a.company_id = $${idx++}`); values.push(companyId); }
    if (req.query.currency) { conditions.push(`a.currency = $${idx++}`); values.push(req.query.currency); }
    if (req.query.status) { conditions[0] = `a.status = $${idx++}`; values.push(req.query.status); }

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

router.post('/accounts', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const {
      company_id, bank_name, bank_code, account_name, account_type,
      currency, country, account_number_masked, is_primary = false,
      opening_balance = 0
    } = req.body;

    if (!company_id || !bank_name || !account_name || !account_type || !currency || !country) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, bank_name, account_name, account_type, currency, country' });
    }

    // C5: Company isolation
    if (!await assertCompanyAccess(req, res, company_id)) return;

    const VALID_TYPES = ['checking','receivables','payables','savings'];
    const VALID_CURRENCIES = ['USD','MXN'];
    const VALID_COUNTRIES = ['USA','MEXICO'];

    if (!VALID_TYPES.includes(account_type))
      return res.status(400).json({ success: false, error: 'invalid_account_type' });
    if (!VALID_CURRENCIES.includes(currency))
      return res.status(400).json({ success: false, error: 'invalid_currency' });
    if (!VALID_COUNTRIES.includes(country))
      return res.status(400).json({ success: false, error: 'invalid_country' });

    /**
     * C2: Balance governance note
     * opening_balance, current_balance, available_balance are BOOTSTRAP fields only.
     * In Sprint 1B/1C these will be derived from:
     *   - bank_transactions (source of truth)
     *   - reconciliation engine
     * Never treat current_balance as a permanently editable field post-Sprint 1A.
     */
    const result = await withTransaction(async (client) => {
      if (is_primary) {
        await client.query(
          `UPDATE treasury_bank_accounts SET is_primary = FALSE WHERE company_id = $1 AND currency = $2`,
          [parseInt(company_id), currency]
        );
      }

      return await client.query(`
        INSERT INTO treasury_bank_accounts (
          company_id, bank_name, bank_code, account_name, account_type,
          currency, country, account_number_masked, is_primary,
          opening_balance, current_balance, available_balance, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,'active')
        RETURNING *
      `, [parseInt(company_id), bank_name, bank_code||null, account_name, account_type,
          currency, country, account_number_masked||null, is_primary,
          parseFloat(opening_balance)]);
    });

    writeAudit({
      userId: req.user.id, action: 'bank_account_created',
      entityType: 'treasury_bank_accounts', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { bank_name, bank_code, account_type, currency },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Bank account created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── BANK CARDS ───────────────────────────────────────────────

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
      SELECT c.*, a.bank_name, a.bank_code, a.account_name, a.currency,
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

router.post('/cards', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const { company_id, bank_account_id, employee_id, card_holder,
            card_type, last4, monthly_limit, transaction_limit } = req.body;

    if (!company_id || !card_holder || !card_type || !last4)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, card_holder, card_type, last4' });

    // C5: Company isolation
    if (!await assertCompanyAccess(req, res, company_id)) return;

    if (!['debit','credit'].includes(card_type))
      return res.status(400).json({ success: false, error: 'invalid_card_type' });

    const result = await query(`
      INSERT INTO treasury_cards (company_id, bank_account_id, employee_id, card_holder,
        card_type, last4, monthly_limit, transaction_limit, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING *
    `, [parseInt(company_id), bank_account_id||null, employee_id||null,
        card_holder, card_type, last4,
        monthly_limit ? parseFloat(monthly_limit) : null,
        transaction_limit ? parseFloat(transaction_limit) : null]);

    writeAudit({ userId: req.user.id, action: 'card_created',
      entityType: 'treasury_cards', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { card_holder, card_type, last4 },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(() => {});

    res.status(201).json({ success: true, message: 'Card created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── FX RATES ─────────────────────────────────────────────────

router.get('/fx-rates', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const { currency_from, currency_to, date } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (currency_from) { conditions.push(`currency_from = $${idx++}`); values.push(currency_from.toUpperCase()); }
    if (currency_to)   { conditions.push(`currency_to = $${idx++}`);   values.push(currency_to.toUpperCase()); }
    if (date)          { conditions.push(`effective_date = $${idx++}`); values.push(date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM treasury_fx_rates ${where} ORDER BY effective_date DESC LIMIT 100`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/fx-rates', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.admin')) return;
  try {
    const { currency_from, currency_to, rate, source = 'MANUAL',
            effective_date, is_manual_override = false } = req.body;

    if (!currency_from || !currency_to || !rate || !effective_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: currency_from, currency_to, rate, effective_date' });

    if (!['DOF','MANUAL'].includes(source))
      return res.status(400).json({ success: false, error: 'invalid_source' });

    // Append-only — never overwrite historical rates
    const result = await query(`
      INSERT INTO treasury_fx_rates (currency_from, currency_to, rate, source, effective_date, is_manual_override)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [currency_from.toUpperCase(), currency_to.toUpperCase(),
        parseFloat(rate), source, effective_date, is_manual_override]);

    res.status(201).json({ success: true, message: 'FX rate recorded.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── APPROVAL RULES ───────────────────────────────────────────

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

    const grouped = result.rows.reduce((acc, row) => {
      if (!acc[row.approval_type]) acc[row.approval_type] = [];
      acc[row.approval_type].push(row);
      return acc;
    }, {});

    res.json({ success: true, count: result.rows.length, data: result.rows, grouped });
  } catch (error) { next(error); }
});

// ─── INTERCOMPANY TRANSFERS ───────────────────────────────────

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
      SELECT t.*, sc.name AS source_company_name, tc.name AS target_company_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name,
        CONCAT(a.first_name,' ',a.last_name) AS approved_by_name
      FROM treasury_intercompany_transfers t
      JOIN companies sc ON sc.id = t.source_company_id
      JOIN companies tc ON tc.id = t.target_company_id
      LEFT JOIN users u ON u.id = t.created_by
      LEFT JOIN users a ON a.id = t.approved_by
      ${where}
      ORDER BY t.created_at DESC LIMIT 100
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/intercompany-transfers', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const {
      source_company_id, target_company_id, transfer_type,
      currency, amount, fx_rate_snapshot, description,
      expected_repayment_date  // C3: loan repayment tracking
    } = req.body;

    if (!source_company_id || !target_company_id || !transfer_type || !currency || !amount)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: source_company_id, target_company_id, transfer_type, currency, amount' });

    // C5: Company isolation
    if (!await assertCompanyAccess(req, res, source_company_id)) return;

    const VALID_TYPES = ['PROJECT_FUNDING','MATERIAL_FUNDING','EXPENSE_REIMBURSEMENT',
                         'INTERCOMPANY_LOAN','LOAN_PAYMENT','INTEREST_PAYMENT','ADMIN_SERVICE'];
    if (!VALID_TYPES.includes(transfer_type))
      return res.status(400).json({ success: false, error: 'invalid_transfer_type' });

    if (parseInt(source_company_id) === parseInt(target_company_id))
      return res.status(400).json({ success: false, error: 'same_company' });

    // C3: expected_repayment_date only valid for loan types
    const LOAN_TYPES = ['INTERCOMPANY_LOAN','LOAN_PAYMENT','INTEREST_PAYMENT'];
    if (expected_repayment_date && !LOAN_TYPES.includes(transfer_type))
      return res.status(400).json({ success: false, error: 'invalid_repayment_date',
        message: 'expected_repayment_date is only valid for loan transfer types.' });

    const result = await query(`
      INSERT INTO treasury_intercompany_transfers (
        source_company_id, target_company_id, transfer_type,
        currency, amount, fx_rate_snapshot, description,
        expected_repayment_date, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)
      RETURNING *
    `, [parseInt(source_company_id), parseInt(target_company_id),
        transfer_type, currency, parseFloat(amount),
        fx_rate_snapshot ? parseFloat(fx_rate_snapshot) : null,
        description || null,
        expected_repayment_date || null,
        req.user.id]);

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

// ─── APPROVE INTERCOMPANY TRANSFER ───────────────────────────
// R2: Separate creation from approval — treasury.approve required
router.post('/intercompany-transfers/:id/approve', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.approve')) return;
  try {
    const transferId = parseInt(req.params.id);

    // Fetch transfer
    const existing = await query(
      `SELECT * FROM treasury_intercompany_transfers WHERE id = $1`,
      [transferId]
    );

    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found',
        message: 'Transfer not found.' });

    const transfer = existing.rows[0];

    if (transfer.status !== 'draft' && transfer.status !== 'pending')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Cannot approve a transfer with status: ${transfer.status}` });

    // Prevent self-approval
    if (transfer.created_by === req.user.id)
      return res.status(403).json({ success: false, error: 'self_approval_denied',
        message: 'You cannot approve your own transfer.' });

    // C5: Company isolation
    if (!await assertCompanyAccess(req, res, transfer.source_company_id)) return;

    const result = await query(`
      UPDATE treasury_intercompany_transfers
      SET status = 'approved', approved_by = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [req.user.id, transferId]);

    writeAudit({
      userId: req.user.id, action: 'transfer_approved',
      entityType: 'treasury_intercompany_transfers', entityId: transferId,
      companyId: transfer.source_company_id,
      newValues: { status: 'approved', approved_by: req.user.id,
                   transfer_type: transfer.transfer_type, amount: transfer.amount },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[TREASURY] transfer approved: id=${transferId} by=${req.user.id}`);
    res.json({ success: true, message: 'Transfer approved.', data: result.rows[0] });
  } catch (error) { next(error); }
});

module.exports = router;
