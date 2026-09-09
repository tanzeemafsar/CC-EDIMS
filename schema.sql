-- =============================================================================
-- EDIMS — schema.sql
-- Base schema. Apply this FIRST, then migration-001.sql.
-- Run: psql "$DATABASE_URL" -f schema.sql
--
-- This file was reconstructed from the application layer (server.js,
-- routes/export.js, routes/scraper.js) rather than handed down separately,
-- so every table/column/enum here is something the app code actually
-- queries. If your original schema.sql differs from this in places the
-- app never touches (extra columns, different defaults), this version
-- will still satisfy the application — but treat it as a reconstruction,
-- not an authoritative restore, and diff it against any backup you have.
-- =============================================================================

BEGIN;

-- =============================================================================
-- EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

-- Asset lifecycle. 'Retired' is added later by migration-001.sql — do not
-- add it here, so that migration-001.sql's ADD VALUE IF NOT EXISTS stays
-- meaningful on a fresh install too.
CREATE TYPE asset_status AS ENUM (
    'Assigned',
    'In-Hand',
    'Faulty',
    'Ordered',
    'Need to Order'
);

CREATE TYPE hardware_class AS ENUM (
    'MacBook',
    'Laptop',
    'Monitor',
    'Jabra Headset',
    'Keyboard',
    'Mouse',
    'Peripheral'
);

CREATE TYPE employee_status AS ENUM (
    'Active',
    'Inactive',
    'Offboarded'
);

CREATE TYPE audit_type AS ENUM (
    'Monthly',
    'Quarterly'
);

-- NOTE: server.js casts this column as ::verification_status (see the fix
-- applied to GET /api/audits — the original upload cast it to the
-- nonexistent type 'network_verification_status', which would error).
CREATE TYPE verification_status AS ENUM (
    'Verified',
    'Unverified',
    'Discrepancy'
);

-- =============================================================================
-- ROLES  (referenced by server.js as: r.id, r.name; PERMS matrix expects
-- exactly Admin / TAC / Viewer)
-- =============================================================================

CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT
);

INSERT INTO roles (name, description) VALUES
    ('Admin',  'Full access, including user management.'),
    ('TAC',    'Technical Asset Custodian — day-to-day operational access.'),
    ('Viewer', 'Read-only access across all modules.');

-- =============================================================================
-- USERS  (columns per server.js: id, username, email, password_hash,
-- role_id, is_active, failed_login_attempts, locked_until, last_login,
-- created_at, updated_at)
-- =============================================================================

CREATE TABLE users (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username               TEXT NOT NULL UNIQUE,
    email                  TEXT NOT NULL UNIQUE,
    password_hash          TEXT NOT NULL,
    role_id                UUID NOT NULL REFERENCES roles(id),
    is_active              BOOLEAN NOT NULL DEFAULT true,
    failed_login_attempts  INTEGER NOT NULL DEFAULT 0,
    locked_until           TIMESTAMPTZ,
    last_login             TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- EMPLOYEES  (columns per server.js/export.js: employee_code, full_name,
-- email, phone, department, designation, reporting_manager, status,
-- join_date, offboard_date, notes, created_by, created_at, updated_at)
-- =============================================================================

CREATE TABLE employees (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_code      TEXT NOT NULL UNIQUE,
    full_name          TEXT NOT NULL,
    email              TEXT NOT NULL UNIQUE,
    phone              TEXT,
    department         TEXT,
    designation        TEXT,
    reporting_manager  UUID REFERENCES employees(id),
    status             employee_status NOT NULL DEFAULT 'Active',
    join_date          DATE,
    offboard_date      DATE,
    notes              TEXT,
    created_by         UUID REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employees_status ON employees(status);
CREATE INDEX idx_employees_dept   ON employees(department);

-- =============================================================================
-- ASSETS  (columns per server.js/export.js: asset_tag, serial_number,
-- qr_code, hardware_class, vendor, model, purchase_price, purchase_date,
-- warranty_expiry, depreciation_years, status, location, notes,
-- created_by, created_at, updated_at)
--
-- chk_retired_no_location (added by migration-001.sql) requires location
-- to be NULL whenever status='Retired'. Until that migration runs, any
-- status value is allowed to carry a location.
-- =============================================================================

CREATE TABLE assets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_tag           TEXT NOT NULL UNIQUE,
    serial_number       TEXT NOT NULL UNIQUE,
    qr_code             TEXT,
    hardware_class      hardware_class NOT NULL,
    vendor              TEXT,
    model               TEXT NOT NULL,
    purchase_price      NUMERIC(12,2),
    purchase_date       DATE,
    warranty_expiry     DATE,
    depreciation_years  INTEGER,
    status              asset_status NOT NULL DEFAULT 'In-Hand',
    location            TEXT,
    notes               TEXT,
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assets_status ON assets(status);
CREATE INDEX idx_assets_class  ON assets(hardware_class);
CREATE INDEX idx_assets_tag    ON assets(asset_tag);

-- =============================================================================
-- ASSIGNMENTS  (columns per server.js/export.js: asset_id, employee_id,
-- assigned_at, assigned_by, returned_at, returned_by, return_notes)
-- =============================================================================

CREATE TABLE assignments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id      UUID NOT NULL REFERENCES assets(id),
    employee_id   UUID NOT NULL REFERENCES employees(id),
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by   UUID NOT NULL REFERENCES users(id),
    returned_at   TIMESTAMPTZ,
    returned_by   UUID REFERENCES users(id),
    return_notes  TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active (unreturned) assignment per asset at a time.
CREATE UNIQUE INDEX uniq_active_assignment_per_asset
    ON assignments(asset_id) WHERE returned_at IS NULL;

CREATE INDEX idx_assignments_employee ON assignments(employee_id);
CREATE INDEX idx_assignments_active   ON assignments(asset_id) WHERE returned_at IS NULL;

-- =============================================================================
-- ASSET HISTORY  (immutable ledger — columns per server.js/export.js:
-- asset_id, event_type, old_status, new_status, employee_id, performed_by,
-- notes, metadata, created_at)
-- =============================================================================

CREATE TABLE asset_history (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id     UUID NOT NULL REFERENCES assets(id),
    event_type   TEXT NOT NULL,
    old_status   asset_status,
    new_status   asset_status,
    employee_id  UUID REFERENCES employees(id),
    performed_by UUID REFERENCES users(id),
    notes        TEXT,
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_asset_history_asset ON asset_history(asset_id);
CREATE INDEX idx_asset_history_time  ON asset_history(created_at DESC);

-- =============================================================================
-- PROCUREMENT ALERTS  (columns per server.js: id, hardware_class, notes,
-- resolved_at, resolved_by, created_at, updated_at)
-- =============================================================================

CREATE TABLE procurement_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hardware_class  hardware_class NOT NULL,
    notes           TEXT,
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_procurement_alerts_open ON procurement_alerts(hardware_class) WHERE resolved_at IS NULL;

-- =============================================================================
-- AUDIT LOGS  (columns per server.js/export.js: audit_date, audit_type,
-- asset_id, employee_id, performed_by, verification_status, notes,
-- discrepancy_notes)
-- =============================================================================

CREATE TABLE audit_logs (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_date            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    audit_type            audit_type NOT NULL,
    asset_id              UUID REFERENCES assets(id),
    employee_id           UUID REFERENCES employees(id),
    performed_by          UUID NOT NULL REFERENCES users(id),
    verification_status   verification_status NOT NULL,
    notes                 TEXT,
    discrepancy_notes     TEXT
);

CREATE INDEX idx_audit_logs_date  ON audit_logs(audit_date DESC);
CREATE INDEX idx_audit_logs_asset ON audit_logs(asset_id);

-- =============================================================================
-- SESSIONS  (required by connect-pg-simple — exact shape it expects;
-- server.js sets createTableIfMissing: false and expects this to already
-- exist)
-- =============================================================================

CREATE TABLE sessions (
    sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
    sess   JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX idx_sessions_expire ON sessions(expire);

-- =============================================================================
-- VIEWS  (dashboard_inventory_summary / procurement_dashboard — recreated
-- with the 'Retired' column by migration-001.sql; this base version omits
-- it so the migration's DROP VIEW / CREATE VIEW pair has real work to do)
-- =============================================================================

CREATE VIEW dashboard_inventory_summary AS
SELECT
    hardware_class                                   AS class,
    COUNT(*)                                         AS total,
    COUNT(*) FILTER (WHERE status = 'Assigned')      AS assigned,
    COUNT(*) FILTER (WHERE status = 'In-Hand')       AS in_hand,
    COUNT(*) FILTER (WHERE status = 'Faulty')        AS faulty,
    COUNT(*) FILTER (WHERE status = 'Ordered')       AS ordered,
    COUNT(*) FILTER (WHERE status = 'Need to Order') AS need_to_order
FROM assets
GROUP BY hardware_class
ORDER BY hardware_class::text;

CREATE VIEW procurement_dashboard AS
SELECT
    dis.class                                                    AS hardware_class,
    dis.in_hand                                                  AS current_stock,
    CASE
        WHEN dis.in_hand < 5  THEN 'Critical'
        WHEN dis.in_hand = 5  THEN 'Warning'
        ELSE 'Normal'
    END                                                          AS threshold_status,
    COALESCE(al.open_alerts, 0)                                  AS open_alerts,
    al.latest_alert_date
FROM dashboard_inventory_summary dis
LEFT JOIN (
    SELECT
        hardware_class,
        COUNT(*)        AS open_alerts,
        MAX(created_at) AS latest_alert_date
    FROM procurement_alerts
    WHERE resolved_at IS NULL
    GROUP BY hardware_class
) al ON al.hardware_class = dis.class;

-- =============================================================================
-- STORED PROCEDURE: assign_asset
-- Called as: CALL assign_asset($1 asset_id, $2 employee_id, $3 assigned_by, $4 notes)
-- Asset must be In-Hand; employee must be Active.
-- =============================================================================

CREATE OR REPLACE PROCEDURE assign_asset(
    p_asset_id    UUID,
    p_employee_id UUID,
    p_assigned_by UUID,
    p_notes       TEXT DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_asset_status    asset_status;
    v_employee_status employee_status;
BEGIN
    SELECT status INTO v_asset_status FROM assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset % not found', p_asset_id USING ERRCODE = 'P0002';
    END IF;
    IF v_asset_status <> 'In-Hand' THEN
        RAISE EXCEPTION 'Asset is not available for assignment (current status: %)', v_asset_status
            USING ERRCODE = 'P0003';
    END IF;

    SELECT status INTO v_employee_status FROM employees WHERE id = p_employee_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Employee % not found', p_employee_id USING ERRCODE = 'P0002';
    END IF;
    IF v_employee_status <> 'Active' THEN
        RAISE EXCEPTION 'Employee is not active and cannot receive an assignment'
            USING ERRCODE = 'P0003';
    END IF;

    INSERT INTO assignments (asset_id, employee_id, assigned_by, return_notes)
    VALUES (p_asset_id, p_employee_id, p_assigned_by, NULL);

    UPDATE assets SET status = 'Assigned', updated_at = NOW() WHERE id = p_asset_id;

    INSERT INTO asset_history (asset_id, event_type, old_status, new_status, employee_id, performed_by, notes)
    VALUES (p_asset_id, 'Asset Assigned', v_asset_status, 'Assigned', p_employee_id, p_assigned_by,
            COALESCE(p_notes, 'Asset assigned to employee'));
END;
$$;

-- =============================================================================
-- STORED PROCEDURE: return_asset
-- Called as: CALL return_asset($1 asset_id, $2 returned_by, $3 notes)
-- Closes the active assignment and returns the asset to In-Hand.
-- =============================================================================

CREATE OR REPLACE PROCEDURE return_asset(
    p_asset_id    UUID,
    p_returned_by UUID,
    p_notes       TEXT DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_assignment_id UUID;
    v_employee_id   UUID;
    v_old_status    asset_status;
BEGIN
    SELECT status INTO v_old_status FROM assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset % not found', p_asset_id USING ERRCODE = 'P0002';
    END IF;

    SELECT id, employee_id INTO v_assignment_id, v_employee_id
    FROM assignments
    WHERE asset_id = p_asset_id AND returned_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset is not currently assigned' USING ERRCODE = 'P0003';
    END IF;

    UPDATE assignments
    SET returned_at  = NOW(),
        returned_by  = p_returned_by,
        return_notes = p_notes,
        updated_at   = NOW()
    WHERE id = v_assignment_id;

    UPDATE assets SET status = 'In-Hand', updated_at = NOW() WHERE id = p_asset_id;

    INSERT INTO asset_history (asset_id, event_type, old_status, new_status, employee_id, performed_by, notes)
    VALUES (p_asset_id, 'Asset Returned', v_old_status, 'In-Hand', v_employee_id, p_returned_by,
            COALESCE(p_notes, 'Asset returned to inventory'));
END;
$$;

-- =============================================================================
-- STORED PROCEDURE: mark_asset_faulty
-- Called as: CALL mark_asset_faulty($1 asset_id, $2 performed_by, $3 notes)
-- If the asset is currently assigned, the assignment is closed first
-- (mirrors retire_asset's pattern in migration-001.sql).
-- =============================================================================

CREATE OR REPLACE PROCEDURE mark_asset_faulty(
    p_asset_id     UUID,
    p_performed_by UUID,
    p_notes        TEXT DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_old_status    asset_status;
    v_assignment_id UUID;
    v_employee_id   UUID;
BEGIN
    SELECT status INTO v_old_status FROM assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset % not found', p_asset_id USING ERRCODE = 'P0002';
    END IF;
    IF v_old_status = 'Faulty' THEN
        RAISE EXCEPTION 'Asset is already marked Faulty' USING ERRCODE = 'P0003';
    END IF;
    IF v_old_status = 'Need to Order' THEN
        RAISE EXCEPTION 'Cannot mark a Need-to-Order placeholder as Faulty' USING ERRCODE = 'P0003';
    END IF;

    IF v_old_status = 'Assigned' THEN
        SELECT id, employee_id INTO v_assignment_id, v_employee_id
        FROM assignments
        WHERE asset_id = p_asset_id AND returned_at IS NULL
        FOR UPDATE;

        IF FOUND THEN
            UPDATE assignments
            SET returned_at  = NOW(),
                returned_by  = p_performed_by,
                return_notes = 'Assignment closed: asset marked faulty. ' || COALESCE(p_notes, ''),
                updated_at   = NOW()
            WHERE id = v_assignment_id;
        END IF;
    END IF;

    UPDATE assets SET status = 'Faulty', location = NULL, updated_at = NOW() WHERE id = p_asset_id;

    INSERT INTO asset_history (asset_id, event_type, old_status, new_status, employee_id, performed_by, notes, metadata)
    VALUES (p_asset_id, 'Marked Faulty', v_old_status, 'Faulty', v_employee_id, p_performed_by,
            COALESCE(p_notes, 'Asset marked faulty'),
            jsonb_build_object('previous_status', v_old_status, 'assignment_closed', v_assignment_id IS NOT NULL));
END;
$$;

-- =============================================================================
-- STORED PROCEDURE: repair_asset
-- Called as: CALL repair_asset($1 asset_id, $2 performed_by, $3 notes)
-- Moves a Faulty asset back to In-Hand. Does not restore any prior
-- assignment — the asset re-enters the pool and must be reassigned.
-- =============================================================================

CREATE OR REPLACE PROCEDURE repair_asset(
    p_asset_id     UUID,
    p_performed_by UUID,
    p_notes        TEXT DEFAULT NULL
)
LANGUAGE plpgsql AS $$
DECLARE
    v_old_status asset_status;
BEGIN
    SELECT status INTO v_old_status FROM assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset % not found', p_asset_id USING ERRCODE = 'P0002';
    END IF;
    IF v_old_status <> 'Faulty' THEN
        RAISE EXCEPTION 'Asset is not currently marked Faulty (current status: %)', v_old_status
            USING ERRCODE = 'P0003';
    END IF;

    UPDATE assets SET status = 'In-Hand', updated_at = NOW() WHERE id = p_asset_id;

    INSERT INTO asset_history (asset_id, event_type, old_status, new_status, performed_by, notes)
    VALUES (p_asset_id, 'Repaired', v_old_status, 'In-Hand', p_performed_by,
            COALESCE(p_notes, 'Asset repaired and returned to inventory'));
END;
$$;

-- =============================================================================
-- TRIGGER: low-stock procurement alert
-- Whenever an asset's status changes (or a new In-Hand asset is inserted),
-- check if that hardware class has dropped to or below the 5-unit warning
-- threshold used by procurement_dashboard, and open an alert if one isn't
-- already outstanding for that class.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_check_procurement_threshold()
RETURNS TRIGGER AS $$
DECLARE
    v_in_hand INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_in_hand
    FROM assets
    WHERE hardware_class = COALESCE(NEW.hardware_class, OLD.hardware_class)
      AND status = 'In-Hand';

    IF v_in_hand <= 5 THEN
        IF NOT EXISTS (
            SELECT 1 FROM procurement_alerts
            WHERE hardware_class = COALESCE(NEW.hardware_class, OLD.hardware_class)
              AND resolved_at IS NULL
        ) THEN
            INSERT INTO procurement_alerts (hardware_class, notes)
            VALUES (
                COALESCE(NEW.hardware_class, OLD.hardware_class),
                'Auto-generated: In-Hand stock at ' || v_in_hand || ' unit(s).'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assets_procurement_check
    AFTER INSERT OR UPDATE OF status ON assets
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_procurement_threshold();

COMMIT;
