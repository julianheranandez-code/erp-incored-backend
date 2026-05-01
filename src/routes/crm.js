'use strict';

const express = require('express');
const router = express.Router();

const Client = require('../models/Client');
const Quote = require('../models/Quote');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { authorize } = require('../middleware/authorization');
const { validate, schemas } = require('../middleware/validation');
const { auditLog } = require('../middleware/audit');
const { sendQuoteEmail } = require('../utils/emailer');
const { generateQuotePDF } = require('../utils/pdfGenerator');
const { getPagination, buildPaginatedResponse } = require('../utils/helpers');

router.use(verifyToken, auditLog);

// ─── CLIENTS ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /clients:
 *   get:
 *     summary: GET /clients
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/clients', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const result = await Client.findAll({ type: 'cliente', search: req.query.search, page, limit });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /clients/:id:
 *   get:
 *     summary: GET /clients/:id
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.findById(parseInt(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'not_found', message: 'Cliente no encontrado.' });
    res.json({ success: true, data: client });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /clients:
 *   post:
 *     summary: POST /clients
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/clients', validate(schemas.createClient), async (req, res, next) => {
  try {
    req.body.type = req.body.type || 'cliente';
    const client = await Client.create(req.body);
    res.status(201).json({ success: true, message: 'Cliente creado.', data: client });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /clients/:id:
 *   put:
 *     summary: PUT /clients/:id
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/clients/:id', async (req, res, next) => {
  try {
    const client = await Client.update(parseInt(req.params.id), req.body);
    if (!client) return res.status(404).json({ success: false, error: 'not_found', message: 'Cliente no encontrado.' });
    res.json({ success: true, message: 'Cliente actualizado.', data: client });
  } catch (error) { next(error); }
});

// ─── SUPPLIERS ───────────────────────────────────────────────────────────────

/**
 * @swagger
 * /suppliers:
 *   get:
 *     summary: GET /suppliers
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/suppliers', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const result = await Client.findAll({ type: 'proveedor', search: req.query.search, page, limit });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /suppliers:
 *   post:
 *     summary: POST /suppliers
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/suppliers', validate(schemas.createClient), async (req, res, next) => {
  try {
    req.body.type = 'proveedor';
    const supplier = await Client.create(req.body);
    res.status(201).json({ success: true, message: 'Proveedor creado.', data: supplier });
  } catch (error) { next(error); }
});

// ─── LEADS ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /leads:
 *   get:
 *     summary: GET /leads
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/leads', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`company_id = $${idx++}`); params.push(companyId); }
    if (req.query.stage) { conditions.push(`stage = $${idx++}`); params.push(req.query.stage); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const [rows, countResult] = await Promise.all([
      query(`SELECT l.*, c.name AS client_name, CONCAT(u.first_name, ' ', u.last_name) AS assigned_to_name
             FROM leads l LEFT JOIN clients c ON c.id = l.client_id LEFT JOIN users u ON u.id = l.assigned_to
             ${where} ORDER BY l.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]),
      query(`SELECT COUNT(*) AS total FROM leads l ${where}`, params),
    ]);
    res.json({ success: true, ...buildPaginatedResponse(rows.rows, parseInt(countResult.rows[0].total), page, limit) });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /leads:
 *   post:
 *     summary: POST /leads
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/leads', async (req, res, next) => {
  try {
    const result = await query(
`INSERT INTO leads (title, client_id, company_id, assigned_to, stage, value, currency, probability, source, expected_close_date, notes, service_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.body.title, req.body.client_id || null, req.body.company_id || req.user.company_id,
       req.body.assigned_to || req.user.id, req.body.stage || 'prospecto',
       req.body.value || null, req.body.currency || 'MXN', req.body.probability || null,
       req.body.source || null, req.body.expected_close_date || null,
       req.body.notes || null, req.body.service_type || null, req.user.id]

    );
    res.status(201).json({ success: true, message: 'Lead creado.', data: result.rows[0] });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /leads/:id/stage:
 *   put:
 *     summary: PUT /leads/:id/stage
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */

router.put('/leads/:id/stage', async (req, res, next) => {
  try {
    const { stage, purchase_order_url, client_po_number, delivery_time, payment_conditions, po_comments } = req.body;
    const validStages = ['prospecto', 'contactado', 'cotizacion', 'negociacion', 'ganado', 'perdido', 'cancelado'];
    if (!validStages.includes(stage)) return res.status(400).json({ success: false, error: 'validation_error', message: 'Etapa inválida.' });
    
    const isGanado = stage === 'ganado';
    const result = await query(
      `UPDATE leads SET 
        stage = $1, 
        purchase_order_url = COALESCE($2, purchase_order_url),
        purchase_order_date = CASE WHEN $3 AND purchase_order_date IS NULL THEN NOW() ELSE purchase_order_date END,
        client_po_number = COALESCE($4, client_po_number),
        delivery_time = COALESCE($5, delivery_time),
        payment_conditions = COALESCE($6, payment_conditions),
        po_comments = COALESCE($7, po_comments),
        updated_at = NOW() 
       WHERE id = $8 RETURNING *`,
      [stage, purchase_order_url || null, isGanado, 
       client_po_number || null, delivery_time || null, 
       payment_conditions || null, po_comments || null,
       parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Lead no encontrado.' });
    res.json({ success: true, message: 'Etapa actualizada.', data: result.rows[0] });
  } catch (error) { next(error); }
});


// ─── QUOTES ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /quotes:
 *   get:
 *     summary: GET /quotes
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/quotes', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const result = await Quote.findAll({ companyId, clientId: req.query.client_id, status: req.query.status, search: req.query.search, page, limit });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /quotes/:id:
 *   get:
 *     summary: GET /quotes/:id
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/quotes/:id', async (req, res, next) => {
  try {
    const quote = await Quote.findById(parseInt(req.params.id));
    if (!quote) return res.status(404).json({ success: false, error: 'not_found', message: 'Cotización no encontrada.' });
    res.json({ success: true, data: quote });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /quotes:
 *   post:
 *     summary: POST /quotes
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/quotes', validate(schemas.createQuote), async (req, res, next) => {
  try {
    // Auto-generate folio
    const companyResult = await query(`SELECT short_code FROM companies WHERE id = $1`, [req.body.company_id]);
    if (!companyResult.rows[0]) return res.status(400).json({ success: false, error: 'validation_error', message: 'Empresa no encontrada.' });
    req.body.folio = await Quote.getNextFolio(companyResult.rows[0].short_code);
    const quote = await Quote.create(req.body, req.user.id);
    res.status(201).json({ success: true, message: 'Cotización creada.', data: quote });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /quotes/:id:
 *   put:
 *     summary: PUT /quotes/:id
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/quotes/:id', async (req, res, next) => {
  try {
    const quote = await Quote.findById(parseInt(req.params.id));
    if (!quote) return res.status(404).json({ success: false, error: 'not_found', message: 'Cotización no encontrada.' });
    if (quote.status !== 'borrador') {
      return res.status(400).json({ success: false, error: 'error', message: 'Solo se pueden editar cotizaciones en borrador.' });
    }
    const result = await query(`UPDATE quotes SET terms_conditions = $1, validity_days = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [req.body.terms_conditions || quote.terms_conditions, req.body.validity_days || quote.validity_days, parseInt(req.params.id)]);
    res.json({ success: true, message: 'Cotización actualizada.', data: result.rows[0] });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /quotes/:id/status:
 *   put:
 *     summary: PUT /quotes/:id/status
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/quotes/:id/status', async (req, res, next) => {
  try {
    const updated = await Quote.updateStatus(parseInt(req.params.id), req.body.status);
    if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Cotización no encontrada.' });
    res.json({ success: true, message: 'Estado de cotización actualizado.', data: updated });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /quotes/:id/send-email:
 *   post:
 *     summary: POST /quotes/:id/send-email
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/quotes/:id/send-email', async (req, res, next) => {
  try {
    const quote = await Quote.findById(parseInt(req.params.id));
    if (!quote) return res.status(404).json({ success: false, error: 'not_found', message: 'Cotización no encontrada.' });

    const pdfBuffer = await generateQuotePDF(quote);
    const toEmail = req.body.to_email || quote.client_email;
    if (!toEmail) return res.status(400).json({ success: false, error: 'validation_error', message: 'Email del destinatario requerido.' });

    await sendQuoteEmail({ to: toEmail, clientName: quote.client_name, quoteNumber: quote.folio, pdfBuffer, senderName: req.user.name });
    await Quote.updateStatus(parseInt(req.params.id), 'enviada');

    res.json({ success: true, message: `Cotización enviada a ${toEmail}.` });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /quotes/:id/pdf:
 *   get:
 *     summary: GET /quotes/:id/pdf
 *     tags:
 *       - CRM
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/quotes/:id/pdf', async (req, res, next) => {
  try {
    const quote = await Quote.findById(parseInt(req.params.id));
    if (!quote) return res.status(404).json({ success: false, error: 'not_found', message: 'Cotización no encontrada.' });
    const pdfBuffer = await generateQuotePDF(quote);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Cotizacion-${quote.folio}.pdf"` });
    res.send(pdfBuffer);
  } catch (error) { next(error); }
});

router.put('/suppliers/:id', async (req, res, next) => {
  try {
    const supplier = await Client.update(parseInt(req.params.id), req.body);
    if (!supplier) return res.status(404).json({ success: false, error: 'not_found', message: 'Proveedor no encontrado.' });
    res.json({ success: true, message: 'Proveedor actualizado.', data: supplier });
  } catch (error) { next(error); }
});


router.delete('/clients/:id', async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE clients SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Cliente no encontrado.' });
    res.json({ success: true, message: 'Cliente eliminado.' });
  } catch (error) { next(error); }
});

router.delete('/suppliers/:id', async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE clients SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Proveedor no encontrado.' });
    res.json({ success: true, message: 'Proveedor eliminado.' });
  } catch (error) { next(error); }
});
module.exports = router;
