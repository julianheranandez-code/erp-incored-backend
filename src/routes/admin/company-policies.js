'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

function assertAdmin(req, res) {
  if (!['super_admin','admin'].includes(req.user.role)) {
    res.status(403).json({ success: false, error: 'forbidden' });
    return false;
  }
  return true;
}

// GET /api/admin/company-policies?company_id=X&domain=payroll
router.get('/', async (req, res, next) => {
  try {
    const { company_id, domain } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (domain) { conditions.push(`policy_domain = $${idx++}`); values.push(domain); }
    const result = await query(`
      SELECT policy_domain, policy_key, policy_value, value_type,
        description, is_overridable, effective_from, effective_to, updated_at
      FROM company_policies WHERE ${conditions.join(' AND ')}
      ORDER BY policy_domain, policy_key
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// PUT /api/admin/company-policies/:company_id/:policy_key
router.put('/:company_id/:policy_key', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { policy_value, effective_from, effective_to } = req.body;
    if (!policy_value)
      return res.status(400).json({ success: false, error: 'validation_error', message: 'policy_value required' });
    const result = await query(`
      UPDATE company_policies SET
        policy_value = $1,
        effective_from = COALESCE($2, effective_from),
        effective_to = COALESCE($3, effective_to),
        updated_at = NOW()
      WHERE company_id=$4 AND policy_key=$5
      RETURNING policy_domain, policy_key, policy_value, updated_at
    `, [policy_value, effective_from||null, effective_to||null,
        parseInt(req.params.company_id), req.params.policy_key]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'policy_not_found' });
    writeAudit({ userId: req.user.id, action: 'company_policy_updated',
      entityType: 'company_policies', entityId: req.params.policy_key,
      companyId: parseInt(req.params.company_id),
      newValues: { policy_key: req.params.policy_key, policy_value },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/admin/company-policies/bulk
router.post('/bulk', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { company_id, policies } = req.body;
    if (!company_id || !policies?.length)
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, policies[]' });
    let inserted = 0;
    for (const p of policies) {
      await query(`
        INSERT INTO company_policies
          (company_id, policy_domain, policy_key, policy_value, value_type, description, is_overridable, effective_from, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (company_id, policy_domain, policy_key) DO UPDATE SET
          policy_value = EXCLUDED.policy_value, updated_at = NOW()
      `, [parseInt(company_id), p.domain, p.key, String(p.value),
          p.value_type||'string', p.description||null,
          p.is_overridable??true, p.effective_from||null, req.user.id]);
      inserted++;
    }
    writeAudit({ userId: req.user.id, action: 'company_policies_bulk_upsert',
      entityType: 'company_policies', entityId: String(company_id),
      companyId: parseInt(company_id), newValues: { count: inserted },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, message: `${inserted} policies upserted.` });
  } catch(e) { next(e); }
});

module.exports = router;
