'use strict';

const { query } = require('../config/database');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// FINANCE REFRESH ENGINE v2.0
// Centralized service to keep all financial views in sync
// Supports: AR, AP, Expenses, POs (current + future modules)
//
// TODO (Phase 2 — Distributed Scale):
// - Replace in-memory Set with Redis distributed lock
//   (ioredis SETNX with TTL to prevent multi-instance collisions)
// - Replace setImmediate with BullMQ worker queue
//   for reliable background processing across instances
// - Add Redis KPI cache (TTL 60s) to serve dashboard
//   without hitting DB on every request
// ─────────────────────────────────────────────────────────────

// In-memory debounce registry (single instance)
// TODO: Replace with Redis SET for multi-instance support
const refreshInProgress = new Set();
const pendingRefresh    = new Set();

// ─────────────────────────────────────────────────────────────
// CORE REFRESH
// ─────────────────────────────────────────────────────────────

/**
 * Execute the materialized view refresh
 * Logs duration and project count for observability
 *
 * @param {number|null} projectId - Future: incremental refresh per project
 */
const executeRefresh = async (projectId = null) => {
  const startTime = Date.now();

  try {
    // Current: full refresh (CONCURRENTLY = reads still work during refresh)
    // TODO: When PostgreSQL supports partial mat view refresh,
    // pass project_id to refresh_project_financials(project_id)
    // for incremental refresh instead of full table scan
    await query('SELECT refresh_project_financials()');

    // Log refresh metrics
    const duration = Date.now() - startTime;
    const countResult = await query('SELECT COUNT(*) AS project_count FROM project_financials');
    const projectCount = countResult.rows[0]?.project_count || 0;

    logger.info(`[FinanceRefresh] ✅ Refreshed in ${duration}ms | projects=${projectCount} | triggered_by=project_${projectId || 'all'}`);

    return { success: true, duration, projectCount };
  } catch (err) {
    const duration = Date.now() - startTime;
    logger.error(`[FinanceRefresh] ❌ Failed after ${duration}ms | error=${err.message}`);
    return { success: false, duration, error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// QUEUE REFRESH (non-blocking background)
// ─────────────────────────────────────────────────────────────

/**
 * Queue a background refresh — never blocks user transactions
 * Uses in-memory debounce to prevent concurrent collisions
 *
 * @param {number|null} projectId
 * @param {string} reason - For audit trail
 */
const queueRefresh = async (projectId = null, reason = 'manual') => {
  const key = projectId ? `project_${projectId}` : 'global';
  const queuedAt = Date.now();

  // If already running → mark pending and return immediately
  if (refreshInProgress.has(key)) {
    pendingRefresh.add(key);
    logger.info(`[FinanceRefresh] ⏳ Queued (collision avoided): key=${key} reason=${reason}`);
    return;
  }

  refreshInProgress.add(key);

  try {
    // Record in DB queue for audit/recovery
    await query(
      `INSERT INTO finance_refresh_queue (project_id, reason)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [projectId || null, reason]
    );

    const queueLatency = Date.now() - queuedAt;
    logger.info(`[FinanceRefresh] 📥 Queued: key=${key} reason=${reason} latency=${queueLatency}ms`);

    // TODO: Replace setImmediate with BullMQ job dispatch:
    // await financeRefreshQueue.add('refresh', { projectId, reason }, { delay: 0 })
    setImmediate(async () => {
      try {
        await executeRefresh(projectId);

        // Clear DB queue after success
        await query(
          `DELETE FROM finance_refresh_queue
           WHERE ($1::integer IS NULL AND project_id IS NULL)
              OR project_id = $1`,
          [projectId || null]
        );
      } catch (err) {
        // NEVER let refresh failure affect user operations
        logger.error(`[FinanceRefresh] Background refresh error: ${err.message}`);
      } finally {
        refreshInProgress.delete(key);

        // Process any pending refresh queued during this run
        if (pendingRefresh.has(key)) {
          pendingRefresh.delete(key);
          logger.info(`[FinanceRefresh] 🔄 Processing pending refresh: key=${key}`);
          queueRefresh(projectId, 'pending_retry');
        }
      }
    });
  } catch (err) {
    // NEVER let queue failure affect user operations
    refreshInProgress.delete(key);
    logger.error(`[FinanceRefresh] Queue insert error: ${err.message}`);
  }
};

// ─────────────────────────────────────────────────────────────
// REFRESH NOW (synchronous — use when fresh data needed immediately)
// ─────────────────────────────────────────────────────────────

/**
 * Synchronous refresh — blocks until complete
 * Use when you need to return fresh KPIs in the same response
 *
 * @param {number|null} projectId
 */
const refreshNow = async (projectId = null) => {
  const result = await executeRefresh(projectId);

  if (result.success) {
    await query(
      `DELETE FROM finance_refresh_queue
       WHERE ($1::integer IS NULL AND project_id IS NULL)
          OR project_id = $1`,
      [projectId || null]
    );
  }

  return result.success;
};

// ─────────────────────────────────────────────────────────────
// KPI GETTERS
// ─────────────────────────────────────────────────────────────

/**
 * Get KPIs for a specific project
 * TODO: Add Redis cache with 60s TTL before DB query
 */
const getProjectKPIs = async (projectId) => {
  try {
    // TODO: Check Redis cache first:
    // const cached = await redis.get(`kpi:project:${projectId}`)
    // if (cached) return JSON.parse(cached)

    const result = await query(
      'SELECT * FROM project_financials WHERE project_id = $1',
      [parseInt(projectId)]
    );

    const kpis = result.rows[0] || null;

    // TODO: Cache result in Redis:
    // await redis.setex(`kpi:project:${projectId}`, 60, JSON.stringify(kpis))

    return kpis;
  } catch (err) {
    logger.error(`[FinanceRefresh] getProjectKPIs error: ${err.message}`);
    return null;
  }
};

/**
 * Get CFO Dashboard KPIs
 * TODO: Add Redis cache with 60s TTL
 *
 * @param {number|null} companyId - null = all companies (admin)
 */
const getDashboardKPIs = async (companyId = null) => {
  try {
    // TODO: Check Redis cache:
    // const cacheKey = `kpi:dashboard:${companyId || 'all'}`
    // const cached = await redis.get(cacheKey)
    // if (cached) return JSON.parse(cached)

    // Parameterized company filter — NO string interpolation
    const companyCondition     = companyId ? 'WHERE owner_company_id = $1' : '';
    const companyConditionCR   = companyId ? 'WHERE company_id = $1' : '';
    const companyParams        = companyId ? [parseInt(companyId)] : [];

    const [kpis, alerts, poAlerts] = await Promise.all([
      query(`
        SELECT
          COUNT(*)                             AS total_projects,
          COALESCE(SUM(total_invoiced), 0)     AS total_revenue,
          COALESCE(SUM(total_billed), 0)       AS total_costs,
          COALESCE(SUM(total_expenses), 0)     AS total_expenses,
          COALESCE(SUM(gross_profit), 0)       AS total_profit,
          COALESCE(SUM(outstanding_ar), 0)     AS total_outstanding_ar,
          COALESCE(SUM(outstanding_ap), 0)     AS total_outstanding_ap,
          ROUND(AVG(profit_margin_pct), 2)     AS avg_margin_pct
        FROM project_financials ${companyCondition}
      `, companyParams),

      query(`
        SELECT
          project_id, project_name, owner_company_name,
          profit_margin_pct, gross_profit, outstanding_ar,
          budget_remaining,
          CASE
            WHEN profit_margin_pct < 0  THEN 'negative_profit'
            WHEN profit_margin_pct < 15 THEN 'low_margin'
            WHEN budget_remaining < 0   THEN 'over_budget'
            ELSE 'ok'
          END AS alert_type
        FROM project_financials
        ${companyCondition}
        ${companyCondition ? 'AND' : 'WHERE'} (profit_margin_pct < 15 OR budget_remaining < 0)
        ORDER BY profit_margin_pct ASC NULLS LAST
        LIMIT 10
      `, companyParams),

      query(`
        SELECT
          po_id, po_number, project_name, company_name,
          po_total, invoiced_amount, remaining_amount,
          invoiced_pct, utilization_alert
        FROM project_po_summary
        ${companyConditionCR}
        ${companyConditionCR ? 'AND' : 'WHERE'} utilization_alert IN ('critical','warning')
        ORDER BY invoiced_pct DESC
        LIMIT 10
      `, companyParams)
    ]);

    const result = {
      kpis:      kpis.rows[0],
      alerts:    alerts.rows,
      po_alerts: poAlerts.rows
    };

    // TODO: Cache in Redis:
    // await redis.setex(cacheKey, 60, JSON.stringify(result))

    return result;
  } catch (err) {
    logger.error(`[FinanceRefresh] getDashboardKPIs error: ${err.message}`);
    return { kpis: {}, alerts: [], po_alerts: [] };
  }
};

// ─────────────────────────────────────────────────────────────
// AFTER MUTATION HELPER
// ─────────────────────────────────────────────────────────────

/**
 * Call after any financial mutation (AR, AP, Expenses, POs)
 * Queues background refresh + optionally returns fresh KPIs
 *
 * @param {object} options
 * @param {number} options.projectId
 * @param {number} options.companyId
 * @param {string} options.reason
 * @param {boolean} options.returnFreshKPIs - If true, refreshes sync and returns KPIs
 */
const afterMutation = async ({
  projectId,
  companyId = null,
  reason = 'mutation',
  returnFreshKPIs = false
}) => {
  if (returnFreshKPIs) {
    // Synchronous: refresh now and return fresh data
    await refreshNow(projectId);
    return getDashboardKPIs(companyId);
  }

  // Asynchronous: queue background refresh (non-blocking)
  queueRefresh(projectId, reason);
  return null;
};

// ─────────────────────────────────────────────────────────────
// QUEUE PROCESSOR (called by scheduler or API endpoint)
// ─────────────────────────────────────────────────────────────

/**
 * Process all pending DB refresh queue entries
 * Call from: POST /api/finance/refresh or cron every 15min
 */
const processQueue = async () => {
  const startTime = Date.now();
  try {
    const result = await query('SELECT * FROM process_finance_refresh_queue()');
    const { refreshed, queued_items } = result.rows[0] || {};
    const duration = Date.now() - startTime;

    if (refreshed) {
      logger.info(`[FinanceRefresh] 🔄 Queue processed: items=${queued_items} duration=${duration}ms`);
    }

    return {
      refreshed:   !!refreshed,
      queuedItems: queued_items || 0,
      duration
    };
  } catch (err) {
    logger.error(`[FinanceRefresh] processQueue error: ${err.message}`);
    return { refreshed: false, queuedItems: 0, duration: Date.now() - startTime };
  }
};

/**
 * Check if DB refresh queue has pending items
 */
const needsRefresh = async () => {
  try {
    const result = await query('SELECT needs_finance_refresh() AS needs');
    return result.rows[0]?.needs || false;
  } catch (err) {
    return false;
  }
};

module.exports = {
  queueRefresh,       // Background async refresh (non-blocking)
  refreshNow,         // Synchronous immediate refresh
  afterMutation,      // Post-mutation helper
  getProjectKPIs,     // KPIs for specific project
  getDashboardKPIs,   // CFO Dashboard KPIs
  processQueue,       // Process DB queue batch
  needsRefresh        // Check pending queue
};
