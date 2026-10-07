'use strict';
// =============================================================================
// EDIMS — routes/catalog.js
// Product catalogue — the approved models devices are registered from.
//   GET    /api/catalog?category_id=&search=&active=1
//   GET    /api/catalog/:id
//   POST   /api/catalog
//   PUT    /api/catalog/:id
//   DELETE /api/catalog/:id     (only when no device uses it)
// =============================================================================

const express = require('express');
const { sanitizeStr, sanitizeObj, isUUID, parseNumber } = require('../lib/helpers');

const FIELDS = ['category_id', 'vendor', 'model', 'part_number', 'description', 'specs',
                'standard_price', 'warranty_months', 'depreciation_years', 'image_url', 'source_url'];

// Only images the scraper cached locally — CSP blocks anything else anyway
const LOCAL_IMAGE = /^\/images\/hardware\/[a-z0-9._-]+\.webp$/i;

// specs: flat { "RAM": "16 GB", ... } — up to 60 keys, values capped
function cleanSpecs(specs) {
  if (specs === undefined) return { value: undefined };
  if (specs === null || specs === '') return { value: {} };
  if (typeof specs !== 'object' || Array.isArray(specs)) return { error: 'specs must be an object of name → value.' };
  const entries = Object.entries(specs);
  if (entries.length > 60) return { error: 'specs can have at most 60 entries.' };
  const out = {};
  for (const [k, v] of entries) {
    const key = sanitizeStr(k).slice(0, 100);
    if (key) out[key] = sanitizeStr(v == null ? '' : v).slice(0, 500);
  }
  return { value: out };
}

module.exports = function catalogRoutes({ query, checkSubcategory, checkReference }, can) {
  const router = express.Router();

  // Validates + normalises a create/update body. Returns { b } or { error }.
  async function prepare(body, isCreate) {
    const b = sanitizeObj(body, [...FIELDS, ...(isCreate ? [] : ['is_active'])]);
    for (const k of ['vendor', 'part_number', 'description', 'image_url', 'source_url']) {
      if (b[k] === '') b[k] = null;
    }
    if (isCreate && (!b.category_id || !b.model)) return { error: 'category_id and model are required.' };
    if (b.model !== undefined && !b.model) return { error: 'model cannot be empty.' };
    if (b.is_active !== undefined && typeof b.is_active !== 'boolean') return { error: 'is_active must be true or false.' };
    if (b.image_url && !LOCAL_IMAGE.test(b.image_url)) return { error: 'image_url must be a cached hardware image (/images/hardware/….webp).' };
    if (b.source_url && !/^https:\/\/\S+$/i.test(b.source_url)) return { error: 'source_url must be an https:// URL.' };

    for (const [k, opts] of [
      ['standard_price', {}],
      ['warranty_months', { max: 240, integer: true }],
      ['depreciation_years', { max: 50, integer: true }],
    ]) {
      if (b[k] === undefined) continue;
      const n = parseNumber(b[k], k, opts);
      if (n.error) return { error: n.error };
      b[k] = n.value ?? null;
    }
    const specs = cleanSpecs(b.specs);
    if (specs.error) return { error: specs.error };
    if (specs.value !== undefined) b.specs = JSON.stringify(specs.value);

    if (b.category_id !== undefined) {
      const e = await checkSubcategory(b.category_id, { requireActive: isCreate });
      if (e) return { error: e };
    }
    if (b.vendor !== undefined) {
      const e = await checkReference('vendors', b, 'vendor', 'Vendor', { allowInactive: !isCreate });
      if (e) return { error: e };
    }
    return { b };
  }

  function dbError(res, err, fallback) {
    if (err.code === '23505') return res.status(409).json({ error: 'That model is already in the catalogue for this category and vendor.' });
    if (err.code === '23514') return res.status(400).json({ error: 'A value is out of range.' });
    if (err.code === 'P0003') return res.status(400).json({ error: err.message });
    console.error('[CATALOG]', fallback, err.message);
    return res.status(500).json({ error: fallback });
  }

  const SELECT = `
    SELECT ci.*, cp.category, cp.subcategory, cp.is_active AS category_active,
           (SELECT COUNT(*) FROM assets a WHERE a.catalog_item_id = ci.id)::int AS asset_count
    FROM catalog_items ci
    JOIN device_category_paths cp ON cp.id = ci.category_id`;

  router.get('/', can('assets:read'), async (req, res) => {
    const { category_id, search, active } = req.query;
    const conds = [], params = [];
    if (category_id) {
      if (!isUUID(category_id)) return res.status(400).json({ error: 'Invalid category_id.' });
      params.push(category_id);
      conds.push(`(cp.id=$${params.length} OR cp.parent_id=$${params.length})`);
    }
    if (search) {
      params.push(`%${sanitizeStr(search)}%`);
      const n = params.length;
      conds.push(`(ci.model ILIKE $${n} OR ci.vendor ILIKE $${n} OR ci.part_number ILIKE $${n} OR ci.description ILIKE $${n})`);
    }
    if (active === '1') conds.push('ci.is_active AND cp.is_active');
    try {
      const { rows } = await query(
        `${SELECT} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
         ORDER BY cp.category_sort, cp.category, cp.subcategory_sort, cp.subcategory,
                  lower(COALESCE(ci.vendor,'')), lower(ci.model)
         LIMIT 1000`,
        params
      );
      return res.json({ items: rows });
    } catch (err) {
      console.error('[CATALOG] GET error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve catalogue.' });
    }
  });

  router.get('/:id', can('assets:read'), async (req, res) => {
    if (!isUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      const { rows: [item] } = await query(`${SELECT} WHERE ci.id=$1`, [req.params.id]);
      if (!item) return res.status(404).json({ error: 'Catalogue item not found.' });
      return res.json({ item });
    } catch (err) {
      console.error('[CATALOG] GET one error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve catalogue item.' });
    }
  });

  router.post('/', can('catalog:write'), async (req, res) => {
    try {
      const { b, error } = await prepare(req.body, true);
      if (error) return res.status(400).json({ error });
      const cols = Object.keys(b);
      const { rows } = await query(
        `INSERT INTO catalog_items (${cols.join(',')}, created_by)
         VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}) RETURNING *`,
        [...cols.map(c => b[c]), req.session.userId]
      );
      return res.status(201).json({ item: rows[0] });
    } catch (err) {
      return dbError(res, err, 'Failed to create catalogue item.');
    }
  });

  router.put('/:id', can('catalog:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      const { b, error } = await prepare(req.body, false);
      if (error) return res.status(400).json({ error });
      const cols = Object.keys(b);
      if (!cols.length) return res.status(400).json({ error: 'No fields to update.' });
      const { rows, rowCount } = await query(
        `UPDATE catalog_items SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(',')}, updated_at=NOW()
         WHERE id=$${cols.length + 1} RETURNING *`,
        [...cols.map(c => b[c]), id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Catalogue item not found.' });
      return res.json({ item: rows[0] });
    } catch (err) {
      return dbError(res, err, 'Failed to update catalogue item.');
    }
  });

  router.delete('/:id', can('catalog:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid ID.' });
    try {
      const { rows: [u] } = await query(
        'SELECT COUNT(*)::int AS n FROM assets WHERE catalog_item_id=$1', [id]
      );
      if (u.n) return res.status(409).json({ error: `${u.n} device(s) were registered from this model. Deactivate it instead.` });
      const { rowCount } = await query('DELETE FROM catalog_items WHERE id=$1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'Catalogue item not found.' });
      return res.json({ success: true });
    } catch (err) {
      return dbError(res, err, 'Failed to delete catalogue item.');
    }
  });

  return router;
};
