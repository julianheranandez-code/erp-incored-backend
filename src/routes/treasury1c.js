'use strict';

/**
 * Treasury Sprint 1C — Bank Imports & Reconciliation
 * ===================================================
 * Endpoints:
 *   POST   /api/treasury/imports
 *   GET    /api/treasury/imports
 *   GET    /api/treasury/imports/:id
 *   POST   /api/treasury/imports/:id/process
 *   GET    /api/treasury/reconciliation/unmatched
 *   PATCH  /api/treasury/reconciliation/rows/:id/classify
 *   GET    /api/treasury/reconciliation/summary
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parse/sync');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getEffectivePermissions } = require('../lib/iam/effective-permissions');
const logger = require('../utils/logger');

router.use(verifyToken);

// Memory storage — no disk writes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     'application/vnd.ms-excel','application/pdf'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls|pdf)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: CSV, XLSX, PDF'));
    }
  }
});

// ─── HELPERS ─────────────────────────────────────────────────
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

function getCompanyScope(user, queryCompanyId) {
  const roles = getEffectiveRoles(user);
  if (roles.includes('super_admin')) return queryCompanyId ? parseInt(queryCompanyId) : null;
  return parseInt(user.active_company_id || user.company_id);
}

async function assertTreasuryPermission(req, res, permission = 'treasury.view') {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const effective = await getEffectivePermissions(req.user.id, companyId);
    const perms = effective.effective_permissions || [];
    const hasAccess = perms.includes('*') || perms.includes(permission) ||
      perms.includes('treasury.*') ||
      perms.some(p => p.endsWith('.*') && permission.startsWith(p.slice(0,-2)+'.'));
    if (!hasAccess) {
      res.status(403).json({ success: false, error: 'permission_denied', permission });
      return false;
    }
    return true;
  } catch(err) {
    res.status(403).json({ success: false, error: 'permission_check_failed' });
    return false;
  }
}

async function assertCompanyAccess(req, res, companyId) {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;
  const userCompanyId = parseInt(req.user.active_company_id || req.user.company_id);
  if (userCompanyId === parseInt(companyId)) return true;
  try {
    const access = await query(
      `SELECT 1 FROM user_company_access WHERE user_id=$1 AND company_id=$2 AND is_active=TRUE`,
      [req.user.id, parseInt(companyId)]
    );
    if (!access.rows[0]) {
      res.status(403).json({ success: false, error: 'company_access_denied' });
      return false;
    }
    return true;
  } catch(err) {
    res.status(403).json({ success: false, error: 'company_access_check_failed' });
    return false;
  }
}

// ─── FILE PARSERS ─────────────────────────────────────────────

function parseCSV(buffer) {
  const content = buffer.toString('utf8');
  const records = csv.parse(content, {
    columns: true, skip_empty_lines: true, trim: true
  });
  return records;
}

function parseXLSX(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { raw: false, dateNF: 'YYYY-MM-DD' });
}

async function parsePDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    const lines = data.text.split('\n').filter(l => l.trim());
    return { text: data.text, lines, pageCount: data.numpages };
  } catch(err) {
    throw new Error('PDF could not be parsed. Please ensure the PDF contains selectable text (not scanned).');
  }
}

/**
 * Normalize a raw row from CSV/XLSX into treasury_import_rows format
 * Handles common bank statement column variations
 */
function normalizeRow(raw) {
  // Common date field names
  const dateFields = ['date','fecha','transaction_date','trans_date','posting_date'];
  const descFields = ['description','descripcion','details','concepto','memo','narrative'];
  const amtFields  = ['amount','monto','importe','debit','credit','charges','deposits'];
  const refFields  = ['reference','referencia','ref','transaction_id','check_number'];
  const balFields  = ['balance','saldo','running_balance'];

  const findField = (fields) => {
    for (const f of fields) {
      const key = Object.keys(raw).find(k => k.toLowerCase().replace(/\s/g,'_') === f);
      if (key && raw[key]) return raw[key];
    }
    return null;
  };

  const dateRaw = findField(dateFields);
  const desc    = findField(descFields) || 'Imported transaction';
  const amtRaw  = findField(amtFields);
  const ref     = findField(refFields);
  const bal     = findField(balFields);

  if (!dateRaw || !amtRaw) return null;

  const amount = Math.abs(parseFloat(String(amtRaw).replace(/[,$]/g,'')));
  if (isNaN(amount) || amount === 0) return null;

  // Detect direction from amount sign or separate debit/credit columns
  let direction = 'OUTFLOW';
  const rawStr = String(amtRaw).replace(/[,$\s]/g,'');
  if (rawStr.startsWith('-') || raw['debit'] || raw['charges']) direction = 'OUTFLOW';
  if (!rawStr.startsWith('-') || raw['credit'] || raw['deposits']) direction = 'INFLOW';
  // If has explicit credit column with value
  if (raw['credit'] && parseFloat(raw['credit']) > 0) direction = 'INFLOW';
  if (raw['debit']  && parseFloat(raw['debit'])  > 0) direction = 'OUTFLOW';

  return {
    transaction_date: new Date(dateRaw).toISOString().slice(0,10),
    bank_description: String(desc).slice(0,500),
    bank_reference:   ref ? String(ref).slice(0,100) : null,
    amount,
    direction,
    running_balance:  bal ? parseFloat(String(bal).replace(/[,$]/g,'')) : null,
    raw_data: raw
  };
}

// ─── MATCHING ENGINE ──────────────────────────────────────────

async function runMatchingEngine(batchId, companyId) {
  // Fetch batch to get the correct bank_account_id
  const batchResult = await query(
    `SELECT bank_account_id FROM treasury_import_batches WHERE id=$1`, [batchId]
  );
  if (!batchResult.rows[0]) return 0;
  const bankAccountId = batchResult.rows[0].bank_account_id;

  const rows = await query(
    `SELECT * FROM treasury_import_rows WHERE batch_id=$1 AND match_status='unmatched'`,
    [batchId]
  );

  let matched = 0;
  for (const row of rows.rows) {
    // Normalize direction — ERP standard: INFLOW/OUTFLOW
    const direction = row.direction.toUpperCase();

    // Rule 1: company_id + bank_account_id + amount + direction + date ±3 days
    const dateFrom = new Date(row.transaction_date);
    dateFrom.setDate(dateFrom.getDate() - 3);
    const dateTo = new Date(row.transaction_date);
    dateTo.setDate(dateTo.getDate() + 3);

    const match = await query(`
      SELECT id FROM treasury_bank_transactions
      WHERE company_id = $1
        AND bank_account_id = $2
        AND amount = $3
        AND direction = $4
        AND transaction_date BETWEEN $5 AND $6
        AND status != 'reconciled'
      LIMIT 1
    `, [companyId, bankAccountId, row.amount, direction,
        dateFrom.toISOString().slice(0,10),
        dateTo.toISOString().slice(0,10)]);

    if (!match.rows[0] && row.bank_reference) {
      // Rule 2: company_id + bank_account_id + bank_reference
      const refMatch = await query(`
        SELECT id FROM treasury_bank_transactions
        WHERE company_id = $1 AND bank_account_id = $2 AND bank_reference = $3
        LIMIT 1
      `, [companyId, bankAccountId, row.bank_reference]);
      // TODO Rule 3: Match by invoice_number (future sprint — requires invoice FK)
      // TODO Rule 4: Match by po_number (future sprint — requires PO FK)
      if (refMatch.rows[0]) {
        await query(
          `UPDATE treasury_import_rows SET match_status='matched', matched_transaction_id=$1 WHERE id=$2`,
          [refMatch.rows[0].id, row.id]
        );
        matched++;
        continue;
      }
    }

    if (match.rows[0]) {
      await query(
        `UPDATE treasury_import_rows SET match_status='matched', matched_transaction_id=$1 WHERE id=$2`,
        [match.rows[0].id, row.id]
      );
      matched++;
    }
  }
  return matched;
}

// ─── IMPORT ENDPOINTS ─────────────────────────────────────────

// POST /api/treasury/imports
router.post('/imports', upload.single('file'), async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const { company_id, bank_account_id } = req.body;
    if (!company_id || !bank_account_id || !req.file)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, bank_account_id, file' });

    if (!await assertCompanyAccess(req, res, company_id)) return;

    // Verify bank account belongs to company
    const acctCheck = await query(
      `SELECT id FROM treasury_bank_accounts WHERE id=$1 AND company_id=$2 AND status='active'`,
      [parseInt(bank_account_id), parseInt(company_id)]
    );
    if (!acctCheck.rows[0])
      return res.status(400).json({ success: false, error: 'invalid_bank_account' });

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const fileType = ext === 'pdf' ? 'pdf' : ext === 'xlsx' || ext === 'xls' ? 'xlsx' : 'csv';

    const batch = await query(`
      INSERT INTO treasury_import_batches
        (company_id, bank_account_id, file_name, file_type, import_status, uploaded_by)
      VALUES ($1,$2,$3,$4,'processing',$5) RETURNING *
    `, [parseInt(company_id), parseInt(bank_account_id),
        req.file.originalname, fileType, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'import_batch_created',
      entityType: 'treasury_import_batches', entityId: String(batch.rows[0].id),
      companyId: parseInt(company_id),
      newValues: { file_name: req.file.originalname, file_type: fileType },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Import batch created.', data: batch.rows[0] });
  } catch (error) { next(error); }
});

// GET /api/treasury/imports
router.get('/imports', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`b.company_id=$${idx++}`); values.push(companyId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT b.*, a.bank_name, a.account_name, a.currency,
        CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name
      FROM treasury_import_batches b
      JOIN treasury_bank_accounts a ON a.id = b.bank_account_id
      LEFT JOIN users u ON u.id = b.uploaded_by
      ${where}
      ORDER BY b.uploaded_at DESC LIMIT 100
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// GET /api/treasury/imports/:id
router.get('/imports/:id', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const batchId = parseInt(req.params.id);
    const companyId = getCompanyScope(req.user, req.query.company_id);

    const batch = await query(`
      SELECT b.*, a.bank_name, a.account_name, a.currency,
        CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name
      FROM treasury_import_batches b
      JOIN treasury_bank_accounts a ON a.id = b.bank_account_id
      LEFT JOIN users u ON u.id = b.uploaded_by
      WHERE b.id=$1 ${companyId ? 'AND b.company_id=$2' : ''}
    `, companyId ? [batchId, companyId] : [batchId]);

    if (!batch.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const rows = await query(`
      SELECT r.*, cat.name AS category_name
      FROM treasury_import_rows r
      LEFT JOIN treasury_transaction_categories cat ON cat.id = r.category_id
      WHERE r.batch_id=$1 ORDER BY r.transaction_date ASC
    `, [batchId]);

    res.json({ success: true, data: { ...batch.rows[0], rows: rows.rows } });
  } catch (error) { next(error); }
});

// POST /api/treasury/imports/:id/process
router.post('/imports/:id/process', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const batchId = parseInt(req.params.id);

    const batch = await query(
      `SELECT * FROM treasury_import_batches WHERE id=$1`, [batchId]
    );
    if (!batch.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    if (!await assertCompanyAccess(req, res, batch.rows[0].company_id)) return;

    const { file_data, file_type } = req.body;
    if (!file_data)
      return res.status(400).json({ success: false, error: 'file_data_required',
        message: 'Send file_data as base64 string.' });

    const buffer = Buffer.from(file_data, 'base64');
    let rawRows = [];
    let parseError = null;

    try {
      if (file_type === 'csv' || batch.rows[0].file_type === 'csv') {
        rawRows = parseCSV(buffer);
      } else if (file_type === 'xlsx' || batch.rows[0].file_type === 'xlsx') {
        rawRows = parseXLSX(buffer);
      } else if (file_type === 'pdf' || batch.rows[0].file_type === 'pdf') {
        const pdfData = await parsePDF(buffer);
        // PDF: return raw text for manual review — auto-parse not reliable without OCR
        await query(
          `UPDATE treasury_import_batches SET import_status='partial', processed_at=NOW(),
           total_rows=0, imported_rows=0, failed_rows=0 WHERE id=$1`,
          [batchId]
        );
        return res.json({ success: true,
          message: 'PDF text extracted. Manual entry required for PDF imports.',
          data: { pdf_text: pdfData.text, page_count: pdfData.pageCount, lines: pdfData.lines.slice(0,50) }
        });
      }
    } catch(err) {
      parseError = err.message;
    }

    if (parseError) {
      await query(
        `UPDATE treasury_import_batches SET import_status='failed', error_message=$1 WHERE id=$2`,
        [parseError, batchId]
      );
      return res.status(400).json({ success: false, error: 'parse_error', message: parseError });
    }

    // Normalize and insert rows
    let imported = 0, failed = 0, duplicates = 0;
    // Fetch bank_account_id for matching
    const batchAccountId = batch.rows[0].bank_account_id;
    for (const raw of rawRows) {
      const normalized = normalizeRow(raw);
      if (!normalized) { failed++; continue; }

      try {
        // C4: Generate fingerprint hash for duplicate prevention
        const crypto = require('crypto');
        // ISSUE 2: Normalize direction — ERP standard is INFLOW/OUTFLOW
        const normalizedDirection = (normalized.direction||'OUTFLOW').toUpperCase();
        const hashInput = [batch.rows[0].company_id, batchAccountId,
          normalized.transaction_date, normalized.amount,
          normalizedDirection, normalized.bank_reference||''].join('|');
        const importHash = crypto.createHash('sha256').update(hashInput).digest('hex');

        try {
          await query(`
            INSERT INTO treasury_import_rows
              (batch_id, company_id, transaction_date, bank_description, bank_reference,
               amount, direction, running_balance, raw_data, import_hash)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `, [batchId, batch.rows[0].company_id, normalized.transaction_date,
              normalized.bank_description, normalized.bank_reference,
              normalized.amount, normalizedDirection, normalized.running_balance,
              JSON.stringify(normalized.raw_data), importHash]);
          imported++;
        } catch(dupErr) {
          if (dupErr.code === '23505') { duplicates++; } // unique_violation
          else { failed++; }
        }
      } catch(err) { failed++; }
    }

    // Run matching engine
    const matched = await runMatchingEngine(batchId, batch.rows[0].company_id);

    await query(`
      UPDATE treasury_import_batches
      SET import_status='completed', total_rows=$1, imported_rows=$2,
          failed_rows=$3, duplicate_rows=$4, processed_at=NOW()
      WHERE id=$5
    `, [rawRows.length, imported, failed, duplicates, batchId]);

    writeAudit({
      userId: req.user.id, action: 'import_batch_processed',
      entityType: 'treasury_import_batches', entityId: String(batchId),
      companyId: batch.rows[0].company_id,
      newValues: { total: rawRows.length, imported, failed, duplicates, matched },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Import processed.',
      data: { batch_id: batchId, total: rawRows.length, imported, failed, duplicates, matched } });
  } catch (error) { next(error); }
});

// ─── RECONCILIATION ENDPOINTS ─────────────────────────────────

// GET /api/treasury/reconciliation/unmatched
router.get('/reconciliation/unmatched', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [`r.match_status = 'unmatched'`];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`r.company_id=$${idx++}`); values.push(companyId); }
    if (req.query.batch_id) { conditions.push(`r.batch_id=$${idx++}`); values.push(req.query.batch_id); }

    const result = await query(`
      SELECT r.*, b.file_name, b.bank_account_id,
        a.bank_name, a.currency, cat.name AS category_name
      FROM treasury_import_rows r
      JOIN treasury_import_batches b ON b.id = r.batch_id
      JOIN treasury_bank_accounts a ON a.id = b.bank_account_id
      LEFT JOIN treasury_transaction_categories cat ON cat.id = r.category_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.transaction_date DESC
      LIMIT 200
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// PATCH /api/treasury/reconciliation/rows/:id/classify
router.patch('/reconciliation/rows/:id/classify', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.update')) return;
  try {
    const rowId = parseInt(req.params.id);
    const { category_id, project_id, vendor_id, client_id,
            notes, match_status, matched_transaction_id } = req.body;

    const existing = await query(
      `SELECT r.*, b.company_id FROM treasury_import_rows r
       JOIN treasury_import_batches b ON b.id = r.batch_id WHERE r.id=$1`, [rowId]
    );
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    if (!await assertCompanyAccess(req, res, existing.rows[0].company_id)) return;

    const VALID_STATUSES = ['matched','unmatched','ignored'];
    if (match_status && !VALID_STATUSES.includes(match_status))
      return res.status(400).json({ success: false, error: 'invalid_status' });

    // C6: Require reason when manually overriding to matched or ignored
    if ((match_status === 'matched' || match_status === 'ignored') && !req.body.reason)
      return res.status(400).json({ success: false, error: 'reason_required',
        message: 'A reason is required when manually marking as matched or ignored.' });

    const result = await query(`
      UPDATE treasury_import_rows SET
        category_id = COALESCE($1, category_id),
        project_id  = COALESCE($2, project_id),
        vendor_id   = COALESCE($3, vendor_id),
        client_id   = COALESCE($4, client_id),
        notes       = COALESCE($5, notes),
        match_status = COALESCE($6, match_status),
        matched_transaction_id = COALESCE($7, matched_transaction_id),
        reason      = COALESCE($8, reason)
      WHERE id=$9 RETURNING *
    `, [category_id||null, project_id||null, vendor_id||null, client_id||null,
        notes||null, match_status||null, matched_transaction_id||null,
        req.body.reason||null, rowId]);

    // C5+C6: Determine specific audit action + require reason for manual overrides
    const auditAction = match_status === 'matched'   ? 'reconciliation_row_matched' :
                        match_status === 'ignored'   ? 'reconciliation_row_ignored' :
                        match_status === 'unmatched' ? 'reconciliation_row_unmatched' :
                        'reconciliation_row_reclassified';

    writeAudit({
      userId: req.user.id, action: auditAction,
      entityType: 'treasury_import_rows', entityId: String(rowId),
      companyId: existing.rows[0].company_id,
      oldValues: { match_status: existing.rows[0].match_status },
      newValues: { ...req.body, reason: req.body.reason || null },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Row classified.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// GET /api/treasury/reconciliation/summary
router.get('/reconciliation/summary', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const filter = companyId ? 'WHERE r.company_id=$1' : '';
    const values = companyId ? [companyId] : [];

    const result = await query(`
      SELECT
        COUNT(*) AS total_imported,
        COUNT(*) FILTER (WHERE r.match_status='matched')   AS matched,
        COUNT(*) FILTER (WHERE r.match_status='unmatched') AS unmatched,
        COUNT(*) FILTER (WHERE r.match_status='ignored')   AS ignored,
        SUM(CASE WHEN r.match_status='matched'   THEN r.amount ELSE 0 END) AS reconciled_amount,
        SUM(CASE WHEN r.match_status='unmatched' THEN r.amount ELSE 0 END) AS unreconciled_amount
      FROM treasury_import_rows r ${filter}
    `, values);

    res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

module.exports = router;
