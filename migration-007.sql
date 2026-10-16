-- =============================================================================
-- EDIMS — migration-007.sql
-- Creates the `super_admin` Admin account.
-- Apply after migration-006.sql.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migration-007.sql
--
-- What this changes:
--   - Creates user `super_admin` (role Admin, email super_admin@local.test)
--     with the default password `ChangeMeLocally1` (bcrypt, cost 12).
--   - If `super_admin` already exists it is made an active Admin again, its
--     password is reset to the default and its lockout is cleared.
--   - A row in `password_reset_runs` records the run, so it is applied once:
--     deleting or changing the account afterwards sticks.
--
-- SECURITY: the password is published in this repo. Change it from the Users
-- screen straight after the first login.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.password_reset_runs') IS NULL THEN
        RAISE EXCEPTION 'migration-007 requires migration-006.sql to be applied first';
    END IF;
    IF EXISTS (SELECT 1 FROM password_reset_runs WHERE migration = 'migration-007') THEN
        RAISE EXCEPTION 'migration-007 has already been applied';
    END IF;
END;
$$;

INSERT INTO users (username, email, password_hash, role_id, is_active,
                   failed_login_attempts, locked_until)
SELECT 'super_admin', 'super_admin@local.test',
       '$2a$12$QVg.C06Aelh4zGqrZlxpU.kTJio7gGrfzsXpHp8Zafoc/BPjTDvQC',
       r.id, true, 0, NULL
FROM roles r WHERE r.name = 'Admin'
ON CONFLICT (username) DO UPDATE SET
    password_hash          = EXCLUDED.password_hash,
    role_id                = EXCLUDED.role_id,
    is_active              = true,
    failed_login_attempts  = 0,
    locked_until           = NULL,
    updated_at             = NOW();

INSERT INTO password_reset_runs (migration, users_reset) VALUES ('migration-007', 1);

DO $$
BEGIN
    RAISE NOTICE 'Migration 007 applied successfully — super_admin account is ready.';
END;
$$;

COMMIT;
