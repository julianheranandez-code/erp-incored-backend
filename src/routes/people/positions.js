'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');

router.use(verifyToken);

// GET /api/people/positions?job_family=X&search=Y
router.get('/', async (req, res, next) => {
  try {
    const { job_family, search, is_active = 'true' } = req.query;
    let conditions = ['is_active = $1'];
    let values = [is_active === 'true'];
    let idx = 2;
    if (job_family) { conditions.push(`job_family = $${idx++}`); values.push(job_family); }
    if (search) {
      conditions.push(`(title ILIKE $${idx} OR job_code ILIKE $${idx})`);
      values.push('%' + search + '%'); idx++;
    }
    const result = await query(`
      SELECT uuid, job_code, title, title_en, job_family,
        level, is_manager, description, is_active
      FROM position_catalog
      WHERE ${conditions.join(' AND ')}
      ORDER BY job_family, level, job_code
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

module.exports = router;
