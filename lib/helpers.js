'use strict';
// =============================================================================
// EDIMS — lib/helpers.js
// Input sanitising/validation and DB helpers shared by server.js and the
// route modules in routes/.
// =============================================================================

function sanitizeStr(v) {
    if (v == null) return null;
    return String(v).trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function sanitizeObj(obj, allowed) {
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
            out[k] = typeof obj[k] === 'string' ? sanitizeStr(obj[k]) : obj[k];
        }
    }
    return out;
}

function isUUID(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isEmail(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

// YYYY-MM-DD that is also a real calendar date
function isDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(v + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}

// Optional number in [min, max] with at most `decimals` places.
// Returns { value } (undefined when blank) or { error }.
function parseNumber(v, label, { min = 0, max = 1e10, decimals = 2, integer = false } = {}) {
    if (v === undefined || v === null || v === '') return { value: undefined };
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max)
        return { error: `${label} must be a number between ${min} and ${max}.` };
    if (integer && !Number.isInteger(n)) return { error: `${label} must be a whole number.` };
    const scaled = n * 10 ** decimals;
    if (!integer && Math.abs(scaled - Math.round(scaled)) > 1e-6)
        return { error: `${label} can have at most ${decimals} decimal places.` };
    return { value: n };
}

// DB helpers bound to a pg Pool
function makeDb(pool) {
    async function query(sql, params) {
        const client = await pool.connect();
        try {
            return await client.query(sql, params);
        } finally {
            client.release();
        }
    }

    // Run fn(client) inside a single transaction on one connection
    async function withTransaction(fn) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    // Devices, catalogue items, procurement alerts and thresholds are always
    // filed under a subcategory (a device_categories row with a parent).
    // Returns an error message, or null when id is a usable subcategory.
    async function checkSubcategory(id, { requireActive = true } = {}) {
        if (!id || !isUUID(id)) return 'A valid subcategory (category_id) is required.';
        const { rows } = await query(
            'SELECT parent_id, is_active FROM device_category_paths WHERE id=$1', [id]
        );
        if (!rows.length) return 'category_id must reference an existing subcategory, not a top-level category.';
        if (requireActive && !rows[0].is_active) return 'That subcategory (or its category) is inactive.';
        return null;
    }

    // Reference-list values (vendors / locations) are stored by name.
    // Matches obj[key] case-insensitively and rewrites it to the list's own
    // spelling ("dell" -> "Dell"). Returns an error message, or null when the
    // value is blank or an existing entry. Inactive entries are rejected for
    // new data unless allowInactive.
    async function checkReference(table, obj, key, label, { allowInactive = false } = {}) {
        const name = obj[key];
        if (name == null || name === '') return null;
        if (!['vendors', 'locations'].includes(table)) throw new Error('bad reference table');
        const { rows } = await query(`SELECT name, is_active FROM ${table} WHERE lower(name)=lower($1)`, [name]);
        if (!rows.length) return `${label} "${name}" is not in the ${label.toLowerCase()} list. Add it under Reference data first.`;
        if (!allowInactive && !rows[0].is_active) return `${label} "${rows[0].name}" is inactive.`;
        obj[key] = rows[0].name;
        return null;
    }

    return { pool, query, withTransaction, checkSubcategory, checkReference };
}

module.exports = { sanitizeStr, sanitizeObj, isUUID, isEmail, isDate, parseNumber, makeDb };
