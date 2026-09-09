'use strict';
// =============================================================================
// EDIMS — seed-admin.js
// One-off bootstrap script: creates the first Admin user on a fresh database.
// Without this, there is no way to log into EDIMS at all — schema.sql creates
// the `roles` table (Admin/TAC/Viewer) but intentionally does not seed any
// `users` row, since a real admin password should never live in a SQL file
// that might end up in version control.
//
// Usage:
//   npm run seed-admin
//   node seed-admin.js
//   node seed-admin.js --username jdoe --email jdoe@example.com
//
//   Non-interactive (no TTY needed — used by setup-local.sh / CI):
//   EDIMS_ADMIN_USERNAME=admin EDIMS_ADMIN_EMAIL=admin@local \
//     EDIMS_ADMIN_PASSWORD='at-least-12-chars' node seed-admin.js
//
// Behavior:
//   - Prompts for username, email, and password interactively (password
//     input is not echoed to the terminal) — unless all three are supplied
//     via flags/env vars, in which case it runs without prompting.
//   - Refuses to run if any Admin user already exists, unless --force is
//     passed — this script is for bootstrapping, not ongoing user creation
//     (use the in-app "Users" screen, or POST /api/users, for that).
//   - Applies the exact same validation as POST /api/users in server.js:
//     password length >= 12, valid email shape, role must exist.
//   - Hashes with bcrypt cost factor 12 (matches server.js's user-creation
//     route) — never stores or logs the plaintext password.
// =============================================================================

const { Pool }  = require('pg');
const bcrypt     = require('bcryptjs');
const readline   = require('readline');

require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('[FATAL] DATABASE_URL environment variable is not set.');
    console.error('        Checked process.env and ./.env — neither has it.');
    process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });

// ── CLI arg parsing (optional --username / --email / --force) ──────────────
function parseArgs(argv) {
    const out = { force: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--force') { out.force = true; continue; }
        if (argv[i] === '--username') { out.username = argv[++i]; continue; }
        if (argv[i] === '--email')    { out.email    = argv[++i]; continue; }
    }
    return out;
}
const args = parseArgs(process.argv.slice(2));

// Non-interactive seeding: environment variables let the setup script (or any
// automation) create the first admin without a TTY. Anything not supplied this
// way falls back to an interactive prompt. Password is intentionally env-only,
// never a CLI flag, so it never lands in shell history or `ps` output.
args.username = args.username || process.env.EDIMS_ADMIN_USERNAME;
args.email    = args.email    || process.env.EDIMS_ADMIN_EMAIL;
const envPassword = process.env.EDIMS_ADMIN_PASSWORD || '';

// ── Same email/password rules as POST /api/users in server.js ──────────────
function isEmail(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}
function sanitizeStr(v) {
    return typeof v === 'string' ? v.trim() : '';
}

// ── Minimal readline prompt helpers (no extra dependencies) ─────────────────
function ask(rl, question) {
    return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
}

// Password input without echoing keystrokes to the terminal.
function askHidden(question) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        process.stdout.write(question);
        let input = '';
        const onData = (char) => {
            char = char.toString('utf8');
            if (char === '\n' || char === '\r' || char === '\u0004') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                resolve(input);
                return;
            }
            if (char === '\u0003') { process.stdout.write('\n'); process.exit(130); } // Ctrl-C
            if (char === '\u007f' || char === '\b') { input = input.slice(0, -1); return; } // backspace
            input += char;
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
    });
}

async function main() {
    console.log('=============================================================');
    console.log(' EDIMS — Admin bootstrap');
    console.log('=============================================================');

    const client = await pool.connect().catch((err) => {
        console.error('[FATAL] Could not connect to PostgreSQL:', err.message);
        console.error('        Has schema.sql been applied yet? (npm run db:init)');
        process.exit(1);
    });

    try {
        // Refuse to run twice unless --force is explicit. This is what makes
        // the script idempotent-safe to leave in package.json long-term
        // instead of being a footgun that creates a second Admin by accident.
        const existing = await client.query(
            `SELECT u.username FROM users u
             JOIN roles r ON r.id = u.role_id
             WHERE r.name = 'Admin'`
        );
        if (existing.rowCount > 0 && !args.force) {
            console.log(`[SKIP] ${existing.rowCount} Admin user(s) already exist:`);
            existing.rows.forEach((r) => console.log(`         - ${r.username}`));
            console.log('[SKIP] Refusing to seed another. Re-run with --force to override,');
            console.log('       or use the in-app "Users" screen to add more Admins.');
            process.exit(0);
        }

        const roleRow = await client.query(`SELECT id FROM roles WHERE name = 'Admin'`);
        if (!roleRow.rowCount) {
            console.error('[FATAL] No "Admin" role found in the roles table.');
            console.error('        Has schema.sql been applied yet? (npm run db:init)');
            process.exit(1);
        }
        const adminRoleId = roleRow.rows[0].id;

        // Resolve credentials. Anything supplied via flag/env is validated up
        // front (fail fast with a clear message rather than silently looping or
        // hanging in a non-TTY context). Whatever is missing is prompted for.
        let username = sanitizeStr(args.username || '');
        if (username && (username.length < 3 || username.length > 100)) {
            console.error('[FATAL] Provided username must be 3-100 characters.');
            process.exit(1);
        }

        let email = sanitizeStr(args.email || '');
        if (email && !isEmail(email)) {
            console.error('[FATAL] Provided email is not a valid address.');
            process.exit(1);
        }

        let password = envPassword;
        if (password && password.length < 12) {
            console.error('[FATAL] EDIMS_ADMIN_PASSWORD must be at least 12 characters.');
            process.exit(1);
        }

        const needInteractive = !username || !email || !password;
        let rl = null;
        if (needInteractive) {
            if (!process.stdin.isTTY) {
                console.error('[FATAL] Admin credentials incomplete and no interactive terminal is available.');
                console.error('        Supply them non-interactively via environment variables:');
                console.error('          EDIMS_ADMIN_USERNAME, EDIMS_ADMIN_EMAIL, EDIMS_ADMIN_PASSWORD');
                process.exit(1);
            }
            rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        }

        while (!username || username.length < 3 || username.length > 100) {
            username = sanitizeStr(await ask(rl, 'Admin username (3-100 chars): '));
        }

        while (!isEmail(email)) {
            email = sanitizeStr(await ask(rl, 'Admin email: '));
        }

        if (rl) rl.close(); // hand stdin over to the raw-mode password reader below

        if (!password) {
            while (password.length < 12) {
                password = await askHidden('Admin password (min 12 chars, not shown): ');
                if (password.length < 12) {
                    console.log(`[!] Password must be at least 12 characters (got ${password.length}).`);
                }
            }
            const confirm = await askHidden('Confirm password: ');
            if (confirm !== password) {
                console.error('[FATAL] Passwords did not match. Run the script again.');
                process.exit(1);
            }
        }

        const hash = await bcrypt.hash(password, 12);

        const { rows } = await client.query(
            `INSERT INTO users (username, email, password_hash, role_id, is_active)
             VALUES ($1, $2, $3, $4, true)
             RETURNING id, username, email, created_at`,
            [username, email, hash, adminRoleId]
        );

        console.log('');
        console.log('[OK] Admin user created:');
        console.log(`       id:       ${rows[0].id}`);
        console.log(`       username: ${rows[0].username}`);
        console.log(`       email:    ${rows[0].email}`);
        console.log('');
        console.log('You can now log in at the EDIMS web UI with this username and password.');
    } catch (err) {
        if (err.code === '23505') { // unique_violation
            console.error('[FATAL] That username or email is already taken.');
        } else {
            console.error('[FATAL] Could not create admin user:', err.message);
        }
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
