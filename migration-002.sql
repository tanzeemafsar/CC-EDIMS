-- =============================================================================
-- EDIMS — migration-002.sql
-- Adds configurable per-hardware-class procurement thresholds.
-- Apply after schema.sql AND migration-001.sql have been applied.
-- Run: psql "$DATABASE_URL" -f migration-002.sql
--
-- What this changes:
--   - New table `procurement_thresholds` — one row per hardware_class, each
--     with its own low-stock threshold (previously hardcoded at 5 for every
--     class inside the trigger function).
--   - `fn_check_procurement_threshold` now reads the threshold for the
--     class that changed, falling back to 5 if that class has no row yet
--     (keeps old behavior for any class you haven't configured).
--   - `procurement_dashboard` view now exposes `threshold_qty` and computes
--     `threshold_status` against it instead of a hardcoded 5/<5 split.
--   - A new trigger on `procurement_thresholds` re-evaluates stock for a
--     class immediately when its threshold is edited, so lowering a
--     threshold below current stock doesn't silently miss opening an alert
--     until the next asset status change.
-- =============================================================================

BEGIN;

-- =============================================================================
-- TABLE: procurement_thresholds
-- =============================================================================
CREATE TABLE IF NOT EXISTS procurement_thresholds (
    hardware_class  hardware_class PRIMARY KEY,
    threshold_qty   INTEGER NOT NULL DEFAULT 5 CHECK (threshold_qty >= 0),
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a default row (threshold = 5, matching the old hardcoded behavior)
-- for every hardware_class that doesn't have one yet. Safe to re-run.
INSERT INTO procurement_thresholds (hardware_class, threshold_qty)
SELECT unnest(enum_range(NULL::hardware_class)), 5
ON CONFLICT (hardware_class) DO NOTHING;

-- =============================================================================
-- FUNCTION: fn_evaluate_procurement_threshold
-- Shared logic — checks current In-Hand stock for one hardware_class
-- against its configured threshold and opens an alert if needed and one
-- isn't already outstanding. Called from both triggers below.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_evaluate_procurement_threshold(p_class hardware_class)
RETURNS VOID AS $$
DECLARE
    v_in_hand   INTEGER;
    v_threshold INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_in_hand
    FROM assets
    WHERE hardware_class = p_class AND status = 'In-Hand';

    SELECT threshold_qty INTO v_threshold
    FROM procurement_thresholds
    WHERE hardware_class = p_class;

    IF v_threshold IS NULL THEN
        v_threshold := 5; -- fallback for a class with no configured row
    END IF;

    IF v_in_hand <= v_threshold THEN
        IF NOT EXISTS (
            SELECT 1 FROM procurement_alerts
            WHERE hardware_class = p_class AND resolved_at IS NULL
        ) THEN
            INSERT INTO procurement_alerts (hardware_class, notes)
            VALUES (
                p_class,
                'Auto-generated: In-Hand stock at ' || v_in_hand ||
                ' unit(s), at or below threshold of ' || v_threshold || '.'
            );
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Replace the old fixed-threshold trigger function to delegate to the
-- shared, threshold-aware evaluator above.
CREATE OR REPLACE FUNCTION fn_check_procurement_threshold()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM fn_evaluate_procurement_threshold(COALESCE(NEW.hardware_class, OLD.hardware_class));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (trg_assets_procurement_check already points at fn_check_procurement_threshold
-- by name, so no need to re-create that trigger — CREATE OR REPLACE above is enough.)

-- =============================================================================
-- TRIGGER: re-evaluate immediately when a threshold is edited
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_check_procurement_threshold_on_edit()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM fn_evaluate_procurement_threshold(NEW.hardware_class);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_thresholds_recheck ON procurement_thresholds;
CREATE TRIGGER trg_thresholds_recheck
    AFTER INSERT OR UPDATE OF threshold_qty ON procurement_thresholds
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_procurement_threshold_on_edit();

-- =============================================================================
-- VIEW: procurement_dashboard — now threshold-aware per class
-- =============================================================================
DROP VIEW IF EXISTS procurement_dashboard;

CREATE VIEW procurement_dashboard AS
SELECT
    dis.class                                                    AS hardware_class,
    dis.in_hand                                                  AS current_stock,
    COALESCE(pt.threshold_qty, 5)                                AS threshold_qty,
    CASE
        WHEN dis.in_hand < COALESCE(pt.threshold_qty, 5)  THEN 'Critical'
        WHEN dis.in_hand = COALESCE(pt.threshold_qty, 5)  THEN 'Warning'
        ELSE 'Normal'
    END                                                          AS threshold_status,
    COALESCE(al.open_alerts, 0)                                  AS open_alerts,
    al.latest_alert_date
FROM dashboard_inventory_summary dis
LEFT JOIN procurement_thresholds pt ON pt.hardware_class = dis.class
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
-- Verify migration applied correctly
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM procurement_thresholds LIMIT 1) THEN
        RAISE EXCEPTION 'Migration verification failed: procurement_thresholds has no rows';
    END IF;
    RAISE NOTICE 'Migration 002 applied successfully — per-class procurement thresholds are active.';
END;
$$;

COMMIT;
