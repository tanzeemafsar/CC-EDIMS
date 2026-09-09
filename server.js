'use strict';

// =============================================================================
// EDIMS — Employee Device Inventory Management System
// server.js — Production-Grade Express Backend
// Node.js 20+ | Express.js | Native pg Driver
// =============================================================================

// Load .env into process.env for plain `node server.js` / `npm start`.
// PM2 (ecosystem.config.js) loads .env itself via env_file and does not need
// this, but dotenv.config() is a no-op when a variable is already set, so
// it's safe to call unconditionally regardless of how the process was
// started.
require('dotenv').config();

const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const { Pool }      = require('pg');
const bcrypt        = require('bcryptjs');
const session       = require('express-session');
const connectPg     = require('connect-pg-simple');
const express       = require('express');

// =============================================================================
// ENVIRONMENT VALIDATION
// =============================================================================

const PORT           = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL   = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const NODE_ENV       = process.env.NODE_ENV || 'production';
const CERT_KEY_PATH  = process.env.CERT_KEY_PATH || path.join(__dirname, 'certs', 'local-cert.key');
const CERT_CRT_PATH  = process.env.CERT_CRT_PATH || path.join(__dirname, 'certs', 'local-cert.crt');
// Only enable if EDIMS actually sits behind a reverse proxy / load balancer
// (nginx, an ALB, Cloudflare, etc). When true, Express trusts the
// X-Forwarded-For header from the immediate proxy hop so req.ip — and
// therefore the rate limiter and session cookie logic — see the real client
// IP instead of the proxy's. Leave false for direct LAN deployment.
const TRUST_PROXY    = process.env.TRUST_PROXY === 'true';

if (!DATABASE_URL) {
    console.error('[FATAL] DATABASE_URL environment variable is not set.');
    process.exit(1);
}
if (!SESSION_SECRET) {
    console.error('[FATAL] SESSION_SECRET environment variable is not set.');
    process.exit(1);
}
if (SESSION_SECRET.length < 64) {
    console.error('[FATAL] SESSION_SECRET must be at least 64 characters long for security.');
    process.exit(1);
}

// =============================================================================
// TLS CERTIFICATE DETECTION
// Checked early (before session middleware) so the cookie 'secure' flag can
// reflect whether we will actually be serving over HTTPS. The certs are
// re-read inside createServer() at the bottom of this file when the HTTP(S)
// server is actually constructed.
// =============================================================================

const httpsEnabled = fs.existsSync(CERT_KEY_PATH) && fs.existsSync(CERT_CRT_PATH);
if (!httpsEnabled) {
    console.warn(`[TLS] WARNING: Certificate files not found at:`);
    console.warn(`[TLS]   ${CERT_KEY_PATH}`);
    console.warn(`[TLS]   ${CERT_CRT_PATH}`);
    console.warn(`[TLS] Falling back to plain HTTP. THIS IS INSECURE IN PRODUCTION.`);
    console.warn(`[TLS] Run: bash scripts/gen-local-cert.sh  to generate LAN certificates.`);
}

// =============================================================================
// DATABASE CONNECTION POOL
// pg.Pool — max 25 connections, statement timeout 10s
// =============================================================================

const pool = new Pool({
    connectionString:      DATABASE_URL,
    max:                   25,
    idleTimeoutMillis:     30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout:     10_000,
});

pool.on('error', (err) => {
    console.error('[DB POOL] Unexpected client error:', err.message);
});

// Helper: run a parameterised query
async function query(sql, params) {
    const client = await pool.connect();
    try {
        return await client.query(sql, params);
    } finally {
        client.release();
    }
}

// =============================================================================
// EXPRESS APPLICATION
// =============================================================================

const app = express();

if (TRUST_PROXY) {
    app.set('trust proxy', 1); // trust exactly one hop (the reverse proxy in front of us)
    console.log('[SERVER] TRUST_PROXY=true — trusting X-Forwarded-For from one proxy hop.');
}

// =============================================================================
// HEALTH CHECK — unauthenticated, no rate limit, for load balancers / uptime
// monitors / process managers (PM2, Docker HEALTHCHECK, k8s liveness probes).
// Verifies the DB pool can actually serve a query, not just that Node is up.
// =============================================================================

app.get('/healthz', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        return res.status(200).json({ status: 'ok', uptime: process.uptime() });
    } catch (err) {
        return res.status(503).json({ status: 'unavailable', error: err.message });
    }
});

// =============================================================================
// SECURITY HEADERS MIDDLEWARE
// Implemented manually — no Helmet package
// =============================================================================

app.use((req, res, next) => {
    // Prevent framing (clickjacking)
    res.setHeader('X-Frame-Options', 'DENY');
    // Prevent MIME-type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Do not send Referer header to external origins
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Strict CSP for private LAN single-origin SPA
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",    // Required for inline SPA script block
            "style-src 'self' 'unsafe-inline'",     // Required for inline SPA styles
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join('; ')
    );
    // Disable browser features not required by EDIMS
    res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()'
    );
    // Remove server identification fingerprint
    res.removeHeader('X-Powered-By');
    next();
});

// =============================================================================
// BODY PARSING — with hard size limits
// =============================================================================

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// =============================================================================
// MANUAL RATE LIMITER
// No external rate-limit package used
// =============================================================================

const _rlStore = new Map();

// Prune stale rate-limit windows every 10 minutes to bound memory usage
setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, hits] of _rlStore) {
        const fresh = hits.filter(t => t > cutoff);
        if (fresh.length === 0) _rlStore.delete(key);
        else _rlStore.set(key, fresh);
    }
}, 10 * 60 * 1000).unref();

function makeRateLimiter(maxHits, windowMs) {
    return function rateLimitMiddleware(req, res, next) {
        const key  = req.ip || 'unknown';
        const now  = Date.now();
        const hits = (_rlStore.get(key) || []).filter(t => now - t < windowMs);
        hits.push(now);
        _rlStore.set(key, hits);
        if (hits.length > maxHits) {
            res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
            return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
        res.setHeader('X-RateLimit-Limit', maxHits);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxHits - hits.length));
        next();
    };
}

// General API: 300 requests per 15 minutes per IP
const apiLimiter  = makeRateLimiter(300, 15 * 60 * 1000);
// Auth endpoints: 10 attempts per 15 minutes per IP (brute-force protection)
const authLimiter = makeRateLimiter(10,  15 * 60 * 1000);

// =============================================================================
// SESSION MANAGEMENT
// PostgreSQL session store via connect-pg-simple
// =============================================================================

const PgStore = connectPg(session);

app.use(session({
    store: new PgStore({
        pool,
        tableName:             'sessions',
        createTableIfMissing:  false,       // table created by schema.sql
        pruneSessionInterval:  60 * 15,     // prune expired sessions every 15 min
    }),
    secret:            SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    name:              'edims_sid',         // Opaque name, not 'connect.sid'
    rolling:           true,                // Reset cookie expiry on activity
    cookie: {
        secure:   httpsEnabled,             // true when HTTPS certs loaded; false for HTTP fallback
        httpOnly: true,                     // Not accessible via document.cookie
        sameSite: 'strict',                 // CSRF protection
        maxAge:   8 * 60 * 60 * 1000,      // 8-hour session lifetime
    },
}));

// =============================================================================
// INPUT HELPERS
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

// =============================================================================
// RBAC
// =============================================================================

// Permission → allowed roles matrix
const PERMS = {
    'dashboard:read':    ['Admin', 'TAC', 'Viewer'],
    'employees:read':    ['Admin', 'TAC', 'Viewer'],
    'employees:write':   ['Admin', 'TAC'],
    'assets:read':       ['Admin', 'TAC', 'Viewer'],
    'assets:write':      ['Admin', 'TAC'],
    'assets:status':     ['Admin', 'TAC'],
    'assignments:write': ['Admin', 'TAC'],
    'procurement:read':  ['Admin', 'TAC', 'Viewer'],
    'procurement:write': ['Admin', 'TAC'],
    'audits:read':       ['Admin', 'TAC', 'Viewer'],
    'audits:write':      ['Admin', 'TAC'],
    'users:manage':      ['Admin'],
};

function requireAuth(req, res, next) {
    if (!req.session?.userId) {
        return res.status(401).json({ error: 'Authentication required.' });
    }
    next();
}

function can(permission) {
    return (req, res, next) => {
        if (!req.session?.userId) {
            return res.status(401).json({ error: 'Authentication required.' });
        }
        const role    = req.session.role;
        const allowed = PERMS[permission] || [];
        if (!allowed.includes(role)) {
            return res.status(403).json({
                error:      'Insufficient permissions.',
                required:   permission,
                yourRole:   role,
            });
        }
        next();
    };
}

// =============================================================================
// STATIC FILES
// =============================================================================

app.use(express.static(path.join(__dirname, 'public'), {
    index:        false,
    etag:         true,
    lastModified: true,
    maxAge:       '1h',
}));

// =============================================================================
// ROUTES — Apply global API rate limiter to all /api paths
// =============================================================================

app.use('/api', apiLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required.' });
    }

    const cleanUser = sanitizeStr(username);
    if (cleanUser.length < 3 || cleanUser.length > 100) {
        return res.status(400).json({ error: 'Invalid username format.' });
    }

    try {
        const { rows } = await query(
            `SELECT u.id, u.username, u.email, u.password_hash, u.is_active,
                    u.failed_login_attempts, u.locked_until, r.name AS role
             FROM users u
             JOIN roles r ON r.id = u.role_id
             WHERE u.username = $1`,
            [cleanUser]
        );

        const user = rows[0];

        // Generic 401 to prevent username enumeration
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        // Account lockout check
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
        }

        if (!user.is_active) {
            return res.status(401).json({ error: 'Account is disabled.' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid) {
            const attempts = (user.failed_login_attempts || 0) + 1;
            const lockUntil = attempts >= 5
                ? new Date(Date.now() + 30 * 60 * 1000)  // 30-min lockout after 5 failures
                : null;
            await query(
                `UPDATE users SET failed_login_attempts=$1, locked_until=$2, updated_at=NOW() WHERE id=$3`,
                [attempts, lockUntil, user.id]
            );
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        // Reset failure counter on success
        await query(
            `UPDATE users SET failed_login_attempts=0, locked_until=NULL, last_login=NOW(), updated_at=NOW() WHERE id=$1`,
            [user.id]
        );

        // Session fixation protection — regenerate session ID on login
        req.session.regenerate((err) => {
            if (err) {
                console.error('[AUTH] Session regeneration failed:', err.message);
                return res.status(500).json({ error: 'Session error.' });
            }
            req.session.userId   = user.id;
            req.session.username = user.username;
            req.session.role     = user.role;
            req.session.loginAt  = Date.now();

            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('[AUTH] Session save failed:', saveErr.message);
                    return res.status(500).json({ error: 'Session error.' });
                }
                return res.json({
                    success: true,
                    user: { id: user.id, username: user.username, email: user.email, role: user.role },
                });
            });
        });
    } catch (err) {
        console.error('[AUTH] Login error:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('[AUTH] Logout error:', err.message);
            return res.status(500).json({ error: 'Logout error.' });
        }
        res.clearCookie('edims_sid');
        return res.json({ success: true });
    });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
    return res.json({
        id:       req.session.userId,
        username: req.session.username,
        role:     req.session.role,
        loginAt:  req.session.loginAt,
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/dashboard/summary
app.get('/api/dashboard/summary', can('dashboard:read'), async (req, res) => {
    try {
        const [byClass, totals, alerts, recent, expiring] = await Promise.all([
            query('SELECT * FROM dashboard_inventory_summary', []),
            query(`SELECT
                       COUNT(*)                                               AS total_assets,
                       COUNT(*) FILTER (WHERE status = 'Assigned')           AS total_assigned,
                       COUNT(*) FILTER (WHERE status = 'In-Hand')            AS total_in_hand,
                       COUNT(*) FILTER (WHERE status = 'Faulty')             AS total_faulty,
                       COUNT(*) FILTER (WHERE status = 'Ordered')            AS total_ordered,
                       COUNT(*) FILTER (WHERE status = 'Need to Order')      AS total_need_to_order
                   FROM assets`, []),
            query(`SELECT COUNT(*) AS open_alerts FROM procurement_alerts WHERE resolved_at IS NULL`, []),
            query(`SELECT ah.event_type, ah.created_at, ah.notes,
                          a.asset_tag, a.hardware_class,
                          e.full_name   AS employee_name,
                          u.username    AS performed_by
                   FROM asset_history ah
                   LEFT JOIN assets    a ON a.id = ah.asset_id
                   LEFT JOIN employees e ON e.id = ah.employee_id
                   LEFT JOIN users     u ON u.id = ah.performed_by
                   ORDER BY ah.created_at DESC LIMIT 15`, []),
            query(`SELECT id, asset_tag, hardware_class, model, warranty_expiry
                   FROM assets
                   WHERE warranty_expiry BETWEEN NOW() AND NOW() + INTERVAL '90 days'
                   ORDER BY warranty_expiry ASC LIMIT 10`, []),
        ]);

        return res.json({
            totals:         totals.rows[0],
            byClass:        byClass.rows,
            openAlerts:     parseInt(alerts.rows[0].open_alerts, 10),
            recentActivity: recent.rows,
            expiringWarranties: expiring.rows,
        });
    } catch (err) {
        console.error('[DASHBOARD] Error:', err.message);
        return res.status(500).json({ error: 'Failed to load dashboard.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/employees
app.get('/api/employees', can('employees:read'), async (req, res) => {
    const { status, department, search, limit = 100, offset = 0 } = req.query;
    const conds  = [];
    const params = [];

    if (status) {
        params.push(status);
        conds.push(`e.status = $${params.length}::employee_status`);
    }
    if (department) {
        params.push(sanitizeStr(department));
        conds.push(`e.department ILIKE $${params.length}`);
    }
    if (search) {
        params.push(`%${sanitizeStr(search)}%`);
        const n = params.length;
        conds.push(`(e.full_name ILIKE $${n} OR e.email ILIKE $${n} OR e.employee_code ILIKE $${n})`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(Math.min(parseInt(limit, 10) || 100, 500));
    params.push(Math.max(parseInt(offset, 10) || 0, 0));

    try {
        const { rows } = await query(
            `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone,
                    e.department, e.designation, e.status,
                    e.join_date, e.offboard_date, e.notes,
                    e.created_at, e.updated_at,
                    m.full_name                 AS reporting_manager_name,
                    COALESCE(agg.active_cnt, 0) AS active_assets
             FROM employees e
             LEFT JOIN employees m ON m.id = e.reporting_manager
             LEFT JOIN (
                 SELECT employee_id, COUNT(*) AS active_cnt
                 FROM assignments WHERE returned_at IS NULL
                 GROUP BY employee_id
             ) agg ON agg.employee_id = e.id
             ${where}
             ORDER BY e.full_name ASC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        return res.json({ employees: rows, count: rows.length });
    } catch (err) {
        console.error('[EMPLOYEES] GET error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve employees.' });
    }
});

// POST /api/employees
app.post('/api/employees', can('employees:write'), async (req, res) => {
    const ALLOWED = ['employee_code','full_name','email','phone','department',
                     'designation','reporting_manager','status','join_date','notes'];
    const b = sanitizeObj(req.body, ALLOWED);

    if (!b.employee_code || !b.full_name || !b.email)
        return res.status(400).json({ error: 'employee_code, full_name, and email are required.' });
    if (!isEmail(b.email))
        return res.status(400).json({ error: 'Invalid email address.' });
    if (b.reporting_manager && !isUUID(b.reporting_manager))
        return res.status(400).json({ error: 'Invalid reporting_manager ID.' });

    const VALID_STATUS = ['Active','Inactive','Offboarded'];
    if (b.status && !VALID_STATUS.includes(b.status))
        return res.status(400).json({ error: 'Invalid status value.' });

    try {
        const { rows } = await query(
            `INSERT INTO employees
             (employee_code,full_name,email,phone,department,designation,
              reporting_manager,status,join_date,notes,created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [b.employee_code, b.full_name, b.email, b.phone||null,
             b.department||null, b.designation||null, b.reporting_manager||null,
             b.status||'Active', b.join_date||null, b.notes||null, req.session.userId]
        );
        return res.status(201).json({ employee: rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            const field = err.constraint?.includes('email') ? 'Email' : 'Employee code';
            return res.status(409).json({ error: `${field} already exists.` });
        }
        console.error('[EMPLOYEES] POST error:', err.message);
        return res.status(500).json({ error: 'Failed to create employee.' });
    }
});

// PUT /api/employees/:id
app.put('/api/employees/:id', can('employees:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid employee ID.' });

    const ALLOWED = ['full_name','email','phone','department','designation',
                     'reporting_manager','status','join_date','offboard_date','notes'];
    const b = sanitizeObj(req.body, ALLOWED);

    if (b.email && !isEmail(b.email))
        return res.status(400).json({ error: 'Invalid email address.' });
    if (b.reporting_manager && !isUUID(b.reporting_manager))
        return res.status(400).json({ error: 'Invalid reporting_manager ID.' });
    if (b.reporting_manager === id)
        return res.status(400).json({ error: 'Employee cannot report to themselves.' });

    // Offboarding gate: all assets must be returned first
    if (b.status === 'Offboarded') {
        const chk = await query(
            `SELECT COUNT(*) AS cnt FROM assignments WHERE employee_id=$1 AND returned_at IS NULL`,
            [id]
        );
        if (parseInt(chk.rows[0].cnt, 10) > 0)
            return res.status(409).json({
                error: 'Cannot offboard employee with active asset assignments. Return all assets first.'
            });
    }

    const sets   = [];
    const params = [];
    for (const [k, v] of Object.entries(b)) {
        if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
    params.push(id);

    try {
        const { rows, rowCount } = await query(
            `UPDATE employees SET ${sets.join(',')} , updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
            params
        );
        if (!rowCount) return res.status(404).json({ error: 'Employee not found.' });
        return res.json({ employee: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Email already exists.' });
        console.error('[EMPLOYEES] PUT error:', err.message);
        return res.status(500).json({ error: 'Failed to update employee.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSETS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/assets
app.get('/api/assets', can('assets:read'), async (req, res) => {
    const { status, hardware_class, search, limit = 100, offset = 0 } = req.query;
    const conds  = [];
    const params = [];

    if (status) {
        params.push(status); conds.push(`a.status=$${params.length}::asset_status`);
    }
    if (hardware_class) {
        params.push(hardware_class); conds.push(`a.hardware_class=$${params.length}::hardware_class`);
    }
    if (search) {
        params.push(`%${sanitizeStr(search)}%`);
        const n = params.length;
        conds.push(`(a.asset_tag ILIKE $${n} OR a.serial_number ILIKE $${n} OR a.model ILIKE $${n} OR a.vendor ILIKE $${n})`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(Math.min(parseInt(limit, 10) || 100, 500));
    params.push(Math.max(parseInt(offset, 10) || 0, 0));

    try {
        const { rows } = await query(
            `SELECT a.id, a.asset_tag, a.serial_number, a.qr_code, a.hardware_class,
                    a.vendor, a.model, a.purchase_price, a.purchase_date,
                    a.warranty_expiry, a.depreciation_years, a.status,
                    a.location, a.notes, a.created_at, a.updated_at,
                    e.full_name     AS assigned_to_name,
                    e.employee_code AS assigned_to_code,
                    asgn.assigned_at
             FROM assets a
             LEFT JOIN assignments asgn ON asgn.asset_id=a.id AND asgn.returned_at IS NULL
             LEFT JOIN employees   e    ON e.id=asgn.employee_id
             ${where}
             ORDER BY a.hardware_class, a.asset_tag
             LIMIT $${params.length-1} OFFSET $${params.length}`,
            params
        );
        return res.json({ assets: rows, count: rows.length });
    } catch (err) {
        console.error('[ASSETS] GET error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve assets.' });
    }
});

// GET /api/assets/suggestions?hardware_class=Laptop
// Distinct vendor/model combos already seen for a device type, so the "New
// asset" form can autocomplete from what's already in inventory instead of
// re-typing "Dell / Latitude 5420" from scratch every time. Also returns
// each combo's most recent purchase_price/depreciation_years as a filled-in
// starting point (all still editable before saving).
app.get('/api/assets/suggestions', can('assets:read'), async (req, res) => {
    const { hardware_class } = req.query;
    const conds  = [];
    const params = [];
    if (hardware_class) {
        params.push(hardware_class);
        conds.push(`hardware_class=$${params.length}::hardware_class`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    try {
        const { rows } = await query(
            `SELECT DISTINCT ON (hardware_class, vendor, model)
                    hardware_class, vendor, model, purchase_price, depreciation_years,
                    location, warranty_expiry, purchase_date
             FROM assets
             ${where}
             ORDER BY hardware_class, vendor, model, created_at DESC
             LIMIT 200`,
            params
        );
        return res.json({ suggestions: rows });
    } catch (err) {
        console.error('[ASSETS] Suggestions error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve suggestions.' });
    }
});

// POST /api/assets
app.post('/api/assets', can('assets:write'), async (req, res) => {
    const ALLOWED = ['asset_tag','serial_number','qr_code','hardware_class','vendor',
                     'model','purchase_price','purchase_date','warranty_expiry',
                     'depreciation_years','status','location','notes'];
    const b = sanitizeObj(req.body, ALLOWED);

    if (!b.asset_tag || !b.serial_number || !b.hardware_class || !b.model)
        return res.status(400).json({ error: 'asset_tag, serial_number, hardware_class, and model are required.' });

    const VALID_CLASSES = ['MacBook','Laptop','Monitor','Jabra Headset','Keyboard','Mouse','Peripheral'];
    if (!VALID_CLASSES.includes(b.hardware_class))
        return res.status(400).json({ error: `Invalid hardware_class. Must be one of: ${VALID_CLASSES.join(', ')}` });

    const VALID_STATUS = ['Assigned','In-Hand','Faulty','Ordered','Need to Order'];
    if (b.status && !VALID_STATUS.includes(b.status))
        return res.status(400).json({ error: 'Invalid status value.' });

    try {
        const { rows } = await query(
            `INSERT INTO assets
             (asset_tag,serial_number,qr_code,hardware_class,vendor,model,
              purchase_price,purchase_date,warranty_expiry,depreciation_years,
              status,location,notes,created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [b.asset_tag, b.serial_number, b.qr_code||null, b.hardware_class,
             b.vendor||null, b.model,
             b.purchase_price ? parseFloat(b.purchase_price) : null,
             b.purchase_date||null, b.warranty_expiry||null,
             b.depreciation_years ? parseInt(b.depreciation_years, 10) : null,
             b.status||'In-Hand', b.location||null, b.notes||null, req.session.userId]
        );

        // Authoritative registration entry in the immutable ledger
        await query(
            `INSERT INTO asset_history (asset_id,event_type,new_status,performed_by,notes)
             VALUES ($1,'Asset Registered',$2,$3,'Asset registered into EDIMS inventory')`,
            [rows[0].id, rows[0].status, req.session.userId]
        );

        return res.status(201).json({ asset: rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            const f = err.constraint?.includes('serial') ? 'Serial number' : 'Asset tag';
            return res.status(409).json({ error: `${f} already exists.` });
        }
        if (err.code === '23514')
            return res.status(400).json({ error: 'Constraint violation: check status/location combination.' });
        console.error('[ASSETS] POST error:', err.message);
        return res.status(500).json({ error: 'Failed to create asset.' });
    }
});

// PUT /api/assets/:id — update non-status fields
app.put('/api/assets/:id', can('assets:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid asset ID.' });

    const ALLOWED = ['asset_tag','serial_number','qr_code','vendor','model',
                     'purchase_price','purchase_date','warranty_expiry',
                     'depreciation_years','location','notes'];
    const b = sanitizeObj(req.body, ALLOWED);

    const sets   = [];
    const params = [];
    for (const [k, v] of Object.entries(b)) {
        if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
    params.push(id);

    try {
        const { rows, rowCount } = await query(
            `UPDATE assets SET ${sets.join(',')} , updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
            params
        );
        if (!rowCount) return res.status(404).json({ error: 'Asset not found.' });
        return res.json({ asset: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Asset tag or serial number already exists.' });
        console.error('[ASSETS] PUT error:', err.message);
        return res.status(500).json({ error: 'Failed to update asset.' });
    }
});

// PUT /api/assets/:id/status — status transitions (mark_faulty | repair | mark_ordered | retire)
app.put('/api/assets/:id/status', can('assets:status'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid asset ID.' });

    const { action, notes } = req.body;
    const VALID_ACTIONS = ['mark_faulty', 'repair', 'mark_ordered', 'retire'];
    if (!action || !VALID_ACTIONS.includes(action))
        return res.status(400).json({ error: 'Valid action required: mark_faulty | repair | mark_ordered | retire' });

    const cleanNotes = sanitizeStr(notes);

    try {
        if (action === 'mark_faulty') {
            await query('CALL mark_asset_faulty($1,$2,$3)', [id, req.session.userId, cleanNotes]);
        } else if (action === 'repair') {
            await query('CALL repair_asset($1,$2,$3)', [id, req.session.userId, cleanNotes]);
        } else if (action === 'retire') {
            // Requires migration-001.sql to have been applied (Retired enum value)
            await query('CALL retire_asset($1,$2,$3)', [id, req.session.userId, cleanNotes]);
        } else if (action === 'mark_ordered') {
            const chk = await query(`SELECT status FROM assets WHERE id=$1 FOR UPDATE`, [id]);
            if (!chk.rowCount) return res.status(404).json({ error: 'Asset not found.' });
            if (chk.rows[0].status === 'Assigned')
                return res.status(400).json({ error: 'Cannot mark an assigned asset as Ordered. Return it first.' });

            await query(
                `UPDATE assets SET status='Ordered', location=NULL, updated_at=NOW() WHERE id=$1`,
                [id]
            );
            await query(
                `INSERT INTO asset_history (asset_id,event_type,old_status,new_status,performed_by,notes)
                 VALUES ($1,'Status Change',$2,'Ordered',$3,$4)`,
                [id, chk.rows[0].status, req.session.userId, cleanNotes || 'Asset status set to Ordered']
            );
        }

        const { rows } = await query('SELECT * FROM assets WHERE id=$1', [id]);
        return res.json({ asset: rows[0] });
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('not found') || msg.includes('not in') || msg.includes('not currently') || msg.includes('already'))
            return res.status(400).json({ error: msg });
        console.error('[ASSETS] Status change error:', err.message);
        return res.status(500).json({ error: 'Failed to update asset status.' });
    }
});

// GET /api/assets/:id/history
app.get('/api/assets/:id/history', can('assets:read'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid asset ID.' });
    try {
        const { rows } = await query(
            `SELECT ah.*, e.full_name AS employee_name, u.username AS performed_by_username
             FROM asset_history ah
             LEFT JOIN employees e ON e.id=ah.employee_id
             LEFT JOIN users     u ON u.id=ah.performed_by
             WHERE ah.asset_id=$1
             ORDER BY ah.created_at DESC`,
            [id]
        );
        return res.json({ history: rows });
    } catch (err) {
        console.error('[ASSETS] History error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve asset history.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNMENTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/assignments/create
app.post('/api/assignments/create', can('assignments:write'), async (req, res) => {
    const { asset_id, employee_id, notes } = req.body;
    if (!asset_id || !employee_id)
        return res.status(400).json({ error: 'asset_id and employee_id are required.' });
    if (!isUUID(asset_id) || !isUUID(employee_id))
        return res.status(400).json({ error: 'Invalid asset_id or employee_id format.' });

    try {
        await query('CALL assign_asset($1,$2,$3,$4)', [asset_id, employee_id, req.session.userId, sanitizeStr(notes)]);
        const { rows } = await query(
            `SELECT asgn.id, asgn.asset_id, asgn.employee_id, asgn.assigned_at,
                    a.asset_tag, a.hardware_class, a.model,
                    e.full_name AS employee_name, e.employee_code
             FROM assignments asgn
             JOIN assets    a ON a.id=asgn.asset_id
             JOIN employees e ON e.id=asgn.employee_id
             WHERE asgn.asset_id=$1 AND asgn.returned_at IS NULL`,
            [asset_id]
        );
        return res.status(201).json({ assignment: rows[0] });
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('not found') || msg.includes('not active') || msg.includes('not available') || msg.includes('already'))
            return res.status(400).json({ error: msg });
        console.error('[ASSIGNMENTS] Create error:', err.message);
        return res.status(500).json({ error: 'Failed to create assignment.' });
    }
});

// POST /api/assignments/return
app.post('/api/assignments/return', can('assignments:write'), async (req, res) => {
    const { asset_id, notes } = req.body;
    if (!asset_id) return res.status(400).json({ error: 'asset_id is required.' });
    if (!isUUID(asset_id)) return res.status(400).json({ error: 'Invalid asset_id format.' });

    try {
        await query('CALL return_asset($1,$2,$3)', [asset_id, req.session.userId, sanitizeStr(notes)]);
        const { rows } = await query('SELECT * FROM assets WHERE id=$1', [asset_id]);
        return res.json({ asset: rows[0] });
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('not found') || msg.includes('not currently assigned'))
            return res.status(400).json({ error: msg });
        console.error('[ASSIGNMENTS] Return error:', err.message);
        return res.status(500).json({ error: 'Failed to return asset.' });
    }
});

// GET /api/assignments — active assignments listing
app.get('/api/assignments', can('assets:read'), async (req, res) => {
    const { employee_id, limit = 100, offset = 0 } = req.query;
    const conds  = ['asgn.returned_at IS NULL'];
    const params = [];

    if (employee_id && isUUID(employee_id)) {
        params.push(employee_id);
        conds.push(`asgn.employee_id=$${params.length}`);
    }

    params.push(Math.min(parseInt(limit,10)||100,500));
    params.push(Math.max(parseInt(offset,10)||0,0));

    try {
        const { rows } = await query(
            `SELECT asgn.id, asgn.assigned_at,
                    a.id AS asset_id, a.asset_tag, a.hardware_class, a.model, a.serial_number,
                    e.id AS employee_id, e.full_name, e.employee_code, e.department,
                    u.username AS assigned_by_username
             FROM assignments asgn
             JOIN assets    a ON a.id=asgn.asset_id
             JOIN employees e ON e.id=asgn.employee_id
             JOIN users     u ON u.id=asgn.assigned_by
             WHERE ${conds.join(' AND ')}
             ORDER BY asgn.assigned_at DESC
             LIMIT $${params.length-1} OFFSET $${params.length}`,
            params
        );
        return res.json({ assignments: rows, count: rows.length });
    } catch (err) {
        console.error('[ASSIGNMENTS] GET error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve assignments.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROCUREMENT
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/procurement
app.get('/api/procurement', can('procurement:read'), async (req, res) => {
    try {
        const [dash, alerts] = await Promise.all([
            query('SELECT * FROM procurement_dashboard ORDER BY hardware_class::text', []),
            query(`SELECT pa.*, u.username AS resolved_by_username
                   FROM procurement_alerts pa
                   LEFT JOIN users u ON u.id=pa.resolved_by
                   ORDER BY pa.created_at DESC LIMIT 100`, []),
        ]);
        return res.json({ dashboard: dash.rows, alerts: alerts.rows });
    } catch (err) {
        console.error('[PROCUREMENT] GET error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve procurement data.' });
    }
});

// PUT /api/procurement/:id/resolve
app.put('/api/procurement/:id/resolve', can('procurement:write'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid alert ID.' });

    const { notes } = req.body;
    try {
        const { rows, rowCount } = await query(
            `UPDATE procurement_alerts
             SET resolved_at=NOW(), resolved_by=$1, notes=COALESCE($2,notes), updated_at=NOW()
             WHERE id=$3 AND resolved_at IS NULL
             RETURNING *`,
            [req.session.userId, sanitizeStr(notes), id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Alert not found or already resolved.' });
        return res.json({ alert: rows[0] });
    } catch (err) {
        console.error('[PROCUREMENT] Resolve error:', err.message);
        return res.status(500).json({ error: 'Failed to resolve alert.' });
    }
});

// POST /api/procurement/alerts — manually raise an order/alert for a hardware
// class (as opposed to the ones the DB trigger opens automatically when
// In-Hand stock drops to/below that class's threshold).
app.post('/api/procurement/alerts', can('procurement:write'), async (req, res) => {
    const VALID_CLASSES = ['MacBook','Laptop','Monitor','Jabra Headset','Keyboard','Mouse','Peripheral'];
    const hardware_class = sanitizeStr(req.body.hardware_class);
    const notes = sanitizeStr(req.body.notes);

    if (!hardware_class || !VALID_CLASSES.includes(hardware_class))
        return res.status(400).json({ error: `hardware_class is required and must be one of: ${VALID_CLASSES.join(', ')}` });

    try {
        const { rows } = await query(
            `INSERT INTO procurement_alerts (hardware_class, notes)
             VALUES ($1, $2)
             RETURNING *`,
            [hardware_class, notes || 'Manually requested order.']
        );
        return res.status(201).json({ alert: rows[0] });
    } catch (err) {
        console.error('[PROCUREMENT] Create order error:', err.message);
        return res.status(500).json({ error: 'Failed to create order.' });
    }
});

// PUT /api/procurement/thresholds/:hardware_class — set the low-stock
// threshold used by the DB trigger that auto-opens alerts. Requires
// migration-002.sql (procurement_thresholds table) to be applied.
app.put('/api/procurement/thresholds/:hardware_class', can('procurement:write'), async (req, res) => {
    const VALID_CLASSES = ['MacBook','Laptop','Monitor','Jabra Headset','Keyboard','Mouse','Peripheral'];
    const hardware_class = sanitizeStr(req.params.hardware_class);
    const threshold_qty = parseInt(req.body.threshold_qty, 10);

    if (!VALID_CLASSES.includes(hardware_class))
        return res.status(400).json({ error: `Invalid hardware_class. Must be one of: ${VALID_CLASSES.join(', ')}` });
    if (!Number.isInteger(threshold_qty) || threshold_qty < 0 || threshold_qty > 100000)
        return res.status(400).json({ error: 'threshold_qty must be a non-negative integer.' });

    try {
        const { rows, rowCount } = await query(
            `INSERT INTO procurement_thresholds (hardware_class, threshold_qty, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (hardware_class) DO UPDATE SET
                 threshold_qty = EXCLUDED.threshold_qty,
                 updated_by    = EXCLUDED.updated_by,
                 updated_at    = NOW()
             RETURNING *`,
            [hardware_class, threshold_qty, req.session.userId]
        );
        if (!rowCount) return res.status(500).json({ error: 'Failed to update threshold.' });
        return res.json({ threshold: rows[0] });
    } catch (err) {
        if (err.code === '42P01') { // undefined_table — migration-002 not applied yet
            console.error('[PROCUREMENT] Threshold update error: procurement_thresholds table missing. Run npm run db:migrate2.');
            return res.status(500).json({ error: 'Threshold storage is not set up yet. Run the migration-002 database migration.' });
        }
        console.error('[PROCUREMENT] Threshold update error:', err.message);
        return res.status(500).json({ error: 'Failed to update threshold.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDITS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/audits/verify
app.post('/api/audits/verify', can('audits:write'), async (req, res) => {
    const { asset_id, employee_id, audit_type, verification_status, notes, discrepancy_notes } = req.body;

    if (!asset_id || !audit_type || !verification_status)
        return res.status(400).json({ error: 'asset_id, audit_type, and verification_status are required.' });
    if (!isUUID(asset_id))
        return res.status(400).json({ error: 'Invalid asset_id.' });
    if (employee_id && !isUUID(employee_id))
        return res.status(400).json({ error: 'Invalid employee_id.' });

    const VALID_AUDIT  = ['Monthly','Quarterly'];
    const VALID_STATUS = ['Verified','Unverified','Discrepancy'];
    if (!VALID_AUDIT.includes(audit_type))
        return res.status(400).json({ error: 'audit_type must be Monthly or Quarterly.' });
    if (!VALID_STATUS.includes(verification_status))
        return res.status(400).json({ error: 'verification_status must be Verified, Unverified, or Discrepancy.' });
    if (verification_status === 'Discrepancy' && !discrepancy_notes)
        return res.status(400).json({ error: 'discrepancy_notes are required when status is Discrepancy.' });

    try {
        const { rows } = await query(
            `INSERT INTO audit_logs
             (audit_type,asset_id,employee_id,performed_by,verification_status,notes,discrepancy_notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [audit_type, asset_id, employee_id||null, req.session.userId,
             verification_status, sanitizeStr(notes)||null, sanitizeStr(discrepancy_notes)||null]
        );

        await query(
            `INSERT INTO asset_history (asset_id,event_type,employee_id,performed_by,notes,metadata)
             VALUES ($1,'Audit Verification',$2,$3,$4,$5)`,
            [asset_id, employee_id||null, req.session.userId,
             `${audit_type} audit: ${verification_status}`,
             JSON.stringify({ audit_type, verification_status, audit_log_id: rows[0].id })]
        );

        return res.status(201).json({ auditLog: rows[0] });
    } catch (err) {
        console.error('[AUDITS] Verify error:', err.message);
        return res.status(500).json({ error: 'Failed to create audit verification.' });
    }
});

// GET /api/audits
app.get('/api/audits', can('audits:read'), async (req, res) => {
    const { audit_type, asset_id, verification_status, limit = 50, offset = 0 } = req.query;
    const conds  = [];
    const params = [];

    if (audit_type) { params.push(audit_type); conds.push(`al.audit_type=$${params.length}::audit_type`); }
    if (asset_id && isUUID(asset_id)) { params.push(asset_id); conds.push(`al.asset_id=$${params.length}`); }
    if (verification_status) { params.push(verification_status); conds.push(`al.verification_status=$${params.length}::verification_status`); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(Math.min(parseInt(limit,10)||50,200));
    params.push(Math.max(parseInt(offset,10)||0,0));

    try {
        const { rows } = await query(
            `SELECT al.*, a.asset_tag, a.hardware_class,
                    e.full_name AS employee_name, u.username AS performed_by_username
             FROM audit_logs al
             LEFT JOIN assets    a ON a.id=al.asset_id
             LEFT JOIN employees e ON e.id=al.employee_id
             LEFT JOIN users     u ON u.id=al.performed_by
             ${where}
             ORDER BY al.audit_date DESC
             LIMIT $${params.length-1} OFFSET $${params.length}`,
            params
        );
        return res.json({ audits: rows, count: rows.length });
    } catch (err) {
        console.error('[AUDITS] GET error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve audit logs.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// USERS (Admin only)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/users
app.get('/api/users', can('users:manage'), async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT u.id, u.username, u.email, u.is_active, u.last_login,
                    u.failed_login_attempts, u.locked_until, u.created_at,
                    r.name AS role
             FROM users u JOIN roles r ON r.id=u.role_id
             ORDER BY u.username`, []
        );
        return res.json({ users: rows });
    } catch (err) {
        console.error('[USERS] GET error:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve users.' });
    }
});

// POST /api/users
app.post('/api/users', can('users:manage'), async (req, res) => {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password || !role)
        return res.status(400).json({ error: 'username, email, password, and role are required.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
    if (password.length < 12)
        return res.status(400).json({ error: 'Password must be at least 12 characters.' });

    const VALID_ROLES = ['Admin','TAC','Viewer'];
    if (!VALID_ROLES.includes(role))
        return res.status(400).json({ error: 'Invalid role.' });

    try {
        const hash = await bcrypt.hash(password, 12);
        const roleRow = await query(`SELECT id FROM roles WHERE name=$1`, [role]);
        if (!roleRow.rowCount) return res.status(400).json({ error: 'Role not found.' });

        const { rows } = await query(
            `INSERT INTO users (username,email,password_hash,role_id)
             VALUES ($1,$2,$3,$4) RETURNING id,username,email,is_active,created_at`,
            [sanitizeStr(username), sanitizeStr(email), hash, roleRow.rows[0].id]
        );
        return res.status(201).json({ user: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Username or email already exists.' });
        console.error('[USERS] POST error:', err.message);
        return res.status(500).json({ error: 'Failed to create user.' });
    }
});

// PUT /api/users/:id/reset-password
// Lets a users:manage admin set a new password for someone else's account —
// there was previously no way to do this outside the CLI seed scripts.
// Also clears any lockout on that account (failed_login_attempts / locked_until),
// so this doubles as the "unlock a locked-out user" action.
app.put('/api/users/:id/reset-password', can('users:manage'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const newPassword = req.body.new_password;
    if (typeof newPassword !== 'string' || newPassword.length < 12)
        return res.status(400).json({ error: 'New password must be at least 12 characters.' });

    try {
        const hash = await bcrypt.hash(newPassword, 12);
        const { rows, rowCount } = await query(
            `UPDATE users SET
                password_hash=$1, failed_login_attempts=0, locked_until=NULL, updated_at=NOW()
             WHERE id=$2
             RETURNING id, username`,
            [hash, id]
        );
        if (!rowCount) return res.status(404).json({ error: 'User not found.' });
        return res.json({ user: rows[0] });
    } catch (err) {
        console.error('[USERS] Reset password error:', err.message);
        return res.status(500).json({ error: 'Failed to reset password.' });
    }
});

// PUT /api/users/:id/toggle-active
app.put('/api/users/:id/toggle-active', can('users:manage'), async (req, res) => {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: 'Invalid user ID.' });
    if (id === req.session.userId)
        return res.status(400).json({ error: 'Cannot deactivate your own account.' });
    try {
        const { rows, rowCount } = await query(
            `UPDATE users SET is_active=NOT is_active, updated_at=NOW() WHERE id=$1 RETURNING id,username,is_active`,
            [id]
        );
        if (!rowCount) return res.status(404).json({ error: 'User not found.' });
        return res.json({ user: rows[0] });
    } catch (err) {
        console.error('[USERS] Toggle error:', err.message);
        return res.status(500).json({ error: 'Failed to toggle user status.' });
    }
});

// GET /api/roles
app.get('/api/roles', requireAuth, async (req, res) => {
    try {
        const { rows } = await query('SELECT id, name, description FROM roles ORDER BY name', []);
        return res.json({ roles: rows });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to retrieve roles.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT ROUTES  GET /api/export/assets.csv|employees.csv|assignments.csv
//                GET /api/export/assets.pdf|audit-report.pdf
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/export',   require('./routes/export')(pool, can));

// ─────────────────────────────────────────────────────────────────────────────
// HARDWARE SCRAPER  GET  /api/hardware/scrape?url=https://...
//                   GET  /api/hardware/images
//                   DELETE /api/hardware/images/:filename
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/hardware', require('./routes/scraper')(can));

// Serve cached hardware images as static files (webp, 7-day cache)
const HW_IMAGES = path.join(__dirname, 'public', 'images', 'hardware');
app.use('/images/hardware', express.static(HW_IMAGES, { maxAge: '7d' }));

// ─────────────────────────────────────────────────────────────────────────────
// API 404 — any /api/* path that reached here matched no route above. Return
// JSON (not the SPA HTML) so the frontend's fetch client sees a real error
// instead of silently parsing the index page as an empty object.
// ─────────────────────────────────────────────────────────────────────────────

app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'API route not found.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPA FALLBACK — serve index.html for all non-API GET routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('[EXPRESS] Unhandled error:', err.message, err.stack);
    return res.status(500).json({ error: 'Internal server error.' });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// HTTPS / TLS 1.3 SERVER SETUP
// Reads certificate files from CERT_KEY_PATH / CERT_CRT_PATH (see .env).
// Falls back to plain HTTP with a loud warning if certs are missing.
// Generate certs with: bash scripts/generate-cert.sh
// ─────────────────────────────────────────────────────────────────────────────

function createServer() {
    if (httpsEnabled) {
        try {
            const tlsOptions = {
                key:        fs.readFileSync(CERT_KEY_PATH),
                cert:       fs.readFileSync(CERT_CRT_PATH),
                minVersion: 'TLSv1.3',      // Enforce TLS 1.3 minimum; reject 1.0/1.1/1.2
                ciphers: [                  // Explicit TLS 1.3 cipher suite
                    'TLS_AES_256_GCM_SHA384',
                    'TLS_CHACHA20_POLY1305_SHA256',
                    'TLS_AES_128_GCM_SHA256',
                ].join(':'),
            };
            const srv = https.createServer(tlsOptions, app);
            console.log(`[TLS] HTTPS mode — TLS 1.3 enforced`);
            console.log(`[TLS] Key:  ${CERT_KEY_PATH}`);
            console.log(`[TLS] Cert: ${CERT_CRT_PATH}`);
            return { srv, protocol: 'https' };
        } catch (err) {
            console.warn(`[TLS] WARNING: Could not load TLS certificates (${err.message})`);
            console.warn(`[TLS] Falling back to plain HTTP. THIS IS INSECURE IN PRODUCTION.`);
        }
    }
    console.warn(`[TLS] Running in plain HTTP mode.`);
    console.warn(`[TLS] Run: bash scripts/gen-local-cert.sh  to generate LAN certificates.`);
    return { srv: http.createServer(app), protocol: 'http' };
}

const { srv: server, protocol } = createServer();

async function start() {
    // Ensure hardware images dir exists
    fs.mkdirSync(HW_IMAGES, { recursive: true });

    // Verify DB connectivity before accepting traffic
    try {
        const client = await pool.connect();
        const { rows } = await client.query('SELECT version()');
        client.release();
        console.log(`[DB] Connected — ${rows[0].version.split(' ').slice(0,2).join(' ')}`);
    } catch (err) {
        console.error('[FATAL] Cannot connect to PostgreSQL:', err.message);
        process.exit(1);
    }

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[SERVER] EDIMS running on port ${PORT} (${NODE_ENV})`);
        console.log(`[SERVER] LAN URL: ${protocol}://tac-inventory.local:${PORT}`);
    });
}

// =============================================================================
// GRACEFUL SHUTDOWN — SIGINT / SIGTERM
// =============================================================================

let shutdownCalled = false;

async function gracefulShutdown(signal) {
    if (shutdownCalled) return;
    shutdownCalled = true;

    console.log(`\n[SERVER] ${signal} received — initiating graceful shutdown...`);

    // Stop accepting new connections; allow in-flight requests to complete
    server.close(() => {
        console.log('[SERVER] HTTP server closed — all connections drained.');
    });

    // Give in-flight requests 10 seconds to complete
    setTimeout(async () => {
        try {
            await pool.end();
            console.log('[DB] Connection pool drained.');
        } catch (err) {
            console.error('[DB] Pool drain error:', err.message);
        }
        console.log('[SERVER] Shutdown complete.');
        process.exit(0);
    }, 10_000);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err.message, err.stack);
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled promise rejection:', reason);
});

start();
