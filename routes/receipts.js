'use strict';
// =============================================================================
// EDIMS — routes/receipts.js
// Receipt uploads (PDF / JPEG / PNG / WebP, max 10 MB), linked to devices
// and/or invoices.
//   POST   /api/receipts?filename=&description=&asset_ids=a,b&invoice_id=
//          body = the raw file bytes (Content-Type is ignored: the type is
//          detected from the file's own signature)
//   GET    /api/receipts?asset_id= | invoice_id= | unlinked=1
//   GET    /api/receipts/:id/file[?inline=1]
//   POST   /api/receipts/:id/links      { asset_id } | { invoice_id }
//   DELETE /api/receipts/:id/links?asset_id= | invoice_id=
//   DELETE /api/receipts/:id
// Files are stored under UPLOADS_DIR (default ./uploads/receipts) with
// random names, outside public/, and only served through this router.
// =============================================================================

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const express = require('express');
const { sanitizeStr, isUUID } = require('../lib/helpers');

const MAX_BYTES   = 10 * 1024 * 1024;
const RECEIPT_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'), 'receipts');
fs.mkdirSync(RECEIPT_DIR, { recursive: true });

// Identify the file from its magic bytes — never trust the client's type
function detectType(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

function cleanFilename(name, ext) {
  let base = sanitizeStr(name || '') || 'receipt';
  base = path.basename(base.replace(/\\/g, '/')).replace(/[^\w .()-]+/g, '_').slice(0, 150);
  if (!base.toLowerCase().endsWith(ext)) base = base.replace(/\.[^.]*$/, '') + ext;
  return base;
}

module.exports = function receiptRoutes({ query, withTransaction }, can, roleCan) {
  const router = express.Router();

  const SELECT = `
    SELECT r.id, r.original_name, r.mime_type, r.size_bytes, r.description, r.created_at,
           u.username AS uploaded_by_username,
           COALESCE((SELECT json_agg(json_build_object('id', a.id, 'asset_tag', a.asset_tag) ORDER BY a.asset_tag)
                     FROM asset_receipts ar JOIN assets a ON a.id = ar.asset_id
                     WHERE ar.receipt_id = r.id), '[]') AS assets,
           COALESCE((SELECT json_agg(json_build_object('id', i.id, 'invoice_number', i.invoice_number,
                                                       'invoice_type', i.invoice_type, 'status', i.status)
                                     ORDER BY i.created_at)
                     FROM invoice_receipts ir JOIN invoices i ON i.id = ir.invoice_id
                     WHERE ir.receipt_id = r.id), '[]') AS invoices
    FROM receipts r
    LEFT JOIN users u ON u.id = r.uploaded_by`;

  async function linkTargets(client, receiptId, assetIds, invoiceId, userId) {
    for (const aid of assetIds) {
      await client.query(
        `INSERT INTO asset_receipts (asset_id, receipt_id, linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [aid, receiptId, userId]
      );
    }
    if (invoiceId) {
      await client.query(
        `INSERT INTO invoice_receipts (invoice_id, receipt_id, linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [invoiceId, receiptId, userId]
      );
    }
  }

  // Validates ?asset_ids / ?invoice_id (or body equivalents). Returns { assetIds, invoiceId } or { error, status }.
  async function resolveTargets(req, rawAssetIds, rawInvoiceId) {
    const assetIds = [...new Set(String(rawAssetIds || '').split(',').map(s => s.trim()).filter(Boolean))];
    const invoiceId = rawInvoiceId ? String(rawInvoiceId).trim() : null;
    if (assetIds.length > 100) return { status: 400, error: 'At most 100 devices per receipt.' };
    if (!assetIds.every(isUUID) || (invoiceId && !isUUID(invoiceId))) return { status: 400, error: 'Invalid asset or invoice ID.' };
    if (invoiceId && !roleCan(req.session.role, 'invoices:write'))
      return { status: 403, error: 'Insufficient permissions to attach receipts to invoices.' };
    if (assetIds.length) {
      const { rows } = await query('SELECT COUNT(*)::int AS n FROM assets WHERE id = ANY($1::uuid[])', [assetIds]);
      if (rows[0].n !== assetIds.length) return { status: 400, error: 'One or more devices were not found.' };
    }
    if (invoiceId) {
      const { rowCount } = await query('SELECT 1 FROM invoices WHERE id=$1', [invoiceId]);
      if (!rowCount) return { status: 400, error: 'Invoice not found.' };
    }
    return { assetIds, invoiceId };
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  router.post('/',
    can('assets:write'),
    express.raw({ type: () => true, limit: MAX_BYTES }),
    async (req, res) => {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Send the file bytes as the request body.' });
      const type = detectType(buf);
      if (!type) return res.status(415).json({ error: 'Unsupported file. Upload a PDF, JPEG, PNG or WebP receipt.' });

      const description = sanitizeStr(req.query.description);
      if (description && description.length > 500) return res.status(400).json({ error: 'description is limited to 500 characters.' });

      let storedPath = null;
      try {
        const t = await resolveTargets(req, req.query.asset_ids, req.query.invoice_id);
        if (t.error) return res.status(t.status).json({ error: t.error });

        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

        // Same file uploaded before? Link the existing copy instead of storing it twice.
        const { rows: [dupe] } = await query('SELECT id FROM receipts WHERE sha256=$1 LIMIT 1', [sha256]);
        if (dupe) {
          await withTransaction(c => linkTargets(c, dupe.id, t.assetIds, t.invoiceId, req.session.userId));
          const { rows: [r] } = await query(`${SELECT} WHERE r.id=$1`, [dupe.id]);
          return res.status(200).json({ receipt: r, duplicate: true });
        }

        const storedName = crypto.randomUUID() + type.ext;
        storedPath = path.join(RECEIPT_DIR, storedName);
        await fs.promises.mkdir(RECEIPT_DIR, { recursive: true }); // in case it was removed since startup
        await fs.promises.writeFile(storedPath, buf, { flag: 'wx' });

        const id = await withTransaction(async (client) => {
          const { rows: [r] } = await client.query(
            `INSERT INTO receipts (original_name, stored_name, mime_type, size_bytes, sha256, description, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [cleanFilename(req.query.filename, type.ext), storedName, type.mime, buf.length, sha256,
             description || null, req.session.userId]
          );
          await linkTargets(client, r.id, t.assetIds, t.invoiceId, req.session.userId);
          return r.id;
        });
        const { rows: [r] } = await query(`${SELECT} WHERE r.id=$1`, [id]);
        return res.status(201).json({ receipt: r });
      } catch (err) {
        if (storedPath) fs.promises.unlink(storedPath).catch(() => {});
        console.error('[RECEIPTS] Upload error:', err.message);
        return res.status(500).json({ error: 'Failed to store receipt.' });
      }
    }
  );

  // ── List ──────────────────────────────────────────────────────────────────
  router.get('/', can('assets:read'), async (req, res) => {
    const { asset_id, invoice_id, unlinked } = req.query;
    const conds = [], params = [];
    if (asset_id) {
      if (!isUUID(asset_id)) return res.status(400).json({ error: 'Invalid asset_id.' });
      params.push(asset_id);
      conds.push(`EXISTS (SELECT 1 FROM asset_receipts x WHERE x.receipt_id=r.id AND x.asset_id=$${params.length})`);
    }
    if (invoice_id) {
      if (!isUUID(invoice_id)) return res.status(400).json({ error: 'Invalid invoice_id.' });
      params.push(invoice_id);
      conds.push(`EXISTS (SELECT 1 FROM invoice_receipts x WHERE x.receipt_id=r.id AND x.invoice_id=$${params.length})`);
    }
    if (unlinked === '1') {
      conds.push(`NOT EXISTS (SELECT 1 FROM asset_receipts x WHERE x.receipt_id=r.id)
                  AND NOT EXISTS (SELECT 1 FROM invoice_receipts x WHERE x.receipt_id=r.id)`);
    }
    try {
      const { rows } = await query(
        `${SELECT} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT 500`,
        params
      );
      return res.json({ receipts: rows });
    } catch (err) {
      console.error('[RECEIPTS] GET error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve receipts.' });
    }
  });

  // ── Download / view ───────────────────────────────────────────────────────
  router.get('/:id/file', can('assets:read'), async (req, res) => {
    if (!isUUID(req.params.id)) return res.status(400).json({ error: 'Invalid receipt ID.' });
    try {
      const { rows: [r] } = await query(
        'SELECT original_name, stored_name, mime_type FROM receipts WHERE id=$1', [req.params.id]
      );
      if (!r) return res.status(404).json({ error: 'Receipt not found.' });
      const file = path.join(RECEIPT_DIR, path.basename(r.stored_name));
      if (!fs.existsSync(file)) return res.status(410).json({ error: 'Receipt file is missing from storage.' });
      const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
      const ascii = r.original_name.replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_');
      res.setHeader('Content-Type', r.mime_type);
      res.setHeader('Content-Disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.original_name)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      // Opened directly in a tab: nothing in a receipt should run or load
      // anything. (`sandbox` stops Chrome's PDF viewer rendering, so images only.)
      res.setHeader('Content-Security-Policy',
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" + (r.mime_type.startsWith('image/') ? '; sandbox' : ''));
      return res.sendFile(file);
    } catch (err) {
      console.error('[RECEIPTS] Download error:', err.message);
      return res.status(500).json({ error: 'Failed to read receipt.' });
    }
  });

  // ── Link / unlink ─────────────────────────────────────────────────────────
  router.post('/:id/links', can('assets:write'), async (req, res) => {
    if (!isUUID(req.params.id)) return res.status(400).json({ error: 'Invalid receipt ID.' });
    const { asset_id, invoice_id } = req.body || {};
    if (!asset_id && !invoice_id) return res.status(400).json({ error: 'asset_id or invoice_id is required.' });
    try {
      const t = await resolveTargets(req, asset_id, invoice_id);
      if (t.error) return res.status(t.status).json({ error: t.error });
      const { rowCount } = await query('SELECT 1 FROM receipts WHERE id=$1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'Receipt not found.' });
      await withTransaction(c => linkTargets(c, req.params.id, t.assetIds, t.invoiceId, req.session.userId));
      const { rows: [r] } = await query(`${SELECT} WHERE r.id=$1`, [req.params.id]);
      return res.json({ receipt: r });
    } catch (err) {
      console.error('[RECEIPTS] Link error:', err.message);
      return res.status(500).json({ error: 'Failed to link receipt.' });
    }
  });

  router.delete('/:id/links', can('assets:write'), async (req, res) => {
    const { id } = req.params;
    const { asset_id, invoice_id } = req.query;
    if (!isUUID(id) || (asset_id && !isUUID(asset_id)) || (invoice_id && !isUUID(invoice_id)))
      return res.status(400).json({ error: 'Invalid ID.' });
    if (!asset_id && !invoice_id) return res.status(400).json({ error: 'asset_id or invoice_id is required.' });
    if (invoice_id && !roleCan(req.session.role, 'invoices:write'))
      return res.status(403).json({ error: 'Insufficient permissions.' });
    try {
      if (invoice_id) {
        const { rows: [inv] } = await query('SELECT status FROM invoices WHERE id=$1', [invoice_id]);
        if (inv && inv.status !== 'Draft')
          return res.status(409).json({ error: `Receipts on a ${inv.status} invoice are part of its record and can't be detached.` });
        await query('DELETE FROM invoice_receipts WHERE receipt_id=$1 AND invoice_id=$2', [id, invoice_id]);
      }
      if (asset_id) await query('DELETE FROM asset_receipts WHERE receipt_id=$1 AND asset_id=$2', [id, asset_id]);
      return res.json({ success: true });
    } catch (err) {
      console.error('[RECEIPTS] Unlink error:', err.message);
      return res.status(500).json({ error: 'Failed to unlink receipt.' });
    }
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  router.delete('/:id', can('assets:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid receipt ID.' });
    try {
      const { rows: [locked] } = await query(
        `SELECT i.invoice_number FROM invoice_receipts ir JOIN invoices i ON i.id = ir.invoice_id
         WHERE ir.receipt_id=$1 AND i.status <> 'Draft' LIMIT 1`, [id]
      );
      if (locked) return res.status(409).json({ error: `This receipt is part of invoice ${locked.invoice_number} and can't be deleted.` });
      const { rows: [r] } = await query('DELETE FROM receipts WHERE id=$1 RETURNING stored_name', [id]);
      if (!r) return res.status(404).json({ error: 'Receipt not found.' });
      fs.promises.unlink(path.join(RECEIPT_DIR, path.basename(r.stored_name))).catch(err =>
        console.error('[RECEIPTS] File cleanup failed:', err.message));
      return res.json({ success: true });
    } catch (err) {
      console.error('[RECEIPTS] Delete error:', err.message);
      return res.status(500).json({ error: 'Failed to delete receipt.' });
    }
  });

  return router;
};
