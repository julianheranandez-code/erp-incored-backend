'use strict';
/**
 * Project Activities Routes — Sprint RC1
 * Physical work tracker (FTTH + Structured Cabling)
 * Separate from project_tasks (operational)
 */
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');
const { query } = require('../config/database');
const logger = require('../utils/logger');

router.use(verifyToken);

// GET /api/project-activities?project_id=X
router.get('/', async (req, res, next) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ success: false,
      error: { code: 'MISSING_PROJECT_ID', message: 'project_id required' } });

    const result = await query(`
      SELECT pa.*,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name,
        parent.name AS parent_name
      FROM project_activities pa
      LEFT JOIN users u ON u.id = pa.created_by
      LEFT JOIN project_activities parent ON parent.id = pa.parent_id
      WHERE pa.project_id = $1
      ORDER BY pa.sort_order ASC, pa.id ASC
    `, [parseInt(project_id)]);

    const all = result.rows;
    const parents = all.filter(a => !a.parent_id);
    const tree = parents.map(p => ({
      ...p,
      children: all.filter(c => c.parent_id === p.id)
    }));

    const totalWeight = parents.reduce((s, a) => s + parseFloat(a.weight_pct || 0), 0);
    const weightedProgress = parents.reduce((s, a) =>
      s + (parseFloat(a.weight_pct || 0) * parseFloat(a.progress_pct || 0) / 100), 0);
    const overallProgress = totalWeight > 0 ? Math.round(weightedProgress) : 0;

    return res.json({
      success: true,
      data: {
        activities: tree,
        flat: all,
        summary: {
          total_activities: all.length,
          overall_progress: overallProgress,
          total_weight: totalWeight,
          completed:   all.filter(a => a.status === 'completed').length,
          in_progress: all.filter(a => a.status === 'in_progress').length,
          not_started: all.filter(a => a.status === 'not_started').length,
        }
      },
      metadata: { generated_at: new Date().toISOString() }
    });
  } catch(e) { next(e); }
});

// POST /api/project-activities
router.post('/', async (req, res, next) => {
  try {
    const {
      project_id, parent_id, activity_code, name, weight_pct,
      quantity, unit, team_size, planned_start_date, planned_end_date,
      actual_start_date, actual_end_date, quantity_done, progress_pct,
      status, sort_order, notes
    } = req.body;

    if (!project_id || !name) return res.status(400).json({ success: false,
      error: { code: 'VALIDATION_ERROR', message: 'project_id and name required' } });

    const proj = await query('SELECT company_id FROM projects WHERE id=$1', [parseInt(project_id)]);
    const company_id = proj.rows[0]?.company_id;

    const qty = parseFloat(quantity || 0);
    const qtyDone = parseFloat(quantity_done || 0);
    const calcProgress = qty > 0 ? Math.round((qtyDone / qty) * 100) : parseFloat(progress_pct || 0);

    const result = await query(`
      INSERT INTO project_activities
        (project_id, company_id, parent_id, activity_code, name, weight_pct,
         quantity, unit, team_size, planned_start_date, planned_end_date,
         actual_start_date, actual_end_date, quantity_done, progress_pct,
         status, sort_order, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [parseInt(project_id), company_id, parent_id || null, activity_code || null,
       name, parseFloat(weight_pct || 0), qty, unit || null, parseInt(team_size || 1),
       planned_start_date || null, planned_end_date || null,
       actual_start_date || null, actual_end_date || null,
       qtyDone, calcProgress, status || 'not_started',
       parseInt(sort_order || 0), notes || null, req.user.id]
    );

    logger.info('[ProjectActivities] Created', { project_id, name });
    return res.status(201).json({ success: true, data: result.rows[0],
      metadata: { generated_at: new Date().toISOString() } });
  } catch(e) { next(e); }
});

// PUT /api/project-activities/:id
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM project_activities WHERE id=$1', [parseInt(req.params.id)]);
    if (!existing.rows[0]) return res.status(404).json({ success: false,
      error: { code: 'NOT_FOUND', message: 'Activity not found' } });

    const cur = existing.rows[0];
    const {
      name, activity_code, weight_pct, quantity, unit, team_size,
      planned_start_date, planned_end_date, actual_start_date, actual_end_date,
      quantity_done, progress_pct, status, sort_order, notes
    } = req.body;

    const qty     = parseFloat(quantity     ?? cur.quantity     ?? 0);
    const qtyDone = parseFloat(quantity_done ?? cur.quantity_done ?? 0);
    const calcProgress = qty > 0
      ? Math.round((qtyDone / qty) * 100)
      : parseFloat(progress_pct ?? cur.progress_pct ?? 0);

    let autoStatus = status ?? cur.status;
    if (calcProgress >= 100) autoStatus = 'completed';
    else if (calcProgress > 0) autoStatus = 'in_progress';

    const result = await query(`
      UPDATE project_activities SET
        name               = COALESCE($1,  name),
        activity_code      = COALESCE($2,  activity_code),
        weight_pct         = COALESCE($3,  weight_pct),
        quantity           = $4,
        unit               = COALESCE($5,  unit),
        team_size          = COALESCE($6,  team_size),
        planned_start_date = COALESCE($7,  planned_start_date),
        planned_end_date   = COALESCE($8,  planned_end_date),
        actual_start_date  = COALESCE($9,  actual_start_date),
        actual_end_date    = COALESCE($10, actual_end_date),
        quantity_done      = $11,
        progress_pct       = $12,
        status             = $13,
        sort_order         = COALESCE($14, sort_order),
        notes              = COALESCE($15, notes),
        updated_at         = NOW()
      WHERE id = $16 RETURNING *`,
      [name || null, activity_code || null,
       weight_pct != null ? parseFloat(weight_pct) : null,
       qty, unit || null,
       team_size ? parseInt(team_size) : null,
       planned_start_date || null, planned_end_date || null,
       actual_start_date  || null, actual_end_date  || null,
       qtyDone, calcProgress, autoStatus,
       sort_order != null ? parseInt(sort_order) : null,
       notes || null, parseInt(req.params.id)]
    );

    return res.json({ success: true, data: result.rows[0],
      metadata: { generated_at: new Date().toISOString() } });
  } catch(e) { next(e); }
});

// DELETE /api/project-activities/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM project_activities WHERE parent_id=$1', [parseInt(req.params.id)]);
    const result = await query('DELETE FROM project_activities WHERE id=$1 RETURNING *', [parseInt(req.params.id)]);
    if (!result.rows[0]) return res.status(404).json({ success: false,
      error: { code: 'NOT_FOUND', message: 'Activity not found' } });
    return res.json({ success: true, data: { deleted: true, id: req.params.id },
      metadata: { generated_at: new Date().toISOString() } });
  } catch(e) { next(e); }
});

module.exports = router;
