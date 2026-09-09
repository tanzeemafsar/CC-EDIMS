'use strict';
// =============================================================================
// EDIMS — manage-demo-user.js
// Creates OR resets a single demo account for live demos/walkthroughs.
//
// IMPORTANT — what this script deliberately does NOT do:
//   It does not bypass or special-case authentication in server.js. The demo
//   account logs in through the exact same /api/auth/login route, the same
//   bcrypt check, and the same 5-attempt / 30-minute lockout as every other
//   user. There is no "no restrictions" flag anywhere in the app.
//
//   What it DOES do is let you clear that account's lockout state and reset
//   its password in one command, right before you demo it — so a mistyped
//   password during a walkthrough doesn't lock you out mid-presentation.
//   Run it again any time the account gets locked or you want to rotate the
//   password.
//
// Usage:
//   npm run demo:reset
//   node manage-demo-user.js
//   node manage-demo-user.js --username demo --role Viewer
//
//   Non-interactive (CI / scripted demo environments):
//   EDIMS_DEMO_USERNAME=demo EDIMS_DEMO_EMAIL=demo@local \
//     EDIMS_DEMO_PASSWORD='at-least-12-chars' EDIMS_DEMO_ROLE=Admin \
//     node manage-demo-user.js
//
// Behavior:
//   - Upserts (create-or-update) the named account: if it doesn't exist it's
//     created; if it exists, its password, role, active flag, and lockout
//     state are reset.
//   - failed_login_attempts is set to 0 and locked_until to NULL every time
//     this script runs, so a locked-out demo account is fixed by re-running
//     this rather than by weakening the login route itself.
//   - Applies the exact same password-length rule as POST /api/users and
//     seed-admin.js (>= 12 characters), hashed with the same bcrypt cost (12).
//   - Refuses to run against a database where NODE_ENV=production unless
//     --force is passed, since a demo account is intended for demo/staging
//     environments, not live production data.
// =============================================================================

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const readline = require('readline');

require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('[FATAL] DATABASE_URL environment variable is not set.');
    process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });

// ── CLI arg parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
    const out = { force: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--force')    { out.force = true; continue; }
        if (argv[i] === '--username') { out.username = argv[++i]; continue; }
        if (argv[i] === '--email')    { out.email    = argv[++i]; continue; }
        if (argv[i] === '--role')     { out.role     = argv[++i]; continue; }
    }
    return out;
}
const args = parseArgs(process.argv.slice(2));

args.username = args.username || process.env.EDIMS_DEMO_USERNAME || 'demo';
args.email    = args.email    || process.env.EDIMS_DEMO_EMAIL    || 'demo@local.test';
args.role     = args.role     || process.env.EDIMS_DEMO_ROLE     || 'Admin';
const envPassword = process.env.EDIMS_DEMO_PASSWORD || '';

function isEmail(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}
function sanitizeStr(v) {
    return typeof v === 'string' ? v.trim() : '';
}

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
            if (char === '\u0003') { process.stdout.write('\n'); process.exit(130); }
            if (char === '\u007f' || char === '\b') { input = input.slice(0, -1); return; }
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
    console.log(' EDIMS — Demo account reset');
    console.log('=============================================================');

    const NODE_ENV = process.env.NODE_ENV || 'production';
    if (NODE_ENV === 'production' && !args.force) {
        console.error('[FATAL] NODE_ENV=production — refusing to create/reset a demo account here.');
        console.error('        This script is for demo/staging databases. If you really mean it,');
        console.error('        re-run with --force.');
        process.exit(1);
    }

    if (!isEmail(args.email)) {
        console.error(`[FATAL] "${args.email}" is not a valid email address.`);
        process.exit(1);
    }
    const username = sanitizeStr(args.username);
    if (username.length < 3 || username.length > 100) {
        console.error('[FATAL] Username must be 3-100 characters.');
        process.exit(1);
    }

    const client = await pool.connect().catch((err) => {
        console.error('[FATAL] Could not connect to PostgreSQL:', err.message);
        process.exit(1);
    });

    try {
        const roleRow = await client.query('SELECT id, name FROM roles WHERE name = $1', [args.role]);
        if (!roleRow.rowCount) {
            console.error(`[FATAL] Role "${args.role}" does not exist. Valid roles: Admin, TAC, Viewer.`);
            process.exit(1);
        }
        const roleId = roleRow.rows[0].id;

        let password = envPassword;
        if (password && password.length < 12) {
            console.error('[FATAL] EDIMS_DEMO_PASSWORD must be at least 12 characters.');
            process.exit(1);
        }
        if (!password) {
            if (!process.stdin.isTTY) {
                console.error('[FATAL] No password supplied and no interactive terminal available.');
                console.error('        Set EDIMS_DEMO_PASSWORD (>= 12 chars) and re-run.');
                process.exit(1);
            }
            while (!password || password.length < 12) {
                password = await askHidden(`Password for "${username}" (min 12 chars, not shown): `);
                if (password.length < 12) {
                    console.log(`[!] Must be at least 12 characters (got ${password.length}).`);
                }
            }
        }

        const hash = await bcrypt.hash(password, 12);

        // Upsert: create the account if it's missing, otherwise reset its
        // password, role, active flag, and — critically — its lockout state.
        const { rows } = await client.query(
            `INSERT INTO users (username, email, password_hash, role_id, is_active,
                                 failed_login_attempts, locked_until)
             VALUES ($1, $2, $3, $4, true, 0, NULL)
             ON CONFLICT (username) DO UPDATE SET
                 email                  = EXCLUDED.email,
                 password_hash          = EXCLUDED.password_hash,
                 role_id                = EXCLUDED.role_id,
                 is_active              = true,
                 failed_login_attempts  = 0,
                 locked_until           = NULL,
                 updated_at             = NOW()
             RETURNING id, username, email, created_at, updated_at`,
            [username, args.email, hash, roleId]
        );

        console.log('');
        console.log('[OK] Demo account ready:');
        console.log(`       id:       ${rows[0].id}`);
        console.log(`       username: ${rows[0].username}`);
        console.log(`       email:    ${rows[0].email}`);
        console.log(`       role:     ${args.role}`);
        console.log('       failed_login_attempts / locked_until reset to 0 / NULL.');
        console.log('');
        console.log('This account authenticates through the same login route, bcrypt check,');
        console.log('and 5-attempt lockout as every other user — re-run this script any time');
        console.log('it gets locked out or you want to rotate its password.');
    } catch (err) {
        if (err.code === '23505') {
            console.error('[FATAL] That email is already used by a different username.');
        } else {
            console.error('[FATAL] Could not create/reset demo user:', err.message);
        }
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
