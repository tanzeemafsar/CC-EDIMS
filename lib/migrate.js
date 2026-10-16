'use strict';
// =============================================================================
// EDIMS — lib/migrate.js
// Applies schema.sql and migration-NNN.sql, in order, to whatever database
// DATABASE_URL points at. server.js runs this on every start-up before it
// accepts traffic (set AUTO_MIGRATE=false to turn that off), and it can be
// run on its own:
//
//   npm run migrate
//   node lib/migrate.js
//
// Each step is detected by an object it creates — the same markers the
// setup-local scripts use — so databases set up by hand, by setup-local, or
// by an older docker-compose are picked up where they are and nothing is
// applied twice.
//
// A Postgres advisory lock makes concurrent start-ups (several replicas, PM2
// restarts) wait for each other instead of racing the same migration.
//
// Adding a migration: append a { file, applied } entry to STEPS below, where
// `applied` is a query returning true once that migration has run.
// =============================================================================

const fs       = require('fs');
const path     = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');

// Arbitrary constant shared by every EDIMS process for pg_advisory_lock
const LOCK_KEY = 4_821_007;

const tableExists = (name) => `SELECT to_regclass('public.${name}') IS NOT NULL AS applied`;

const STEPS = [
    { file: 'schema.sql',        applied: tableExists('users') },
    { file: 'migration-001.sql', applied: `SELECT EXISTS (
                                               SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                               WHERE t.typname = 'asset_status' AND e.enumlabel = 'Retired'
                                           ) AS applied` },
    { file: 'migration-002.sql', applied: tableExists('procurement_thresholds') },
    { file: 'migration-003.sql', applied: tableExists('device_categories') },
    { file: 'migration-004.sql', applied: tableExists('vendors') },
    { file: 'migration-005.sql', applied: tableExists('approval_requests') },
    { file: 'migration-006.sql', applied: tableExists('password_reset_runs') },
];

// Returns the list of files applied (empty when the database was up to date).
async function runMigrations(connectionString, log = console) {
    // Own connection, not the app pool — the pool's 10s statement_timeout is
    // too short for DDL on a populated database.
    const client = new Client({ connectionString });
    await client.connect();
    const applied = [];
    try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        for (const step of STEPS) {
            const { rows } = await client.query(step.applied);
            if (rows[0].applied) continue;

            log.log(`[MIGRATE] Applying ${step.file}...`);
            const sql = fs.readFileSync(path.join(ROOT, step.file), 'utf8');
            try {
                // Each file manages its own BEGIN/COMMIT
                await client.query(sql);
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                const hint = err.code === '42501'
                    ? ' (permission denied — run "npm run migrate" as the database owner, or re-run setup-local)'
                    : '';
                throw new Error(`${step.file} failed: ${err.message}${hint}`);
            }
            applied.push(step.file);
            log.log(`[MIGRATE] ${step.file} applied`);
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
        await client.end();
    }
    return applied;
}

module.exports = { runMigrations };

if (require.main === module) {
    require('dotenv').config({ path: path.join(ROOT, '.env') });
    if (!process.env.DATABASE_URL) {
        console.error('[FATAL] DATABASE_URL environment variable is not set.');
        process.exit(1);
    }
    runMigrations(process.env.DATABASE_URL)
        .then((done) => {
            console.log(done.length ? `[MIGRATE] Done — ${done.length} applied.` : '[MIGRATE] Database is up to date.');
        })
        .catch((err) => {
            console.error('[FATAL] Migration failed:', err.message);
            process.exit(1);
        });
}
