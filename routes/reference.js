'use strict';
// =============================================================================
// EDIMS — routes/reference.js
// Reference data: vendors and departments/locations.
//   GET/POST         /api/reference/vendors
//   PUT/DELETE       /api/reference/vendors/:id
//   GET/POST         /api/reference/locations
//   PUT/DELETE       /api/reference/locations/:id
// Other tables store these by name with ON UPDATE CASCADE, so a rename
// here renames every device, employee, catalogue item and invoice using it.
// =============================================================================

const express = require('express');
const { sanitizeObj, isUUID, isEmail } = require('../lib/helpers');

// Per-list config: which columns are editable and which tables use it.
const LISTS = {
  vendors: {
    label:  'Vendor',
    fields: ['name', 'contact_name', 'email', 'phone', 'address', 'website', 'notes'],
    usage: `SELECT
              (SELECT COUNT(*) FROM assets        WHERE vendor = $1)::int AS assets,
              (SELECT COUNT(*) FROM catalog_items WHERE vendor = $1)::int AS catalog_items,
              (SELECT COUNT(*) FROM invoices      WHERE vendor = $1)::int AS invoices`,
  },
  locations: {
    label:  'Department',
    fields: ['name', 'description'],
    usage: `SELECT
              (SELECT COUNT(*) FROM assets    WHERE location   = $1)::int AS assets,
              (SELECT COUNT(*) FROM employees WHERE department = $1)::int AS employees,
              (SELECT COUNT(*) FROM invoices  WHERE department = $1)::int AS invoices`,
  },
};

module.exports = function referenceRoutes({ query }, can) {
  const router = express.Router();

  function dbError(res, err, label, fallback) {
    if (err.code === '23505') return res.status(409).json({ error: `A ${label.toLowerCase()} with that name already exists.` });
    if (err.code === '23514') return res.status(400).json({ error: 'Name must be 1–200 characters with no leading/trailing spaces.' });
    if (err.code === '23503') return res.status(409).json({ error: `${label} is still in use. Deactivate it instead.` });
    console.error('[REFERENCE]', fallback, err.message);
    return res.status(500).json({ error: fallback });
  }

  function validate(b, table) {
    if (b.name !== undefined && !b.name) return 'name cannot be empty.';
    if (table === 'vendors') {
      if (b.email && !isEmail(b.email)) return 'Invalid email address.';
      if (b.website && !/^https?:\/\/\S+$/i.test(b.website)) return 'website must start with http:// or https://';
    }
    return null;
  }

  for (const [table, cfg] of Object.entries(LISTS)) {
    // GET — everything (inactive flagged) with how many records use each entry
    router.get(`/${table}`, can('assets:read'), async (req, res) => {
      try {
        const { rows } = await query(`SELECT * FROM ${table} ORDER BY lower(name)`, []);
        const usage = await Promise.all(rows.map(r => query(cfg.usage, [r.name])));
        rows.forEach((r, i) => {
          r.usage = usage[i].rows[0];
          r.in_use = Object.values(r.usage).reduce((a, b) => a + b, 0);
        });
        return res.json({ [table]: rows });
      } catch (err) {
        console.error('[REFERENCE] GET error:', err.message);
        return res.status(500).json({ error: `Failed to retrieve ${table}.` });
      }
    });

    router.post(`/${table}`, can('reference:manage'), async (req, res) => {
      const b = sanitizeObj(req.body, cfg.fields);
      if (!b.name) return res.status(400).json({ error: 'name is required.' });
      const vErr = validate(b, table);
      if (vErr) return res.status(400).json({ error: vErr });

      const cols = Object.keys(b);
      try {
        const { rows } = await query(
          `INSERT INTO ${table} (${cols.join(',')}, created_by)
           VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}) RETURNING *`,
          [...cols.map(c => b[c] === '' ? null : b[c]), req.session.userId]
        );
        return res.status(201).json({ item: rows[0] });
      } catch (err) {
        return dbError(res, err, cfg.label, `Failed to create ${cfg.label.toLowerCase()}.`);
      }
    });

    router.put(`/${table}/:id`, can('reference:manage'), async (req, res) => {
      const { id } = req.params;
      if (!isUUID(id)) return res.status(400).json({ error: 'Invalid ID.' });
      const b = sanitizeObj(req.body, [...cfg.fields, 'is_active']);
      const vErr = validate(b, table);
      if (vErr) return res.status(400).json({ error: vErr });
      if (b.is_active !== undefined && typeof b.is_active !== 'boolean')
        return res.status(400).json({ error: 'is_active must be true or false.' });

      const sets = [], params = [];
      for (const [k, v] of Object.entries(b)) {
        params.push(v === '' ? null : v);
        sets.push(`${k}=$${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
      params.push(id);
      try {
        const { rows, rowCount } = await query(
          `UPDATE ${table} SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
          params
        );
        if (!rowCount) return res.status(404).json({ error: `${cfg.label} not found.` });
        return res.json({ item: rows[0] });
      } catch (err) {
        return dbError(res, err, cfg.label, `Failed to update ${cfg.label.toLowerCase()}.`);
      }
    });

    // DELETE — only entries nothing refers to; deactivate the rest
    router.delete(`/${table}/:id`, can('reference:manage'), async (req, res) => {
      const { id } = req.params;
      if (!isUUID(id)) return res.status(400).json({ error: 'Invalid ID.' });
      try {
        const { rows: [row] } = await query(`SELECT name FROM ${table} WHERE id=$1`, [id]);
        if (!row) return res.status(404).json({ error: `${cfg.label} not found.` });
        const usage = (await query(cfg.usage, [row.name])).rows[0];
        const used = Object.entries(usage).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace('_', ' ')}`);
        if (used.length)
          return res.status(409).json({ error: `"${row.name}" is used by ${used.join(', ')}. Deactivate it instead.` });
        await query(`DELETE FROM ${table} WHERE id=$1`, [id]);
        return res.json({ success: true });
      } catch (err) {
        return dbError(res, err, cfg.label, `Failed to delete ${cfg.label.toLowerCase()}.`);
      }
    });
  }

  return router;
};
