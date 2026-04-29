'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, name, short_code, country, industry, email, status
       FROM companies WHERE status != 'deleted' ORDER BY name ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
