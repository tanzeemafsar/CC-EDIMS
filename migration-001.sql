-- =============================================================================
-- EDIMS — migration-001.sql
-- Adds 'Retired' asset lifecycle state
-- Apply after schema.sql has been successfully initialised
-- Run: psql "$DATABASE_URL" -f migration-001.sql
-- =============================================================================

BEGIN;

-- PostgreSQL ADD VALUE is transactional only in PG16+ with certain settings.
-- We use IF NOT EXISTS so re-running this migration is safe.
ALTER TYPE asset_status ADD VALUE IF NOT EXISTS 'Retired';

-- Commit here first — ADD VALUE cannot be used in the same transaction
-- as objects that depend on the enum in some PG versions.
COMMIT;

BEGIN;

-- =============================================================================
-- Additional constraint: Retired assets must have no physical location
-- (they are permanently out of service)
-- =============================================================================
ALTER TABLE assets
    DROP CONSTRAINT IF EXISTS chk_retired_no_location;

ALTER TABLE assets
    ADD CONSTRAINT chk_retired_no_location
        CHECK (NOT (status = 'Retired' AND location IS NOT NULL));

-- =============================================================================
-- Update dashboard_inventory_summary view to include Retired count
-- =============================================================================
DROP VIEW IF EXISTS procurement_dashboard;    -- depends on dashboard_inventory_summary
DROP VIEW IF EXISTS dashboard_inventory_summary;

CREATE VIEW dashboard_inventory_summary AS
SELECT
    hardware_class                                               AS class,
    COUNT(*)                                                     AS total,
    COUNT(*) FILTER (WHERE status = 'Assigned')                  AS assigned,
    COUNT(*) FILTER (WHERE status = 'In-Hand')                   AS in_hand,
    COUNT(*) FILTER (WHERE status = 'Faulty')                    AS faulty,
    COUNT(*) FILTER (WHERE status = 'Ordered')                   AS ordered,
    COUNT(*) FILTER (WHERE status = 'Need to Order')             AS need_to_order,
    COUNT(*) FILTER (WHERE status = 'Retired')                   AS retired
FROM assets
GROUP BY hardware_class
ORDER BY hardware_class::text;

-- Recreate procurement_dashboard (depends on dashboard_inventory_summary)
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
-- STORED PROCEDURE: retire_asset
-- Permanently retires an asset from service.
-- Closes any active assignment, moves asset to Retired state,
-- and writes an immutable history entry.
-- Retired assets cannot be re-assigned or repaired via normal flow.
-- An Admin must manually change status if reclassification is needed.
-- =============================================================================

CREATE OR REPLACE PROCEDURE retire_asset(
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
    SELECT status INTO v_old_status
    FROM assets
    WHERE id = p_asset_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset % not found', p_asset_id
            USING ERRCODE = 'P0002';
    END IF;

    IF v_old_status = 'Retired' THEN
        RAISE EXCEPTION 'Asset is already Retired'
            USING ERRCODE = 'P0003';
    END IF;

    IF v_old_status = 'Need to Order' THEN
        RAISE EXCEPTION 'Cannot retire a Need-to-Order placeholder. Delete it instead.'
            USING ERRCODE = 'P0003';
    END IF;

    -- Close any active assignment before retiring
    IF v_old_status = 'Assigned' THEN
        SELECT id, employee_id INTO v_assignment_id, v_employee_id
        FROM assignments
        WHERE asset_id = p_asset_id AND returned_at IS NULL
        FOR UPDATE;

        IF FOUND THEN
            UPDATE assignments
            SET returned_at  = NOW(),
                returned_by  = p_performed_by,
                return_notes = 'Assignment closed: asset retired. ' || COALESCE(p_notes, ''),
                updated_at   = NOW()
            WHERE id = v_assignment_id;
        END IF;
    END IF;

    -- Retire: remove location, clear assignment state
    UPDATE assets
    SET status     = 'Retired',
        location   = NULL,
        updated_at = NOW()
    WHERE id = p_asset_id;

    INSERT INTO asset_history (
        asset_id, event_type, old_status, new_status,
        employee_id, performed_by, notes, metadata, created_at
    ) VALUES (
        p_asset_id, 'Asset Retired', v_old_status, 'Retired',
        v_employee_id, p_performed_by,
        COALESCE(p_notes, 'Asset permanently retired from service'),
        jsonb_build_object(
            'previous_status',   v_old_status,
            'assignment_closed', v_assignment_id IS NOT NULL,
            'retired_at',        NOW()
        ),
        NOW()
    );
END;
$$;

-- =============================================================================
-- Verify migration applied correctly
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'asset_status' AND e.enumlabel = 'Retired'
    ) THEN
        RAISE EXCEPTION 'Migration verification failed: Retired enum value not found';
    END IF;
    RAISE NOTICE 'Migration 001 applied successfully — Retired status is active.';
END;
$$;

COMMIT;
