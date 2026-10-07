'use strict';
// =============================================================================
// EDIMS — routes/invoices.js
// Invoices of two kinds:
//   Chargeback — billed to an employee and/or department for devices
//   Purchase   — received from a vendor for devices bought
// Lifecycle: Draft → Issued → Paid, and Issued/Paid → Void (Admin).
// The invoice number (INV-YYYY-NNNN / PUR-YYYY-NNNN, gapless per year of the
// invoice date) is assigned when a draft is issued; from then on the
// invoice can't be edited or deleted, only paid or voided.
//
//   GET    /api/invoices?type=&status=&search=&limit=&offset=
//   GET    /api/invoices/export.csv?type=&status=
//   GET    /api/invoices/:id
//   GET    /api/invoices/:id/pdf
//   POST   /api/invoices                 create draft (with lines)
//   PUT    /api/invoices/:id             edit draft (lines replaced if sent)
//   DELETE /api/invoices/:id             delete draft
//   POST   /api/invoices/:id/issue
//   POST   /api/invoices/:id/pay         { payment_reference? }
//   POST   /api/invoices/:id/void        { reason }
// =============================================================================

const express       = require('express');
const PDFDocument   = require('pdfkit');
const { stringify } = require('csv-stringify');
const { sanitizeStr, sanitizeObj, isUUID, isDate, parseNumber } = require('../lib/helpers');

const PREFIX       = { Chargeback: 'INV', Purchase: 'PUR' };
const MAX_LINES    = 200;
const HEADER_FIELDS = ['invoice_type', 'employee_id', 'department', 'vendor', 'vendor_invoice_number',
                       'invoice_date', 'due_date', 'currency', 'tax_rate', 'notes'];

const DEFAULT_CURRENCY = /^[A-Z]{3}$/.test(process.env.DEFAULT_CURRENCY || '') ? process.env.DEFAULT_CURRENCY : 'USD';

// "USD 1,234.50" — currency code rather than symbol so the PDF's built-in
// fonts can always render it. Always 2 decimals: amounts are stored to the
// cent, and Intl would otherwise round e.g. PKR/JPY to whole units.
function money(v, currency) {
  const n = Number(v || 0);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
// DATE columns arrive as 'YYYY-MM-DD' strings (format as-is, in UTC so the
// day can't shift); timestamps arrive as Dates (format in server local time)
const fmtDate = (d) => {
  if (!d) return '—';
  const opts = { day: '2-digit', month: 'short', year: 'numeric' };
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) opts.timeZone = 'UTC';
  return new Date(d).toLocaleDateString('en-GB', opts);
};

module.exports = function invoiceRoutes({ query, withTransaction, checkReference }, can, approvals) {
  const router = express.Router();

  // ── Validation ────────────────────────────────────────────────────────────
  // Returns { header, lines } (lines undefined when not sent) or { error }.
  async function prepare(body, existing) {
    const h = sanitizeObj(body, HEADER_FIELDS);
    for (const k of ['employee_id', 'department', 'vendor', 'vendor_invoice_number', 'due_date', 'notes']) {
      if (h[k] === '') h[k] = null;
    }
    const type = existing ? existing.invoice_type : h.invoice_type;
    if (!existing && !PREFIX[type]) return { error: 'invoice_type must be Chargeback or Purchase.' };
    if (existing && h.invoice_type !== undefined && h.invoice_type !== existing.invoice_type)
      return { error: 'invoice_type cannot be changed; create a new invoice instead.' };
    delete h.invoice_type;

    if (h.employee_id != null && !isUUID(h.employee_id)) return { error: 'Invalid employee_id.' };
    for (const k of ['invoice_date', 'due_date']) {
      if (h[k] != null && h[k] !== undefined && !isDate(h[k])) return { error: `${k} must be YYYY-MM-DD.` };
    }
    if (h.invoice_date === null || h.invoice_date === '') delete h.invoice_date;
    if (h.currency !== undefined) {
      h.currency = String(h.currency || '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(h.currency)) return { error: 'currency must be a 3-letter code like USD.' };
    }
    if (h.tax_rate !== undefined) {
      const t = parseNumber(h.tax_rate, 'tax_rate', { max: 100 });
      if (t.error) return { error: t.error };
      h.tax_rate = t.value ?? 0;
    }
    if (h.notes && h.notes.length > 2000) return { error: 'notes are limited to 2000 characters.' };

    // Who's on the invoice — check the merged result, not just what was sent
    const merged = { ...(existing || {}), ...h };
    if (type === 'Chargeback') {
      if (!merged.employee_id && !merged.department)
        return { error: 'A chargeback invoice needs an employee or a department to bill.' };
      if (h.employee_id) {
        const { rowCount } = await query('SELECT 1 FROM employees WHERE id=$1', [h.employee_id]);
        if (!rowCount) return { error: 'Employee not found.' };
      }
      if (h.department !== undefined) {
        const e = await checkReference('locations', h, 'department', 'Department', { allowInactive: !!existing });
        if (e) return { error: e };
      }
      if (h.vendor) return { error: 'vendor applies to purchase invoices only.' };
    } else {
      if (!merged.vendor) return { error: 'A purchase invoice needs a vendor.' };
      if (h.vendor !== undefined) {
        const e = await checkReference('vendors', h, 'vendor', 'Vendor', { allowInactive: !!existing });
        if (e) return { error: e };
      }
      if (h.employee_id || h.department) return { error: 'employee_id / department apply to chargeback invoices only.' };
    }

    if (body.lines === undefined) return { header: h, type };
    if (!Array.isArray(body.lines)) return { error: 'lines must be an array.' };
    if (body.lines.length > MAX_LINES) return { error: `At most ${MAX_LINES} lines per invoice.` };

    const lines = [];
    for (const [i, raw] of body.lines.entries()) {
      const l = sanitizeObj(raw, ['asset_id', 'catalog_item_id', 'description', 'quantity', 'unit_price']);
      const n = i + 1;
      for (const k of ['asset_id', 'catalog_item_id']) {
        if (l[k] === '' || l[k] === undefined) l[k] = null;
        if (l[k] && !isUUID(l[k])) return { error: `Line ${n}: invalid ${k}.` };
      }
      // Fill description / price from the device or catalogue item when blank
      let asset = null, item = null;
      if (l.asset_id) {
        ({ rows: [asset] } = await query(
          `SELECT a.asset_tag, a.serial_number, a.vendor, a.model, a.purchase_price, a.catalog_item_id, cp.subcategory
           FROM assets a JOIN device_category_paths cp ON cp.id=a.category_id WHERE a.id=$1`, [l.asset_id]));
        if (!asset) return { error: `Line ${n}: device not found.` };
        if (!l.catalog_item_id) l.catalog_item_id = asset.catalog_item_id;
      }
      if (l.catalog_item_id) {
        ({ rows: [item] } = await query('SELECT vendor, model, standard_price FROM catalog_items WHERE id=$1', [l.catalog_item_id]));
        if (!item) return { error: `Line ${n}: catalogue item not found.` };
      }
      if (!l.description) {
        if (asset) l.description = `${asset.subcategory} — ${[asset.vendor, asset.model].filter(Boolean).join(' ')} (Tag ${asset.asset_tag}, S/N ${asset.serial_number})`;
        else if (item) l.description = [item.vendor, item.model].filter(Boolean).join(' ');
        else return { error: `Line ${n}: description is required.` };
      }
      if (l.description.length > 500) return { error: `Line ${n}: description is limited to 500 characters.` };
      if (l.unit_price === undefined || l.unit_price === null || l.unit_price === '') {
        l.unit_price = asset?.purchase_price ?? item?.standard_price ?? null;
        if (l.unit_price === null) return { error: `Line ${n}: unit_price is required.` };
      }
      const q = parseNumber(l.quantity === undefined || l.quantity === '' ? 1 : l.quantity, `Line ${n} quantity`, { min: 0.01, max: 1e6 });
      const p = parseNumber(l.unit_price, `Line ${n} unit_price`, { max: 1e9 });
      if (q.error || p.error) return { error: q.error || p.error };
      lines.push({ ...l, quantity: q.value, unit_price: p.value, line_no: n });
    }
    return { header: h, lines, type };
  }

  async function writeLines(client, invoiceId, lines) {
    await client.query('DELETE FROM invoice_lines WHERE invoice_id=$1', [invoiceId]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO invoice_lines (invoice_id, line_no, asset_id, catalog_item_id, description, quantity, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoiceId, l.line_no, l.asset_id, l.catalog_item_id, l.description, l.quantity, l.unit_price]
      );
    }
    await client.query('SELECT fn_recalc_invoice($1)', [invoiceId]);
  }

  function dbError(res, err, fallback) {
    if (err.code === 'P0003') return res.status(409).json({ error: err.message });
    if (err.code === '23514') return res.status(400).json({ error: 'Invalid invoice: check the due date is not before the invoice date and all amounts are valid.' });
    if (err.code === '23503') return res.status(400).json({ error: 'A referenced employee, department, vendor, device or catalogue item does not exist.' });
    if (err.code === '22003') return res.status(400).json({ error: 'An amount is too large.' });
    console.error('[INVOICES]', fallback, err.message);
    return res.status(500).json({ error: fallback });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  const LIST_SELECT = `
    SELECT i.id, i.invoice_type, i.invoice_number, i.status, i.invoice_date, i.due_date,
           i.currency, i.subtotal, i.tax_amount, i.total, i.vendor, i.vendor_invoice_number,
           i.department, i.employee_id, i.created_at, i.issued_at, i.paid_at, i.voided_at,
           e.full_name AS employee_name, e.employee_code,
           CASE WHEN i.invoice_type = 'Purchase' THEN i.vendor
                ELSE COALESCE(e.full_name, i.department) END AS party,
           (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id)::int    AS line_count,
           (SELECT COUNT(*) FROM invoice_receipts r WHERE r.invoice_id = i.id)::int AS receipt_count,
           (SELECT ar.request_no FROM approval_requests ar
             WHERE ar.action = 'invoice.issue' AND ar.status = 'Pending'
               AND ar.payload->>'invoice_id' = i.id::text LIMIT 1)                  AS pending_request_no
    FROM invoices i
    LEFT JOIN employees e ON e.id = i.employee_id`;

  function listFilters(q) {
    const conds = [], params = [];
    if (q.type) {
      if (!PREFIX[q.type]) return { error: 'type must be Chargeback or Purchase.' };
      params.push(q.type); conds.push(`i.invoice_type = $${params.length}`);
    }
    if (q.status) {
      if (!['Draft', 'Issued', 'Paid', 'Void'].includes(q.status)) return { error: 'Invalid status.' };
      params.push(q.status); conds.push(`i.status = $${params.length}`);
    }
    if (q.search) {
      params.push(`%${sanitizeStr(q.search)}%`);
      const n = params.length;
      conds.push(`(i.invoice_number ILIKE $${n} OR i.vendor ILIKE $${n} OR i.vendor_invoice_number ILIKE $${n}
                   OR i.department ILIKE $${n} OR e.full_name ILIKE $${n} OR e.employee_code ILIKE $${n})`);
    }
    return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
  }

  router.get('/', can('invoices:read'), async (req, res) => {
    const f = listFilters(req.query);
    if (f.error) return res.status(400).json({ error: f.error });
    const params = [...f.params,
      Math.min(parseInt(req.query.limit, 10) || 100, 500),
      Math.max(parseInt(req.query.offset, 10) || 0, 0)];
    try {
      const { rows } = await query(
        `${LIST_SELECT} ${f.where}
         ORDER BY i.invoice_date DESC, i.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return res.json({ invoices: rows, count: rows.length });
    } catch (err) {
      console.error('[INVOICES] GET error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve invoices.' });
    }
  });

  router.get('/export.csv', can('invoices:read'), async (req, res) => {
    const f = listFilters(req.query);
    if (f.error) return res.status(400).json({ error: f.error });
    try {
      const { rows } = await query(`${LIST_SELECT} ${f.where} ORDER BY i.invoice_date DESC, i.created_at DESC`, f.params);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="edims-invoices-${Date.now()}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      stringify(rows, {
        header: true,
        columns: [
          { key: 'invoice_number', header: 'Invoice Number' }, { key: 'invoice_type', header: 'Type' },
          { key: 'status', header: 'Status' }, { key: 'invoice_date', header: 'Invoice Date' },
          { key: 'due_date', header: 'Due Date' }, { key: 'party', header: 'Billed To / Vendor' },
          { key: 'employee_code', header: 'Employee Code' }, { key: 'department', header: 'Department' },
          { key: 'vendor_invoice_number', header: 'Vendor Invoice #' }, { key: 'currency', header: 'Currency' },
          { key: 'subtotal', header: 'Subtotal' }, { key: 'tax_amount', header: 'Tax' }, { key: 'total', header: 'Total' },
          { key: 'line_count', header: 'Lines' }, { key: 'receipt_count', header: 'Receipts' },
        ],
      }).pipe(res);
    } catch (err) {
      console.error('[INVOICES] CSV error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed.' });
    }
  });

  async function loadInvoice(id) {
    const { rows: [inv] } = await query(
      `SELECT i.*, e.full_name AS employee_name, e.employee_code, e.email AS employee_email,
              v.address AS vendor_address, v.email AS vendor_email, v.phone AS vendor_phone,
              ui.username AS issued_by_username, up.username AS paid_by_username,
              uv.username AS voided_by_username, uc.username AS created_by_username,
              (SELECT ar.request_no FROM approval_requests ar
                WHERE ar.action = 'invoice.issue' AND ar.status = 'Pending'
                  AND ar.payload->>'invoice_id' = i.id::text LIMIT 1) AS pending_request_no
       FROM invoices i
       LEFT JOIN employees e ON e.id = i.employee_id
       LEFT JOIN vendors   v ON v.name = i.vendor
       LEFT JOIN users ui ON ui.id = i.issued_by
       LEFT JOIN users up ON up.id = i.paid_by
       LEFT JOIN users uv ON uv.id = i.voided_by
       LEFT JOIN users uc ON uc.id = i.created_by
       WHERE i.id = $1`, [id]);
    if (!inv) return null;
    const { rows: lines } = await query(
      `SELECT l.*, a.asset_tag FROM invoice_lines l
       LEFT JOIN assets a ON a.id = l.asset_id
       WHERE l.invoice_id = $1 ORDER BY l.line_no`, [id]);
    inv.lines = lines;
    return inv;
  }

  router.get('/:id', can('invoices:read'), async (req, res) => {
    if (!isUUID(req.params.id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
    try {
      const inv = await loadInvoice(req.params.id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
      return res.json({ invoice: inv });
    } catch (err) {
      console.error('[INVOICES] GET one error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve invoice.' });
    }
  });

  // ── Draft create / edit / delete ──────────────────────────────────────────
  router.post('/', can('invoices:write'), async (req, res) => {
    try {
      const p = await prepare(req.body || {}, null);
      if (p.error) return res.status(400).json({ error: p.error });
      const h = { currency: DEFAULT_CURRENCY, ...p.header, invoice_type: p.type };
      const cols = Object.keys(h);
      const id = await withTransaction(async (client) => {
        const { rows: [inv] } = await client.query(
          `INSERT INTO invoices (${cols.join(',')}, created_by)
           VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}) RETURNING id`,
          [...cols.map(c => h[c]), req.session.userId]
        );
        await writeLines(client, inv.id, p.lines || []);
        return inv.id;
      });
      return res.status(201).json({ invoice: await loadInvoice(id) });
    } catch (err) {
      return dbError(res, err, 'Failed to create invoice.');
    }
  });

  router.put('/:id', can('invoices:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
    try {
      const { rows: [existing] } = await query('SELECT * FROM invoices WHERE id=$1', [id]);
      if (!existing) return res.status(404).json({ error: 'Invoice not found.' });
      if (existing.status !== 'Draft')
        return res.status(409).json({ error: `Invoice ${existing.invoice_number} is ${existing.status} and can no longer be edited.` });
      const pending = await pendingIssue(id);
      if (pending) return res.status(409).json({ error: `This draft is awaiting approval to be issued (REQ-${pending}). Cancel that request to edit it.` });
      const p = await prepare(req.body || {}, existing);
      if (p.error) return res.status(400).json({ error: p.error });
      await withTransaction(async (client) => {
        const { rows: [locked] } = await client.query('SELECT status FROM invoices WHERE id=$1 FOR UPDATE', [id]);
        if (locked.status !== 'Draft') throw Object.assign(new Error('Invoice was issued meanwhile.'), { code: 'P0003' });
        const cols = Object.keys(p.header);
        if (cols.length) {
          await client.query(
            `UPDATE invoices SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(',')}, updated_at=NOW()
             WHERE id=$${cols.length + 1}`,
            [...cols.map(c => p.header[c]), id]
          );
        }
        if (p.lines) await writeLines(client, id, p.lines);
        else await client.query('SELECT fn_recalc_invoice($1)', [id]); // tax rate may have changed
      });
      return res.json({ invoice: await loadInvoice(id) });
    } catch (err) {
      return dbError(res, err, 'Failed to update invoice.');
    }
  });

  router.delete('/:id', can('invoices:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
    try {
      const pending = await pendingIssue(id);
      if (pending) return res.status(409).json({ error: `This draft is awaiting approval to be issued (REQ-${pending}). Cancel that request first.` });
      const { rowCount } = await query('DELETE FROM invoices WHERE id=$1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'Invoice not found.' });
      return res.json({ success: true });
    } catch (err) {
      return dbError(res, err, 'Failed to delete invoice.');
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  // Issuing goes through approval ('invoice.issue'); runIssue is what runs,
  // either straight away or once an Admin approves.
  async function runIssue({ invoice_id: id }, ctx) {
    try {
      const result = await withTransaction(async (client) => {
        const { rows: [inv] } = await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id]);
        if (!inv) return { status: 404, error: 'Invoice not found.' };
        if (inv.status !== 'Draft') return { status: 409, error: `Invoice is already ${inv.status}.` };
        const { rows: lines } = await client.query(
          'SELECT asset_id, unit_price FROM invoice_lines WHERE invoice_id=$1', [id]);
        if (!lines.length) return { status: 400, error: 'Add at least one line before issuing.' };

        const { rows: [{ num }] } = await client.query(
          'SELECT fn_next_invoice_number($1, EXTRACT(YEAR FROM $2::date)::int) AS num',
          [PREFIX[inv.invoice_type], inv.invoice_date]
        );
        await client.query(
          `UPDATE invoices SET status='Issued', invoice_number=$1, issued_at=NOW(), issued_by=$2, updated_at=NOW()
           WHERE id=$3`, [num, ctx.userId, id]);

        for (const l of lines.filter(x => x.asset_id)) {
          // Purchase invoices fill in a device's purchase price/date if it has none yet
          if (inv.invoice_type === 'Purchase') {
            await client.query(
              `UPDATE assets SET purchase_price = COALESCE(purchase_price, $1),
                                 purchase_date  = COALESCE(purchase_date, $2), updated_at = NOW()
               WHERE id = $3`, [l.unit_price, inv.invoice_date, l.asset_id]);
          }
          await client.query(
            `INSERT INTO asset_history (asset_id, event_type, old_status, new_status, employee_id, performed_by, notes, metadata)
             SELECT a.id, $1, a.status, a.status, $2, $3, $4, $5 FROM assets a WHERE a.id = $6`,
            [inv.invoice_type === 'Purchase' ? 'Purchase Invoiced' : 'Charged',
             inv.employee_id, ctx.userId,
             `${inv.invoice_type === 'Purchase' ? 'Purchased on' : 'Charged on'} invoice ${num}` + approvals.approvalNote(ctx),
             { invoice_id: id, invoice_number: num }, l.asset_id]);
        }
        return { num };
      });
      if (result.error) return { status: result.status, body: { error: result.error } };
      return { status: 200, body: { invoice: await loadInvoice(id) } };
    } catch (err) {
      if (err.code === 'P0003') return { status: 409, body: { error: err.message } };
      console.error('[INVOICES] Issue error:', err.message);
      return { status: 500, body: { error: 'Failed to issue invoice.' } };
    }
  }
  approvals.register('invoice.issue', runIssue);

  // A draft with an issue request awaiting approval is frozen, so the Admin
  // approves exactly what they reviewed.
  async function pendingIssue(id) {
    const { rows: [p] } = await query(
      `SELECT request_no FROM approval_requests
       WHERE action='invoice.issue' AND status='Pending' AND payload->>'invoice_id' = $1`, [id]);
    return p ? p.request_no : null;
  }

  router.post('/:id/issue', can('invoices:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
    try {
      const inv = await loadInvoice(id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
      if (inv.status !== 'Draft') return res.status(409).json({ error: `Invoice is already ${inv.status}.` });
      if (!inv.lines.length) return res.status(400).json({ error: 'Add at least one line before issuing.' });
      if (await approvals.needed(req, 'invoice.issue')) {
        const pending = await pendingIssue(id);
        if (pending) return res.status(409).json({ error: `This invoice is already awaiting approval (REQ-${pending}).` });
        const party = inv.invoice_type === 'Purchase' ? inv.vendor : (inv.employee_name || inv.department);
        return approvals.submit(req, res, 'invoice.issue', { invoice_id: id },
          `Issue ${inv.invoice_type.toLowerCase()} invoice — ${party} — ${money(inv.total, inv.currency)} (${inv.lines.length} line${inv.lines.length === 1 ? '' : 's'})`,
          { details: { invoice_id: id, total: inv.total, currency: inv.currency } });
      }
      const out = await runIssue({ invoice_id: id }, { userId: req.session.userId });
      return res.status(out.status).json(out.body);
    } catch (err) {
      return dbError(res, err, 'Failed to issue invoice.');
    }
  });

  router.post('/:id/pay', can('invoices:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
    const ref = sanitizeStr(req.body && req.body.payment_reference);
    if (ref && ref.length > 200) return res.status(400).json({ error: 'payment_reference is limited to 200 characters.' });
    try {
      const { rowCount } = await query(
        `UPDATE invoices SET status='Paid', paid_at=NOW(), paid_by=$1, payment_reference=$2, updated_at=NOW()
         WHERE id=$3 AND status='Issued'`, [req.session.userId, ref || null, id]);
      if (!rowCount) return res.status(409).json({ error: 'Only an Issued invoice can be marked paid.' });
      return res.json({ invoice: await loadInvoice(id) });
    } catch (err) {
      return dbError(res, err, 'Failed to mark invoice paid.');
    }
  });

  router.post('/:id/void', can('invoices:void'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
    const reason = sanitizeStr(req.body && req.body.reason);
    if (!reason) return res.status(400).json({ error: 'A reason is required to void an invoice.' });
    if (reason.length > 500) return res.status(400).json({ error: 'reason is limited to 500 characters.' });
    try {
      const { rowCount } = await query(
        `UPDATE invoices SET status='Void', voided_at=NOW(), voided_by=$1, void_reason=$2, updated_at=NOW()
         WHERE id=$3 AND status IN ('Issued','Paid')`, [req.session.userId, reason, id]);
      if (!rowCount) return res.status(409).json({ error: 'Only an Issued or Paid invoice can be voided (delete a draft instead).' });
      return res.json({ invoice: await loadInvoice(id) });
    } catch (err) {
      return dbError(res, err, 'Failed to void invoice.');
    }
  });

  // ── PDF ───────────────────────────────────────────────────────────────────
  router.get('/:id/pdf', can('invoices:read'), async (req, res) => {
    if (!isUUID(req.params.id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
    try {
      const inv = await loadInvoice(req.params.id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
      const fileName = (inv.invoice_number || `DRAFT-${inv.id.slice(0, 8)}`).replace(/[^A-Za-z0-9-]/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, bufferPages: true });
      doc.pipe(res);
      renderInvoicePdf(doc, inv);
      doc.end();
    } catch (err) {
      console.error('[INVOICES] PDF error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to generate invoice PDF.' });
    }
  });

  return router;
};

// =============================================================================
// PDF layout
// =============================================================================
function renderInvoicePdf(doc, inv) {
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;
  const cur = inv.currency;
  const ink = '#111827', muted = '#6b7280', rule = '#d1d5db', accent = '#0e7490';

  // Header: organisation (left), document title + number (right)
  const org = process.env.ORG_NAME || 'EDIMS';
  const orgAddr = (process.env.ORG_ADDRESS || '').split('|').map(s => s.trim()).filter(Boolean);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(ink).text(org, L, 50, { width: W / 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor(muted);
  orgAddr.forEach(line => doc.text(line, { width: W / 2 }));

  const title = inv.invoice_type === 'Purchase' ? 'PURCHASE INVOICE' : 'INVOICE';
  doc.font('Helvetica-Bold').fontSize(18).fillColor(accent).text(title, L + W / 2, 50, { width: W / 2, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(ink)
     .text(inv.invoice_number || 'DRAFT — not yet numbered', L + W / 2, doc.y + 2, { width: W / 2, align: 'right' });

  const meta = [
    ['Status', inv.status],
    ['Invoice date', fmtDate(inv.invoice_date)],
    ['Due date', fmtDate(inv.due_date)],
  ];
  if (inv.invoice_type === 'Purchase' && inv.vendor_invoice_number) meta.push(["Vendor's invoice #", inv.vendor_invoice_number]);
  if (inv.status === 'Paid') meta.push(['Paid', fmtDate(inv.paid_at) + (inv.payment_reference ? ` · ${inv.payment_reference}` : '')]);
  doc.moveDown(0.4);
  meta.forEach(([k, v]) => {
    const y = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(k, L + W / 2, y, { width: W / 4, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(v, L + W * 0.75 + 6, y, { width: W / 4 - 6, align: 'right' });
  });

  // Party block
  let y = Math.max(doc.y, 140) + 16;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.6).strokeColor(rule).stroke();
  y += 10;
  const partyLabel = inv.invoice_type === 'Purchase' ? 'FROM (VENDOR)' : 'BILL TO';
  const party = inv.invoice_type === 'Purchase'
    ? [inv.vendor, inv.vendor_address, inv.vendor_email, inv.vendor_phone]
    : [inv.employee_name && `${inv.employee_name}${inv.employee_code ? ` (${inv.employee_code})` : ''}`,
       inv.department && `Department: ${inv.department}`, inv.employee_email];
  doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(partyLabel, L, y);
  doc.font('Helvetica').fontSize(10).fillColor(ink);
  party.filter(Boolean).forEach(line => doc.text(line, L, doc.y + 1, { width: W / 2 }));

  // Lines table
  y = doc.y + 18;
  const cols = [
    { key: 'line_no',     header: '#',           w: 22,  align: 'left' },
    { key: 'description', header: 'Description', w: W - 22 - 70 - 45 - 85 - 90, align: 'left' },
    { key: 'asset_tag',   header: 'Asset tag',   w: 70,  align: 'left' },
    { key: 'quantity',    header: 'Qty',         w: 45,  align: 'right' },
    { key: 'unit_price',  header: 'Unit price',  w: 85,  align: 'right' },
    { key: 'line_total',  header: 'Amount',      w: 90,  align: 'right' },
  ];
  const header = (yy) => {
    doc.rect(L, yy, W, 18).fill('#ecfeff');
    let x = L;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(accent);
    cols.forEach(c => { doc.text(c.header, x + 4, yy + 5, { width: c.w - 8, align: c.align }); x += c.w; });
    return yy + 18;
  };
  y = header(y);
  const cell = (c, l) => {
    if (c.key === 'unit_price' || c.key === 'line_total') return money(l[c.key], cur);
    if (c.key === 'quantity') return Number(l.quantity).toString();
    return l[c.key] == null ? '' : String(l[c.key]);
  };
  inv.lines.forEach((l, i) => {
    doc.font('Helvetica').fontSize(8.5);
    const h = Math.max(16, doc.heightOfString(l.description, { width: cols[1].w - 8 }) + 8);
    if (y + h > doc.page.height - doc.page.margins.bottom - 120) { doc.addPage(); y = header(doc.page.margins.top); }
    if (i % 2) doc.rect(L, y, W, h).fill('#f9fafb');
    let x = L;
    cols.forEach(c => {
      doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(cell(c, l), x + 4, y + 4, { width: c.w - 8, align: c.align });
      x += c.w;
    });
    y += h;
  });
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.6).strokeColor(rule).stroke();

  // Totals
  y += 8;
  const tot = [
    ['Subtotal', money(inv.subtotal, cur), false],
    [`Tax (${Number(inv.tax_rate)}%)`, money(inv.tax_amount, cur), false],
    ['Total', money(inv.total, cur), true],
  ];
  tot.forEach(([k, v, bold]) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(ink);
    doc.text(k, R - 250, y, { width: 140, align: 'right' });
    doc.text(v, R - 105, y, { width: 105, align: 'right' });
    y += bold ? 18 : 14;
  });

  if (inv.notes) {
    y += 10;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('NOTES', L, y);
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(inv.notes, L, doc.y + 2, { width: W });
  }
  if (inv.status === 'Void') {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#b91c1c')
       .text(`VOIDED ${fmtDate(inv.voided_at)} by ${inv.voided_by_username || '—'}: ${inv.void_reason || ''}`, L, doc.y, { width: W });
  }

  // Stamp for anything that isn't a live, payable document
  const stamp = { Draft: ['DRAFT', '#9ca3af'], Void: ['VOID', '#dc2626'], Paid: ['PAID', '#16a34a'] }[inv.status];
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    doc.page.margins.bottom = 0; // footer sits below the margin; don't let it spawn a page
    if (stamp) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica-Bold').fontSize(90).fillColor(stamp[1]).fillOpacity(0.12)
         .text(stamp[0], 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center', lineBreak: false });
      doc.restore();
    }
    doc.font('Helvetica').fontSize(7).fillColor(muted).fillOpacity(1)
       .text(`${inv.invoice_number || 'Draft'} · Page ${p - range.start + 1} of ${range.count} · Generated by EDIMS`,
             L, doc.page.height - 35, { width: W, align: 'center', lineBreak: false });
  }
}
