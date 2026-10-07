-- =============================================================================
-- EDIMS — migration-004.sql
-- Reference data (vendors, departments/locations), product catalogue,
-- receipt uploads, and invoices (chargeback + purchase).
-- Apply after migration-003.sql.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migration-004.sql
--
-- What this changes:
--   - New `vendors` and `locations` reference tables. Existing free-text
--     values in assets.vendor, assets.location and employees.department are
--     collected into them (case-insensitive duplicates merged onto one
--     spelling), and those columns become foreign keys to the reference
--     name with ON UPDATE CASCADE — renaming a vendor or location renames it
--     everywhere. Existing queries that read the text columns keep working.
--   - New `catalog_items` table (approved models). Seeded with every
--     distinct category/vendor/model already in inventory, and each asset is
--     linked to its catalogue entry via assets.catalog_item_id.
--   - New `receipts` table + `asset_receipts` / `invoice_receipts` link
--     tables. Files live on disk (uploads/receipts), not in the database.
--   - New `invoices` / `invoice_lines` tables, with gapless per-year
--     numbering (INV-YYYY-NNNN chargeback, PUR-YYYY-NNNN purchase) assigned
--     when an invoice is issued. Issued invoices are immutable.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.device_categories') IS NULL THEN
        RAISE EXCEPTION 'migration-004 requires migration-003.sql to be applied first';
    END IF;
    IF to_regclass('public.vendors') IS NOT NULL THEN
        RAISE EXCEPTION 'migration-004 has already been applied (vendors exists)';
    END IF;
END;
$$;

-- =============================================================================
-- REFERENCE DATA: vendors, locations
-- =============================================================================
CREATE TABLE vendors (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL UNIQUE CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
    contact_name TEXT,
    email        TEXT,
    phone        TEXT,
    address      TEXT,
    website      TEXT,
    notes        TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uniq_vendors_name_ci ON vendors (lower(name));

-- Departments / locations — used for assets.location, employees.department
-- and chargeback invoices.
CREATE TABLE locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uniq_locations_name_ci ON locations (lower(name));

-- Normalise existing free text: trim, blank -> NULL
UPDATE assets    SET vendor     = NULLIF(btrim(vendor), '')     WHERE vendor     IS DISTINCT FROM NULLIF(btrim(vendor), '');
UPDATE assets    SET location   = NULLIF(btrim(location), '')   WHERE location   IS DISTINCT FROM NULLIF(btrim(location), '');
UPDATE employees SET department = NULLIF(btrim(department), '') WHERE department IS DISTINCT FROM NULLIF(btrim(department), '');

-- Where spellings differ only by case, keep the most-used one; on a tie,
-- prefer one that isn't all lower-case ("Apple" over "apple").
INSERT INTO vendors (name)
SELECT DISTINCT ON (lower(n)) n
FROM (SELECT vendor AS n, COUNT(*) AS uses FROM assets WHERE vendor IS NOT NULL GROUP BY vendor) s
ORDER BY lower(n), uses DESC, (n = lower(n)), n;

INSERT INTO locations (name)
SELECT DISTINCT ON (lower(n)) n
FROM (
    SELECT n, COUNT(*) AS uses
    FROM (SELECT location AS n FROM assets UNION ALL SELECT department FROM employees) u
    WHERE n IS NOT NULL
    GROUP BY n
) s
ORDER BY lower(n), uses DESC, (n = lower(n)), n;

-- Point case-variant spellings at the one kept in the reference table
UPDATE assets a    SET vendor = v.name     FROM vendors v   WHERE lower(a.vendor) = lower(v.name)     AND a.vendor <> v.name;
UPDATE assets a    SET location = l.name   FROM locations l WHERE lower(a.location) = lower(l.name)   AND a.location <> l.name;
UPDATE employees e SET department = l.name FROM locations l WHERE lower(e.department) = lower(l.name) AND e.department <> l.name;

ALTER TABLE assets ADD CONSTRAINT fk_assets_vendor
    FOREIGN KEY (vendor) REFERENCES vendors(name) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE assets ADD CONSTRAINT fk_assets_location
    FOREIGN KEY (location) REFERENCES locations(name) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE employees ADD CONSTRAINT fk_employees_department
    FOREIGN KEY (department) REFERENCES locations(name) ON UPDATE CASCADE ON DELETE RESTRICT;

-- =============================================================================
-- PRODUCT CATALOGUE
-- =============================================================================
CREATE TABLE catalog_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id         UUID NOT NULL REFERENCES device_categories(id) ON DELETE RESTRICT,
    vendor              TEXT REFERENCES vendors(name) ON UPDATE CASCADE ON DELETE RESTRICT,
    model               TEXT NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 200),
    part_number         TEXT,
    description         TEXT,
    specs               JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(specs) = 'object'),
    standard_price      NUMERIC(12,2) CHECK (standard_price >= 0),
    warranty_months     INTEGER CHECK (warranty_months BETWEEN 0 AND 240),
    depreciation_years  INTEGER CHECK (depreciation_years BETWEEN 0 AND 50),
    image_url           TEXT,
    source_url          TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uniq_catalog_items_model
    ON catalog_items (category_id, lower(COALESCE(vendor, '')), lower(model));
CREATE INDEX idx_catalog_items_category ON catalog_items(category_id);

CREATE TRIGGER trg_catalog_items_require_subcategory
    BEFORE INSERT OR UPDATE OF category_id ON catalog_items
    FOR EACH ROW EXECUTE FUNCTION fn_require_subcategory();

-- Seed from inventory: one entry per distinct category/vendor/model, using
-- the most recently registered unit's price/depreciation as the standard.
INSERT INTO catalog_items (category_id, vendor, model, standard_price, depreciation_years)
SELECT DISTINCT ON (category_id, lower(COALESCE(vendor, '')), lower(btrim(model)))
       category_id, vendor, btrim(model), purchase_price, depreciation_years
FROM assets
ORDER BY category_id, lower(COALESCE(vendor, '')), lower(btrim(model)), created_at DESC;

-- ...but name it with the most-used spelling of the model (same rule as
-- vendors above), not whichever unit happened to be registered last.
UPDATE catalog_items ci
SET model = best.m
FROM (
    SELECT DISTINCT ON (category_id, lower(COALESCE(vendor, '')), lower(m)) category_id, vendor, m
    FROM (SELECT category_id, vendor, btrim(model) AS m, COUNT(*) AS uses
          FROM assets GROUP BY category_id, vendor, btrim(model)) s
    ORDER BY category_id, lower(COALESCE(vendor, '')), lower(m), uses DESC, (m = lower(m)), m
) best
WHERE best.category_id = ci.category_id
  AND lower(COALESCE(best.vendor, '')) = lower(COALESCE(ci.vendor, ''))
  AND lower(best.m) = lower(ci.model)
  AND best.m <> ci.model;

ALTER TABLE assets ADD COLUMN catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL;
CREATE INDEX idx_assets_catalog_item ON assets(catalog_item_id);

UPDATE assets a
SET catalog_item_id = ci.id
FROM catalog_items ci
WHERE ci.category_id = a.category_id
  AND lower(COALESCE(ci.vendor, '')) = lower(COALESCE(a.vendor, ''))
  AND lower(ci.model) = lower(btrim(a.model));

-- =============================================================================
-- RECEIPTS
-- =============================================================================
CREATE TABLE receipts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL UNIQUE,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256        CHAR(64) NOT NULL,
    description   TEXT,
    uploaded_by   UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_receipts_created ON receipts(created_at DESC);

CREATE TABLE asset_receipts (
    asset_id   UUID NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    linked_by  UUID REFERENCES users(id),
    linked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (asset_id, receipt_id)
);
CREATE INDEX idx_asset_receipts_receipt ON asset_receipts(receipt_id);

-- =============================================================================
-- INVOICES
-- =============================================================================
CREATE TYPE invoice_type   AS ENUM ('Chargeback', 'Purchase');
CREATE TYPE invoice_status AS ENUM ('Draft', 'Issued', 'Paid', 'Void');

-- Gapless per-prefix, per-year counters. The upsert row-locks the counter,
-- so concurrent issues serialise, and a rolled-back issue rolls the counter
-- back with it — no skipped numbers.
CREATE TABLE invoice_counters (
    prefix     TEXT    NOT NULL,
    year       INTEGER NOT NULL,
    last_value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (prefix, year)
);

CREATE OR REPLACE FUNCTION fn_next_invoice_number(p_prefix TEXT, p_year INTEGER)
RETURNS TEXT AS $$
DECLARE
    v INTEGER;
BEGIN
    INSERT INTO invoice_counters (prefix, year, last_value)
    VALUES (p_prefix, p_year, 1)
    ON CONFLICT (prefix, year) DO UPDATE SET last_value = invoice_counters.last_value + 1
    RETURNING last_value INTO v;
    RETURN p_prefix || '-' || p_year || '-' || lpad(v::text, GREATEST(4, length(v::text)), '0');
END;
$$ LANGUAGE plpgsql;

CREATE TABLE invoices (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_type          invoice_type   NOT NULL,
    invoice_number        TEXT UNIQUE,
    status                invoice_status NOT NULL DEFAULT 'Draft',
    -- Chargeback: billed to an employee and/or a department
    employee_id           UUID REFERENCES employees(id),
    department            TEXT REFERENCES locations(name) ON UPDATE CASCADE ON DELETE RESTRICT,
    -- Purchase: received from a vendor
    vendor                TEXT REFERENCES vendors(name) ON UPDATE CASCADE ON DELETE RESTRICT,
    vendor_invoice_number TEXT,
    invoice_date          DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date              DATE,
    currency              CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    tax_rate              NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
    subtotal              NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
    total                 NUMERIC(14,2) NOT NULL DEFAULT 0,
    notes                 TEXT,
    issued_at             TIMESTAMPTZ,
    issued_by             UUID REFERENCES users(id),
    paid_at               TIMESTAMPTZ,
    paid_by               UUID REFERENCES users(id),
    payment_reference     TEXT,
    voided_at             TIMESTAMPTZ,
    voided_by             UUID REFERENCES users(id),
    void_reason           TEXT,
    created_by            UUID REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (due_date IS NULL OR due_date >= invoice_date),
    CHECK (invoice_type <> 'Purchase'   OR vendor IS NOT NULL),
    CHECK (invoice_type <> 'Chargeback' OR employee_id IS NOT NULL OR department IS NOT NULL),
    CHECK ((status = 'Draft') = (invoice_number IS NULL))
);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_type   ON invoices(invoice_type);
CREATE INDEX idx_invoices_date   ON invoices(invoice_date DESC);

CREATE TABLE invoice_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_no         INTEGER NOT NULL CHECK (line_no > 0),
    asset_id        UUID REFERENCES assets(id) ON DELETE SET NULL,
    catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
    description     TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
    quantity        NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    unit_price      NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    line_total      NUMERIC(14,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
    UNIQUE (invoice_id, line_no)
);
CREATE INDEX idx_invoice_lines_asset ON invoice_lines(asset_id);

CREATE TABLE invoice_receipts (
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    linked_by  UUID REFERENCES users(id),
    linked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (invoice_id, receipt_id)
);
CREATE INDEX idx_invoice_receipts_receipt ON invoice_receipts(receipt_id);

-- Recompute subtotal / tax / total from the lines
CREATE OR REPLACE FUNCTION fn_recalc_invoice(p_id UUID)
RETURNS VOID AS $$
    UPDATE invoices i
    SET subtotal   = s.sub,
        tax_amount = round(s.sub * i.tax_rate / 100, 2),
        total      = s.sub + round(s.sub * i.tax_rate / 100, 2),
        updated_at = NOW()
    FROM (SELECT COALESCE(SUM(line_total), 0) AS sub FROM invoice_lines WHERE invoice_id = p_id) s
    WHERE i.id = p_id;
$$ LANGUAGE sql;

-- Issued/paid/void invoices are a permanent record: their lines can't
-- change and they can't be deleted (void them instead).
CREATE OR REPLACE FUNCTION fn_invoice_lines_draft_only()
RETURNS TRIGGER AS $$
DECLARE
    v_status invoice_status;
BEGIN
    SELECT status INTO v_status FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
    IF FOUND AND v_status <> 'Draft' THEN
        RAISE EXCEPTION 'Invoice lines can only be changed while the invoice is a Draft'
            USING ERRCODE = 'P0003';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_lines_draft_only
    BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
    FOR EACH ROW EXECUTE FUNCTION fn_invoice_lines_draft_only();

CREATE OR REPLACE FUNCTION fn_invoices_no_delete_issued()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'Draft' THEN
        RAISE EXCEPTION 'Only Draft invoices can be deleted; void it instead'
            USING ERRCODE = 'P0003';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_no_delete_issued
    BEFORE DELETE ON invoices
    FOR EACH ROW EXECUTE FUNCTION fn_invoices_no_delete_issued();

-- =============================================================================
-- Verify migration applied correctly
-- =============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM assets a WHERE a.vendor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vendors v WHERE v.name = a.vendor)) THEN
        RAISE EXCEPTION 'Migration verification failed: asset vendor missing from vendors';
    END IF;
    IF EXISTS (SELECT 1 FROM assets WHERE catalog_item_id IS NULL) THEN
        RAISE EXCEPTION 'Migration verification failed: asset not linked to a catalogue entry';
    END IF;
    RAISE NOTICE 'Migration 004 applied successfully — reference data, catalogue, receipts and invoices are active.';
END;
$$;

COMMIT;
