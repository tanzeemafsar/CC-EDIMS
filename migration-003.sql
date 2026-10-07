-- =============================================================================
-- EDIMS — migration-003.sql
-- Replaces the fixed `hardware_class` enum with admin-managed device
-- categories and subcategories.
-- Apply after schema.sql, migration-001.sql AND migration-002.sql.
-- Run: psql "$DATABASE_URL" -f migration-003.sql
--
-- What this changes:
--   - New table `device_categories` — a two-level tree. Top-level rows
--     (parent_id IS NULL) are categories, e.g. "Computers"; rows with a
--     parent are subcategories, e.g. "Computers / MacBook". Devices are
--     always filed under a subcategory.
--   - The 7 old hardware_class values are seeded as subcategories under 5
--     categories, and every existing asset, procurement alert and threshold
--     is re-pointed at the matching subcategory. No data is lost.
--   - assets.hardware_class, procurement_alerts.hardware_class and
--     procurement_thresholds.hardware_class are replaced by `category_id`,
--     and the `hardware_class` enum type is dropped.
--   - Procurement thresholds/alerts now work per subcategory. Moving an
--     asset to a different subcategory re-checks stock for both the old and
--     the new one.
--   - Views are rebuilt: `device_category_paths` (new helper),
--     `dashboard_inventory_summary` and `procurement_dashboard`.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.procurement_thresholds') IS NULL THEN
        RAISE EXCEPTION 'migration-003 requires migration-002.sql to be applied first';
    END IF;
    IF to_regclass('public.device_categories') IS NOT NULL THEN
        RAISE EXCEPTION 'migration-003 has already been applied (device_categories exists)';
    END IF;
END;
$$;

-- =============================================================================
-- TABLE: device_categories
-- =============================================================================
CREATE TABLE device_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id   UUID REFERENCES device_categories(id) ON DELETE RESTRICT,
    name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (parent_id IS DISTINCT FROM id)
);

-- Names are unique (case-insensitively) among siblings: two top-level
-- categories can't share a name, nor can two subcategories of one parent.
CREATE UNIQUE INDEX uniq_device_categories_sibling_name
    ON device_categories (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX idx_device_categories_parent ON device_categories(parent_id);

-- Keep the tree exactly two levels deep: a subcategory's parent must be a
-- top-level category, and a row can't switch between the two levels.
CREATE OR REPLACE FUNCTION fn_device_categories_enforce_depth()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (OLD.parent_id IS NULL) <> (NEW.parent_id IS NULL) THEN
        RAISE EXCEPTION 'A category cannot be turned into a subcategory (or vice versa)'
            USING ERRCODE = 'P0003';
    END IF;
    IF NEW.parent_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM device_categories WHERE id = NEW.parent_id AND parent_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'A subcategory cannot contain further subcategories'
            USING ERRCODE = 'P0003';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_device_categories_depth
    BEFORE INSERT OR UPDATE OF parent_id ON device_categories
    FOR EACH ROW
    EXECUTE FUNCTION fn_device_categories_enforce_depth();

-- =============================================================================
-- SEED — the old fixed hardware types, grouped under categories. Subcategory
-- names match the old enum labels exactly so the backfills below can join
-- on them.
-- =============================================================================
INSERT INTO device_categories (name, sort_order) VALUES
    ('Computers',     10),
    ('Displays',      20),
    ('Audio',         30),
    ('Input Devices', 40),
    ('Other',         50);

INSERT INTO device_categories (parent_id, name, sort_order)
SELECT p.id, m.sub, m.ord
FROM (VALUES
    ('Computers',     'MacBook',       10),
    ('Computers',     'Laptop',        20),
    ('Displays',      'Monitor',       10),
    ('Audio',         'Jabra Headset', 10),
    ('Input Devices', 'Keyboard',      10),
    ('Input Devices', 'Mouse',         20),
    ('Other',         'Peripheral',    10)
) AS m(cat, sub, ord)
JOIN device_categories p ON p.parent_id IS NULL AND p.name = m.cat;

-- Guard: every enum label must have a subcategory to migrate onto.
DO $$
DECLARE
    v_missing TEXT;
BEGIN
    SELECT string_agg(e::text, ', ') INTO v_missing
    FROM unnest(enum_range(NULL::hardware_class)) AS e
    WHERE NOT EXISTS (
        SELECT 1 FROM device_categories c WHERE c.parent_id IS NOT NULL AND c.name = e::text
    );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'No subcategory seeded for hardware_class value(s): %', v_missing;
    END IF;
END;
$$;

-- =============================================================================
-- Drop everything that depends on the hardware_class columns / type
-- =============================================================================
DROP VIEW IF EXISTS procurement_dashboard;
DROP VIEW IF EXISTS dashboard_inventory_summary;

DROP TRIGGER IF EXISTS trg_assets_procurement_check ON assets;
DROP TRIGGER IF EXISTS trg_thresholds_recheck ON procurement_thresholds;
DROP FUNCTION IF EXISTS fn_evaluate_procurement_threshold(hardware_class);

-- =============================================================================
-- ASSETS: hardware_class -> category_id
-- =============================================================================
ALTER TABLE assets ADD COLUMN category_id UUID REFERENCES device_categories(id) ON DELETE RESTRICT;

UPDATE assets a
SET category_id = c.id
FROM device_categories c
WHERE c.parent_id IS NOT NULL AND c.name = a.hardware_class::text;

ALTER TABLE assets ALTER COLUMN category_id SET NOT NULL;
DROP INDEX IF EXISTS idx_assets_class;
ALTER TABLE assets DROP COLUMN hardware_class;
CREATE INDEX idx_assets_category ON assets(category_id);

-- =============================================================================
-- PROCUREMENT ALERTS: hardware_class -> category_id
-- Alerts belong to their subcategory; deleting an (unused) subcategory
-- removes its alert history with it.
-- =============================================================================
ALTER TABLE procurement_alerts ADD COLUMN category_id UUID REFERENCES device_categories(id) ON DELETE CASCADE;

UPDATE procurement_alerts pa
SET category_id = c.id
FROM device_categories c
WHERE c.parent_id IS NOT NULL AND c.name = pa.hardware_class::text;

ALTER TABLE procurement_alerts ALTER COLUMN category_id SET NOT NULL;
DROP INDEX IF EXISTS idx_procurement_alerts_open;
ALTER TABLE procurement_alerts DROP COLUMN hardware_class;
CREATE INDEX idx_procurement_alerts_open ON procurement_alerts(category_id) WHERE resolved_at IS NULL;

-- =============================================================================
-- PROCUREMENT THRESHOLDS: hardware_class -> category_id (new primary key)
-- =============================================================================
ALTER TABLE procurement_thresholds ADD COLUMN category_id UUID REFERENCES device_categories(id) ON DELETE CASCADE;

UPDATE procurement_thresholds pt
SET category_id = c.id
FROM device_categories c
WHERE c.parent_id IS NOT NULL AND c.name = pt.hardware_class::text;

ALTER TABLE procurement_thresholds DROP COLUMN hardware_class;  -- also drops the old primary key
ALTER TABLE procurement_thresholds ADD PRIMARY KEY (category_id);

DROP TYPE hardware_class;

-- =============================================================================
-- Devices, alerts and thresholds may only point at subcategories
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_require_subcategory()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM device_categories WHERE id = NEW.category_id AND parent_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'category_id must reference a subcategory, not a top-level category'
            USING ERRCODE = 'P0003';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assets_require_subcategory
    BEFORE INSERT OR UPDATE OF category_id ON assets
    FOR EACH ROW EXECUTE FUNCTION fn_require_subcategory();

CREATE TRIGGER trg_procurement_alerts_require_subcategory
    BEFORE INSERT OR UPDATE OF category_id ON procurement_alerts
    FOR EACH ROW EXECUTE FUNCTION fn_require_subcategory();

CREATE TRIGGER trg_procurement_thresholds_require_subcategory
    BEFORE INSERT OR UPDATE OF category_id ON procurement_thresholds
    FOR EACH ROW EXECUTE FUNCTION fn_require_subcategory();

-- =============================================================================
-- FUNCTION: fn_evaluate_procurement_threshold — now per subcategory.
-- Inactive subcategories never auto-open alerts.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_evaluate_procurement_threshold(p_category_id UUID)
RETURNS VOID AS $$
DECLARE
    v_in_hand   INTEGER;
    v_threshold INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM device_categories
        WHERE id = p_category_id AND parent_id IS NOT NULL AND is_active
    ) THEN
        RETURN;
    END IF;

    SELECT COUNT(*) INTO v_in_hand
    FROM assets
    WHERE category_id = p_category_id AND status = 'In-Hand';

    SELECT threshold_qty INTO v_threshold
    FROM procurement_thresholds
    WHERE category_id = p_category_id;

    IF v_threshold IS NULL THEN
        v_threshold := 5; -- fallback for a subcategory with no configured row
    END IF;

    IF v_in_hand <= v_threshold THEN
        IF NOT EXISTS (
            SELECT 1 FROM procurement_alerts
            WHERE category_id = p_category_id AND resolved_at IS NULL
        ) THEN
            INSERT INTO procurement_alerts (category_id, notes)
            VALUES (
                p_category_id,
                'Auto-generated: In-Hand stock at ' || v_in_hand ||
                ' unit(s), at or below threshold of ' || v_threshold || '.'
            );
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_check_procurement_threshold()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM fn_evaluate_procurement_threshold(NEW.category_id);
    -- A device moved to another subcategory lowers the old one's stock too.
    IF TG_OP = 'UPDATE' AND OLD.category_id IS DISTINCT FROM NEW.category_id THEN
        PERFORM fn_evaluate_procurement_threshold(OLD.category_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assets_procurement_check
    AFTER INSERT OR UPDATE OF status, category_id ON assets
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_procurement_threshold();

CREATE OR REPLACE FUNCTION fn_check_procurement_threshold_on_edit()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM fn_evaluate_procurement_threshold(NEW.category_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_thresholds_recheck
    AFTER INSERT OR UPDATE OF threshold_qty ON procurement_thresholds
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_procurement_threshold_on_edit();

-- =============================================================================
-- VIEWS
-- =============================================================================

-- One row per subcategory with its parent category's name, for joins.
CREATE VIEW device_category_paths AS
SELECT
    s.id,
    s.name                      AS subcategory,
    p.id                        AS parent_id,
    p.name                      AS category,
    p.name || ' / ' || s.name   AS path,
    (s.is_active AND p.is_active) AS is_active,
    p.sort_order                AS category_sort,
    s.sort_order                AS subcategory_sort
FROM device_categories s
JOIN device_categories p ON p.id = s.parent_id;

-- Per-subcategory stock breakdown. Active subcategories are listed even
-- when empty; inactive ones only while they still hold devices.
CREATE VIEW dashboard_inventory_summary AS
SELECT
    cp.id                                                        AS category_id,
    cp.category,
    cp.subcategory,
    COUNT(a.id)                                                  AS total,
    COUNT(a.id) FILTER (WHERE a.status = 'Assigned')             AS assigned,
    COUNT(a.id) FILTER (WHERE a.status = 'In-Hand')              AS in_hand,
    COUNT(a.id) FILTER (WHERE a.status = 'Faulty')               AS faulty,
    COUNT(a.id) FILTER (WHERE a.status = 'Ordered')              AS ordered,
    COUNT(a.id) FILTER (WHERE a.status = 'Need to Order')        AS need_to_order,
    COUNT(a.id) FILTER (WHERE a.status = 'Retired')              AS retired
FROM device_category_paths cp
LEFT JOIN assets a ON a.category_id = cp.id
GROUP BY cp.id, cp.category, cp.subcategory, cp.is_active, cp.category_sort, cp.subcategory_sort
HAVING cp.is_active OR COUNT(a.id) > 0
ORDER BY cp.category_sort, cp.category, cp.subcategory_sort, cp.subcategory;

CREATE VIEW procurement_dashboard AS
SELECT
    dis.category_id,
    dis.category,
    dis.subcategory,
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
LEFT JOIN procurement_thresholds pt ON pt.category_id = dis.category_id
LEFT JOIN (
    SELECT
        category_id,
        COUNT(*)        AS open_alerts,
        MAX(created_at) AS latest_alert_date
    FROM procurement_alerts
    WHERE resolved_at IS NULL
    GROUP BY category_id
) al ON al.category_id = dis.category_id;

-- =============================================================================
-- Verify migration applied correctly
-- =============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM assets WHERE category_id IS NULL) THEN
        RAISE EXCEPTION 'Migration verification failed: assets without a category';
    END IF;
    RAISE NOTICE 'Migration 003 applied successfully — device categories are active.';
END;
$$;

COMMIT;
