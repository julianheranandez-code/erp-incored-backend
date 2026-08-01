'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');

router.use(verifyToken);

// GET /api/people/skills-catalog?skill_category=X&search=Y
router.get('/', async (req, res, next) => {
  try {
    const { skill_category, search, is_active = 'true' } = req.query;
    let conditions = ['is_active = $1'];
    let values = [is_active === 'true'];
    let idx = 2;
    if (skill_category) { conditions.push(`skill_category = $${idx++}`); values.push(skill_category); }
    if (search) {
      conditions.push(`(name ILIKE $${idx} OR skill_code ILIKE $${idx})`);
      values.push('%' + search + '%'); idx++;
    }
    const result = await query(`
      SELECT uuid, skill_code, name, name_en, skill_category,
        description, requires_expiry, is_active
      FROM skills_catalog
      WHERE ${conditions.join(' AND ')}
      ORDER BY skill_category, name
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

module.exports = router;
