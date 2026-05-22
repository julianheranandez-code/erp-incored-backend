'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

router.use(verifyToken);

function getAuthorizedCompanyId(user, queryCompanyId) {
  if (user.role === 'admin') return queryCompanyId ? parseInt(queryCompanyId) : null;
  return parseInt(user.active_company_id || user.company_id || user.companyId);
}

// ─── CONFIDENCE SCORING ───────────────────────────────────────
function getArConfidence(invoice) {
  const daysPastDue = invoice.days_past_due || 0;
  if (daysPastDue > 90)  return { score: 'low',    weight: 0.3 };
  if (daysPastDue > 30)  return { score: 'medium', weight: 0.6 };
  if (daysPastDue > 0)   return { score: 'medium', weight: 0.75 };
  return { score: 'high', weight: 0.95 };
}

function getApConfidence(bill) {
  if (bill.scheduled_payment_date) return { score: 'high', weight: 1.0 };
  if (bill.status === 'approved')   return { score: 'high', weight: 0.95 };
  return { score: 'medium', weight: 0.8 };
}

function horizonDays(horizon) {
  const map = { '7d': 7, '30d': 30, '60d': 60, '90d': 90 };
  return map[horizon] || 30;
}

// ─── GET /api/treasury/cash-position ─────────────────────────
router.get('/cash-position', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`ba.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    conditions.push(`ba.is_active = $${idx++}`); values.push(true);

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [accounts, totals] = await Promise.all([
      query(`
        SELECT ba.id, ba.bank_name, ba.account_name, ba.account_type,
          ba.currency, ba.current_balance, ba.company_id
        FROM bank_accounts ba ${where}
        ORDER BY ba.current_balance DESC
      `, values),
      query(`
        SELECT
          ba.currency,
          COUNT(*) AS account_count,
          SUM(ba.current_balance) AS total_balance
        FROM bank_accounts ba ${where}
        GROUP BY ba.currency
        ORDER BY total_balance DESC
      `, values)
    ]);

    res.json({
      success: true,
      data: {
        accounts: accounts.rows,
        by_currency: totals.rows,
        total_accounts: accounts.rows.length
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/treasury/forecast ──────────────────────────────
router.get('/forecast', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const horizon = req.query.horizon || '30d';
    const days = horizonDays(horizon);
    const companyFilter = authorizedCompanyId ? `AND company_id = $1` : '';
    const params = authorizedCompanyId ? [authorizedCompanyId] : [];
    let idx = params.length + 1;

    // ── AR Inflows ─────────────────────────────────────────────
    const arInflows = await query(`
      SELECT
        id, folio, client_id, total_amount,
        COALESCE(total_paid, 0) AS paid_amount,
        total_amount - COALESCE(total_paid, 0) AS remaining,
        due_date, payment_terms, status,
        CURRENT_DATE - due_date AS days_past_due,
        retainage_amount
      FROM ar_invoices
      WHERE status NOT IN ('paid','cancelled','revised','replaced')
        AND (due_date IS NULL OR due_date <= CURRENT_DATE + $${idx}::integer)
        ${companyFilter}
      ORDER BY due_date ASC NULLS LAST
    `, [...params, days]);

    // ── AP Outflows ────────────────────────────────────────────
    const apOutflows = await query(`
      SELECT
        id, folio, vendor_id, total_amount,
        COALESCE(total_paid, 0) AS paid_amount,
        total_amount - COALESCE(total_paid, 0) AS remaining,
        due_date, scheduled_payment_date, status,
        retainage_amount
      FROM ap_bills
      WHERE status NOT IN ('paid','cancelled','revised','replaced')
        AND (
          due_date <= CURRENT_DATE + $${idx}::integer
          OR scheduled_payment_date <= CURRENT_DATE + $${idx}::integer
        )
        ${companyFilter}
      ORDER BY COALESCE(scheduled_payment_date, due_date) ASC NULLS LAST
    `, [...params, days]);

    // ── Retainage Inflows (AR) ─────────────────────────────────
    const retainageAr = await query(`
      SELECT id, folio, retainage_amount, retainage_due_date, retainage_status
      FROM ar_invoices
      WHERE retainage_amount > 0
        AND retainage_status = 'pending'
        AND retainage_due_date <= CURRENT_DATE + $${idx}::integer
        ${companyFilter}
    `, [...params, days]);

    // ── Retainage Outflows (AP) ────────────────────────────────
    const retainageAp = await query(`
      SELECT id, folio, retainage_amount, retainage_due_date, retainage_status
      FROM ap_bills
      WHERE retainage_amount > 0
        AND retainage_status = 'pending'
        AND retainage_due_date <= CURRENT_DATE + $${idx}::integer
        ${companyFilter}
    `, [...params, days]);

    // ── Bank balance ───────────────────────────────────────────
    const bankPos = await query(`
      SELECT COALESCE(SUM(current_balance), 0) AS total_cash
      FROM bank_accounts
      WHERE is_active = TRUE ${companyFilter}
    `, params);

    const currentCash = parseFloat(bankPos.rows[0].total_cash || 0);

    // ── Build forecast lines ───────────────────────────────────
    const inflows = [];
    let totalProjectedIn = 0;

    for (const inv of arInflows.rows) {
      const remaining = parseFloat(inv.remaining || 0);
      if (remaining <= 0) continue;
      const conf = getArConfidence(inv);
      const projected = remaining * conf.weight;
      totalProjectedIn += projected;
      inflows.push({
        type: 'ar_collection',
        reference_id: inv.id,
        folio: inv.folio,
        expected_date: inv.due_date,
        gross_amount: remaining,
        projected_amount: Math.round(projected * 100) / 100,
        confidence: conf.score,
        days_past_due: inv.days_past_due
      });
    }

    for (const ret of retainageAr.rows) {
      const amount = parseFloat(ret.retainage_amount || 0);
      if (amount <= 0) continue;
      totalProjectedIn += amount * 0.8; // Medium confidence for retainage
      inflows.push({
        type: 'retainage_release',
        reference_id: ret.id,
        folio: ret.folio,
        expected_date: ret.retainage_due_date,
        gross_amount: amount,
        projected_amount: Math.round(amount * 0.8 * 100) / 100,
        confidence: 'medium'
      });
    }

    const outflows = [];
    let totalProjectedOut = 0;

    for (const bill of apOutflows.rows) {
      const remaining = parseFloat(bill.remaining || 0);
      if (remaining <= 0) continue;
      const conf = getApConfidence(bill);
      const projected = remaining * conf.weight;
      totalProjectedOut += projected;
      outflows.push({
        type: 'ap_payment',
        reference_id: bill.id,
        folio: bill.folio,
        expected_date: bill.scheduled_payment_date || bill.due_date,
        gross_amount: remaining,
        projected_amount: Math.round(projected * 100) / 100,
        confidence: conf.score
      });
    }

    for (const ret of retainageAp.rows) {
      const amount = parseFloat(ret.retainage_amount || 0);
      if (amount <= 0) continue;
      totalProjectedOut += amount;
      outflows.push({
        type: 'retainage_payable',
        reference_id: ret.id,
        folio: ret.folio,
        expected_date: ret.retainage_due_date,
        gross_amount: amount,
        projected_amount: amount,
        confidence: 'high'
      });
    }

    const netCashflow = totalProjectedIn - totalProjectedOut;
    const projectedEndBalance = currentCash + netCashflow;

    logger.info(`[TREASURY] forecast horizon=${horizon} in=${totalProjectedIn.toFixed(2)} out=${totalProjectedOut.toFixed(2)} net=${netCashflow.toFixed(2)}`);

    res.json({
      success: true,
      data: {
        horizon,
        days,
        current_cash: currentCash,
        projected_inflows:     Math.round(totalProjectedIn * 100) / 100,
        projected_outflows:    Math.round(totalProjectedOut * 100) / 100,
        net_cashflow:          Math.round(netCashflow * 100) / 100,
        projected_end_balance: Math.round(projectedEndBalance * 100) / 100,
        inflows,
        outflows
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/treasury/forecast-summary ──────────────────────
router.get('/forecast-summary', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const params = authorizedCompanyId ? [authorizedCompanyId] : [];
    const cf = authorizedCompanyId ? `AND company_id = $1` : '';

    const [ar, ap, banks, retAr, retAp] = await Promise.all([
      query(`SELECT COALESCE(SUM(total_amount - COALESCE(total_paid,0)),0) AS total_outstanding
             FROM ar_invoices WHERE status NOT IN ('paid','cancelled') ${cf}`, params),
      query(`SELECT COALESCE(SUM(total_amount - COALESCE(total_paid,0)),0) AS total_outstanding
             FROM ap_bills WHERE status NOT IN ('paid','cancelled') ${cf}`, params),
      query(`SELECT COALESCE(SUM(current_balance),0) AS total_cash FROM bank_accounts WHERE is_active=TRUE ${cf}`, params),
      query(`SELECT COALESCE(SUM(retainage_amount),0) AS total FROM ar_invoices WHERE retainage_status='pending' ${cf}`, params),
      query(`SELECT COALESCE(SUM(retainage_amount),0) AS total FROM ap_bills WHERE retainage_status='pending' ${cf}`, params)
    ]);

    const totalCash = parseFloat(banks.rows[0].total_cash || 0);
    const arOutstanding = parseFloat(ar.rows[0].total_outstanding || 0);
    const apOutstanding = parseFloat(ap.rows[0].total_outstanding || 0);
    const retainageAr = parseFloat(retAr.rows[0].total || 0);
    const retainageAp = parseFloat(retAp.rows[0].total || 0);

    res.json({
      success: true,
      data: {
        current_cash:        totalCash,
        ar_outstanding:      arOutstanding,
        ap_outstanding:      apOutstanding,
        net_working_capital: totalCash + arOutstanding - apOutstanding,
        retainage_receivable: retainageAr,
        retainage_payable:   retainageAp,
        net_retainage:       retainageAr - retainageAp
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/treasury/forecast-events ───────────────────────
router.get('/forecast-events', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { event_type, status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (event_type) { conditions.push(`event_type = $${idx++}`); values.push(event_type); }
    if (status)     { conditions.push(`status = $${idx++}`); values.push(status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT * FROM treasury_forecast_events ${where}
      ORDER BY expected_date ASC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...values, parseInt(limit), offset]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── POST /api/treasury/forecast-events ──────────────────────
router.post('/forecast-events', async (req, res, next) => {
  try {
    const { company_id, event_type, reference_id, reference_type,
            expected_date, projected_amount, currency = 'USD',
            confidence_score = 'medium', notes } = req.body;

    if (!company_id || !event_type || !expected_date || !projected_amount) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, event_type, expected_date, projected_amount' });
    }

    const result = await query(`
      INSERT INTO treasury_forecast_events (
        company_id, event_type, reference_id, reference_type,
        expected_date, projected_amount, currency,
        confidence_score, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [parseInt(company_id), event_type,
        reference_id ? parseInt(reference_id) : null,
        reference_type || null,
        expected_date, parseFloat(projected_amount), currency,
        confidence_score, notes || null, req.user.id]);

    res.status(201).json({ success: true, message: 'Forecast event created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── GET /api/treasury/risk-alerts ───────────────────────────
router.get('/risk-alerts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const params = authorizedCompanyId ? [authorizedCompanyId] : [];
    const cf = authorizedCompanyId ? `AND company_id = $1` : '';

    // Current cash position
    const cashResult = await query(
      `SELECT COALESCE(SUM(current_balance),0) AS total FROM bank_accounts WHERE is_active=TRUE ${cf}`,
      params
    );
    const currentCash = parseFloat(cashResult.rows[0].total || 0);

    // AP due in next 30 days
    const apDue = await query(`
      SELECT COALESCE(SUM(total_amount - COALESCE(total_paid,0)),0) AS total
      FROM ap_bills
      WHERE status NOT IN ('paid','cancelled')
        AND due_date <= CURRENT_DATE + 30 ${cf}
    `, params);
    const apDue30 = parseFloat(apDue.rows[0].total || 0);

    // Overdue AR concentration
    const overdueAr = await query(`
      SELECT COALESCE(SUM(total_amount - COALESCE(total_paid,0)),0) AS total,
        COUNT(*) AS count
      FROM ar_invoices
      WHERE status NOT IN ('paid','cancelled')
        AND due_date < CURRENT_DATE ${cf}
    `, params);

    const alerts = [];

    // Critical: projected negative cash
    if (currentCash - apDue30 < 0) {
      alerts.push({
        type: 'projected_negative_cash',
        severity: 'critical',
        message: `Projected cash deficit of $${Math.abs(currentCash - apDue30).toFixed(2)} in next 30 days`,
        amount: Math.abs(currentCash - apDue30)
      });
    }

    // Warning: low cash runway
    if (currentCash > 0 && apDue30 > 0 && (currentCash / apDue30) < 1.5) {
      alerts.push({
        type: 'low_cash_runway',
        severity: 'warning',
        message: `Cash coverage ratio is ${(currentCash / apDue30).toFixed(2)}x for next 30 days AP`,
        ratio: parseFloat((currentCash / apDue30).toFixed(2))
      });
    }

    // Warning: overdue AR concentration
    const overdueTotal = parseFloat(overdueAr.rows[0].total || 0);
    if (overdueTotal > 0) {
      alerts.push({
        type: 'overdue_ar_exposure',
        severity: overdueTotal > 500000 ? 'critical' : 'warning',
        message: `$${overdueTotal.toFixed(2)} in overdue AR (${overdueAr.rows[0].count} invoices)`,
        amount: overdueTotal,
        count: parseInt(overdueAr.rows[0].count)
      });
    }

    // Info: AP payment pressure
    if (apDue30 > currentCash * 0.5) {
      alerts.push({
        type: 'vendor_payment_pressure',
        severity: 'info',
        message: `AP due in 30 days ($${apDue30.toFixed(2)}) exceeds 50% of cash position`,
        amount: apDue30
      });
    }

    logger.info(`[TREASURY] risk-alerts generated: ${alerts.length} alerts`);

    res.json({
      success: true,
      data: {
        alerts,
        current_cash: currentCash,
        ap_due_30d: apDue30,
        overdue_ar: overdueTotal
      }
    });
  } catch (error) { next(error); }
});

module.exports = router;
