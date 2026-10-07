-- =============================================================================
-- EDIMS — migration-005.sql
-- Admin approval workflow.
-- Apply after migration-004.sql.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migration-005.sql
--
-- What this changes:
--   - `approval_policies`: which actions need an Admin's approval when a
--     non-Admin performs them (toggled from the Approvals screen).
--   - `approval_requests`: one row per gated action a non-Admin submitted —
--     the validated request payload, a readable summary, and its outcome
--     (Pending → Approved | Rejected | Cancelled | Failed). Approved
--     requests are executed by the server with the original requester as
--     the actor and the approving Admin recorded alongside.
--   - procurement_alerts gains purchase-request details (catalogue model,
--     quantity, estimated unit price, currency, requester, approval link).
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.vendors') IS NULL THEN
        RAISE EXCEPTION 'migration-005 requires migration-004.sql to be applied first';
    END IF;
    IF to_regclass('public.approval_requests') IS NOT NULL THEN
        RAISE EXCEPTION 'migration-005 has already been applied (approval_requests exists)';
    END IF;
END;
$$;

CREATE TABLE approval_policies (
    action            TEXT PRIMARY KEY,
    requires_approval BOOLEAN NOT NULL,
    updated_by        UUID REFERENCES users(id),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO approval_policies (action, requires_approval) VALUES
    ('procurement.order',  true),   -- purchase / order requests
    ('asset.create',       true),   -- registering a new device
    ('assignment.create',  true),   -- assigning a device to an employee
    ('assignment.return',  false),
    ('asset.retire',       true),
    ('asset.mark_ordered', false),
    ('asset.mark_faulty',  false),
    ('asset.repair',       false),
    ('invoice.issue',      true);

CREATE TYPE approval_status AS ENUM ('Pending', 'Approved', 'Rejected', 'Cancelled', 'Failed');

CREATE TABLE approval_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_no    INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
    action        TEXT NOT NULL,
    status        approval_status NOT NULL DEFAULT 'Pending',
    summary       TEXT NOT NULL,
    payload       JSONB NOT NULL,
    details       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- extra display info (cost, names…)
    justification TEXT,
    asset_id      UUID REFERENCES assets(id) ON DELETE SET NULL,
    requested_by  UUID NOT NULL REFERENCES users(id),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_by    UUID REFERENCES users(id),
    decided_at    TIMESTAMPTZ,
    decision_note TEXT,
    result        JSONB,
    error         TEXT,
    CHECK ((status = 'Pending') = (decided_at IS NULL))
);
CREATE INDEX idx_approval_requests_status    ON approval_requests(status, requested_at DESC);
CREATE INDEX idx_approval_requests_requester ON approval_requests(requested_by, requested_at DESC);
CREATE INDEX idx_approval_requests_asset     ON approval_requests(asset_id);

-- Purchase-request details on orders
ALTER TABLE procurement_alerts
    ADD COLUMN catalog_item_id     UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
    ADD COLUMN quantity            INTEGER CHECK (quantity > 0),
    ADD COLUMN est_unit_price      NUMERIC(12,2) CHECK (est_unit_price >= 0),
    ADD COLUMN currency            CHAR(3) CHECK (currency ~ '^[A-Z]{3}$'),
    ADD COLUMN requested_by        UUID REFERENCES users(id),
    ADD COLUMN approval_request_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL;

DO $$
BEGIN
    RAISE NOTICE 'Migration 005 applied successfully — approval workflow is active.';
END;
$$;

COMMIT;
