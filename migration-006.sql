-- =============================================================================
-- EDIMS — migration-006.sql
-- One-time password and lockout reset for every account.
-- Apply after migration-005.sql.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migration-006.sql
--
-- What this changes:
--   - Every user's password is set to the default `ChangeMeLocally1`
--     (bcrypt, cost 12 — same as server.js and seed-admin.js).
--   - Lockout state is cleared: failed_login_attempts = 0, locked_until = NULL.
--   - Accounts are not reactivated; is_active is left as it is.
--   - `password_reset_runs` records that the reset ran, so applying this
--     migration again is refused instead of resetting passwords again.
--
-- SECURITY: the new password is published in this repo. Have every user
-- change it from the Users screen straight after the deploy.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.approval_requests') IS NULL THEN
        RAISE EXCEPTION 'migration-006 requires migration-005.sql to be applied first';
    END IF;
    IF to_regclass('public.password_reset_runs') IS NOT NULL THEN
        RAISE EXCEPTION 'migration-006 has already been applied (password_reset_runs exists)';
    END IF;
END;
$$;

CREATE TABLE password_reset_runs (
    id            SERIAL PRIMARY KEY,
    migration     TEXT NOT NULL,
    users_reset   INTEGER NOT NULL,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH reset AS (
    UPDATE users SET
        password_hash          = '$2a$12$QVg.C06Aelh4zGqrZlxpU.kTJio7gGrfzsXpHp8Zafoc/BPjTDvQC',
        failed_login_attempts  = 0,
        locked_until           = NULL,
        updated_at             = NOW()
    RETURNING id
)
INSERT INTO password_reset_runs (migration, users_reset)
SELECT 'migration-006', COUNT(*) FROM reset;

DO $$
BEGIN
    RAISE NOTICE 'Migration 006 applied successfully — all passwords reset to the default and lockouts cleared.';
END;
$$;

COMMIT;
