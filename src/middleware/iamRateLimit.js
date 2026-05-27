'use strict';

/**
 * IAM Mutation Rate Limiter
 * ─────────────────────────
 * Protects sensitive IAM operations from abuse.
 * Current model: in-memory, per-IP, single-node.
 *
 * FUTURE MIGRATION PATH:
 *   When multi-node/cluster deployment is needed:
 *   1. Replace with Redis-backed rate limiter (rate-limit-redis)
 *   2. Add anomaly detection (unusual mutation velocity per user)
 *   3. Governance alerting (Slack/email on suspicious IAM activity)
 *   4. Per-actor rate limiting (by user_id, not just IP)
 *   5. Suspicious activity monitoring (>N role changes in window)
 *
 * APPLIES TO:
 *   POST   /api/iam/users/:id/reset-password
 *   PATCH  /api/iam/users/:id/deactivate
 *   PATCH  /api/iam/users/:id/reactivate
 *   POST   /api/iam/users/:id/roles
 *   DELETE /api/iam/users/:id/roles/:roleId
 *   POST   /api/iam/approval-authority
 *   POST   /api/iam/users/:id/company-access
 *   DELETE /api/iam/users/:id/company-access/:companyId
 */

const rateLimit = require('express-rate-limit');

const iamSensitiveLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by IP + user_id for more precise governance
    return `${req.ip}:${req.user?.id || 'anon'}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'rate_limit_exceeded',
      message: 'Too many IAM mutation requests. Please try again in a few minutes.'
    });
  },
  skip: (req) => {
    // super_admin is never rate limited
    const roles = req.user?.roles?.length ? req.user.roles : req.user?.role ? [req.user.role] : [];
    return roles.includes('super_admin');
  }
});

module.exports = { iamSensitiveLimiter };
