'use strict';
// =============================================================================
// EDIMS — routes/labels.js
// Barcodes, QR codes and printable asset labels.
//   GET /api/labels/:assetId/qr.png | qr.svg            QR → link to the device
//   GET /api/labels/:assetId/barcode.png | barcode.svg  Code 128 of the asset tag
//   GET /api/labels/:assetId/label.pdf                  one 3" × 1.5" label
//   GET /api/labels/sheet.pdf?ids=<uuid>,<uuid>,…        A4 sheet, 3 × 8 labels
// Add ?download=1 to any image to get it as an attachment instead of inline.
//
// The QR code encodes <PUBLIC_URL or this server's origin>/#asset=<tag>; the
// app opens that device when the link is scanned. The barcode encodes just
// the tag, so a USB scanner can type it straight into any search box.
// =============================================================================

const express     = require('express');
const QRCode      = require('qrcode');
const bwipjs      = require('bwip-js');
const PDFDocument = require('pdfkit');
const { isUUID }  = require('../lib/helpers');

const MAX_SHEET = 240; // 10 A4 pages

function assetUrl(req, tag) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/#asset=${encodeURIComponent(tag)}`;
}

// Code 128 handles printable ASCII only
function barcodeText(tag) {
  if (!/^[\x20-\x7E]+$/.test(tag)) throw Object.assign(new Error('Asset tag has characters a Code 128 barcode cannot encode (ASCII only).'), { status: 400 });
  return tag;
}

const qrPng  = (text, width = 300) => QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 1, width });
const qrSvg  = (text) => QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
const barPng = (tag) => bwipjs.toBuffer({ bcid: 'code128', text: barcodeText(tag), scale: 3, height: 12, paddingwidth: 4, paddingheight: 2, backgroundcolor: 'FFFFFF' });
const barSvg = (tag) => bwipjs.toSVG({ bcid: 'code128', text: barcodeText(tag), height: 12, paddingwidth: 4, paddingheight: 2, backgroundcolor: 'FFFFFF' });

// One label at (x, y) of size w × h points: QR on the left; tag, category,
// model and barcode on the right.
function drawLabel(doc, x, y, w, h, a, qr, bar, { border = false } = {}) {
  const pad = Math.max(4, h * 0.06);
  const q   = h - pad * 2;
  doc.save();
  if (border) doc.lineWidth(0.4).strokeColor('#bbbbbb').rect(x, y, w, h).stroke();
  doc.image(qr, x + pad, y + pad, { width: q, height: q });

  const tx = x + pad * 2 + q;
  const tw = w - (tx - x) - pad;
  let ty = y + pad;
  const t = (str, font, size, color) => {
    doc.font(font).fontSize(size).fillColor(color)
       .text(str || '', tx, ty, { width: tw, height: size * 1.25, ellipsis: true, lineBreak: false });
    ty += size * 1.3;
  };
  t(a.asset_tag, 'Helvetica-Bold', h * 0.12, '#000000');
  t(a.category_path, 'Helvetica', h * 0.075, '#444444');
  t([a.vendor, a.model].filter(Boolean).join(' '), 'Helvetica', h * 0.075, '#444444');
  t('S/N ' + a.serial_number, 'Helvetica', h * 0.07, '#666666');

  const bh = y + h - pad - ty;
  if (bh > 8) doc.image(bar, tx, ty, { fit: [tw, bh], align: 'left', valign: 'bottom' });
  doc.restore();
}

module.exports = function labelRoutes({ query }, can) {
  const router = express.Router();

  async function loadAssets(ids) {
    const { rows } = await query(
      `SELECT a.id, a.asset_tag, a.serial_number, a.vendor, a.model, cp.path AS category_path
       FROM assets a JOIN device_category_paths cp ON cp.id = a.category_id
       WHERE a.id = ANY($1::uuid[])`,
      [ids]
    );
    // keep the caller's order
    const byId = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  }

  function sendImage(req, res, type, filename, body) {
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
    res.send(body);
  }

  const safeName = (tag) => tag.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'asset';

  function fail(res, err, what) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(`[LABELS] ${what} error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: `Failed to generate ${what}.` });
  }

  // Sheet route first so "sheet.pdf" isn't read as an asset id
  router.get('/sheet.pdf', can('assets:read'), async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids is required (comma-separated asset IDs).' });
    if (ids.length > MAX_SHEET) return res.status(400).json({ error: `At most ${MAX_SHEET} labels per sheet.` });
    if (!ids.every(isUUID)) return res.status(400).json({ error: 'Invalid asset ID in ids.' });
    try {
      const assets = await loadAssets([...new Set(ids)]);
      if (!assets.length) return res.status(404).json({ error: 'No matching assets.' });
      const images = await Promise.all(assets.map(async a => [await qrPng(assetUrl(req, a.asset_tag), 240), await barPng(a.asset_tag)]));

      // A4 portrait, 3 × 8 grid of 63.5 × 33.9 mm labels (Avery L7159 layout)
      const mm = 72 / 25.4;
      const cols = 3, rows = 8, w = 63.5 * mm, h = 33.9 * mm;
      const left = 7.2 * mm, top = 12.9 * mm, gapX = 2.5 * mm;
      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="edims-labels-${Date.now()}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      doc.pipe(res);
      assets.forEach((a, i) => {
        const slot = i % (cols * rows);
        if (slot === 0) doc.addPage();
        const cx = left + (slot % cols) * (w + gapX);
        const cy = top + Math.floor(slot / cols) * h;
        // faint outline as a cutting guide (plain paper); label stock is pre-cut
        drawLabel(doc, cx, cy, w, h, a, images[i][0], images[i][1], { border: req.query.outline === '1' });
      });
      doc.end();
    } catch (err) {
      fail(res, err, 'label sheet');
    }
  });

  router.get('/:assetId/:file', can('assets:read'), async (req, res) => {
    const { assetId, file } = req.params;
    if (!isUUID(assetId)) return res.status(400).json({ error: 'Invalid asset ID.' });
    if (!['qr.png', 'qr.svg', 'barcode.png', 'barcode.svg', 'label.pdf'].includes(file))
      return res.status(404).json({ error: 'Unknown label file.' });
    try {
      const [a] = await loadAssets([assetId]);
      if (!a) return res.status(404).json({ error: 'Asset not found.' });
      const name = safeName(a.asset_tag);
      const url  = assetUrl(req, a.asset_tag);

      if (file === 'qr.png')      return sendImage(req, res, 'image/png', `${name}-qr.png`, await qrPng(url));
      if (file === 'qr.svg')      return sendImage(req, res, 'image/svg+xml', `${name}-qr.svg`, await qrSvg(url));
      if (file === 'barcode.png') return sendImage(req, res, 'image/png', `${name}-barcode.png`, await barPng(a.asset_tag));
      if (file === 'barcode.svg') return sendImage(req, res, 'image/svg+xml', `${name}-barcode.svg`, barSvg(a.asset_tag));

      const [qr, bar] = [await qrPng(url, 240), await barPng(a.asset_tag)];
      const w = 216, h = 108; // 3" × 1.5"
      const doc = new PDFDocument({ size: [w, h], margin: 0 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${name}-label.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      doc.pipe(res);
      drawLabel(doc, 0, 0, w, h, a, qr, bar);
      doc.end();
    } catch (err) {
      fail(res, err, 'label');
    }
  });

  return router;
};
