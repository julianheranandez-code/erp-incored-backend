'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');

router.use(verifyToken);

// GET /api/admin/countries
router.get('/countries', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT code, name, name_es, currency_code, phone_prefix, tax_id_label FROM countries WHERE is_active=true ORDER BY name'
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/admin/currencies
router.get('/currencies', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT code, name, name_es, symbol, decimal_places FROM currencies WHERE is_active=true ORDER BY code'
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

module.exports = router;
