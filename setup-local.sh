#!/usr/bin/env bash
# =============================================================================
# EDIMS — setup-local.sh
# One command to get EDIMS running on a local Linux machine (development).
#
#   bash setup-local.sh
#
# It is idempotent: safe to run again. It will
#   1. check Node 20+ and the psql client are installed,
#   2. confirm a PostgreSQL server is reachable,
#   3. create the database, app role, and privileges (if missing),
#   4. write a .env with a freshly generated SESSION_SECRET (if missing),
#   5. npm install (if node_modules is missing),
#   6. apply schema.sql and migration-001 → 004.sql,
#   7. create the first Admin login (if none exists),
#   8. tell you how to start the server.
#
# Override any default by exporting it first, e.g.:
#   DB_PASS='my-pass' PORT=4000 bash setup-local.sh
#
# Flags:
#   --reset       drop and recreate the database (wipes all data) before setup
#   --force-env   overwrite an existing .env
# =============================================================================
set -euo pipefail

# ── Resolve our own directory so the script works from anywhere ──────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Configurable settings (override via environment) ─────────────────────────
DB_NAME="${DB_NAME:-edims_db}"
DB_USER="${DB_USER:-edims_app}"
DB_PASS="${DB_PASS:-edims_local_dev_pw}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
APP_PORT="${PORT:-3000}"

ADMIN_USER="${EDIMS_ADMIN_USERNAME:-admin}"
ADMIN_EMAIL="${EDIMS_ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASS="${EDIMS_ADMIN_PASSWORD:-adminadminadmin123}"   # >= 12 chars

RESET=0
FORCE_ENV=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --force-env) FORCE_ENV=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

c_ok()   { printf '\033[32m✔\033[0m %s\n' "$1"; }
c_info() { printf '\033[36m•\033[0m %s\n' "$1"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
c_err()  { printf '\033[31m✘ %s\033[0m\n' "$1" >&2; }

echo "============================================================"
echo " EDIMS — local setup"
echo "============================================================"

# ── 1. Node 20+ ──────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  c_err "Node.js is not installed."
  echo "    Install Node 20+, e.g.:"
  echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "      sudo apt install -y nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  c_err "Node 20+ required (found $(node --version))."
  exit 1
fi
c_ok "Node $(node --version)"

# ── 2. psql client ───────────────────────────────────────────────────────────
if ! command -v psql >/dev/null 2>&1; then
  c_err "The 'psql' client is not installed."
  echo "    Debian/Ubuntu:  sudo apt install -y postgresql postgresql-client"
  echo "    Fedora/RHEL:    sudo dnf install -y postgresql-server postgresql"
  echo "    Arch:           sudo pacman -S postgresql"
  exit 1
fi
c_ok "psql client present"

# ── Decide how to run psql as a superuser ────────────────────────────────────
# Priority: explicit PG_SUPER override → sudo -u postgres → su postgres (root)
#           → plain psql (your own account is a superuser).
PG_MODE="user"
if [ -n "${PG_SUPER:-}" ]; then
  PG_MODE="custom"
elif command -v sudo >/dev/null 2>&1 && sudo -n -u postgres true 2>/dev/null; then
  PG_MODE="sudo"
elif command -v sudo >/dev/null 2>&1; then
  PG_MODE="sudo"   # may prompt for your password once
elif [ "$(id -u)" -eq 0 ]; then
  PG_MODE="su"
fi

# run_super [dbname] [extra psql args…]  — reads SQL from stdin, executes as a
# postgres superuser. Extra args (e.g. -t -A) are passed through to psql.
run_super() {
  local db="${1:-postgres}"; shift 2>/dev/null || true
  case "$PG_MODE" in
    custom) eval "$PG_SUPER -v ON_ERROR_STOP=1 -d \"$db\" $*" ;;
    sudo)   sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$db" "$@" ;;
    su)     su postgres -c "psql -v ON_ERROR_STOP=1 -d '$db' $*" ;;
    user)   psql -v ON_ERROR_STOP=1 -d "$db" "$@" ;;
  esac
}

# ── 3. Is a server reachable? ────────────────────────────────────────────────
if ! echo 'SELECT 1;' | run_super postgres >/dev/null 2>&1; then
  c_err "Could not connect to a PostgreSQL server as a superuser."
  echo "    Is the server running?  sudo systemctl start postgresql"
  echo "    If your superuser access differs, set PG_SUPER, e.g.:"
  echo "      PG_SUPER='psql -U postgres -h localhost' bash setup-local.sh"
  exit 1
fi
c_ok "PostgreSQL server reachable (superuser access via: $PG_MODE)"

# ── optional: --reset wipes the database ─────────────────────────────────────
if [ "$RESET" -eq 1 ]; then
  c_warn "--reset: dropping database '$DB_NAME' (all data lost)…"
  echo "DROP DATABASE IF EXISTS $DB_NAME;" | run_super postgres
fi

# ── 4. Role, database, privileges (idempotent) ───────────────────────────────
run_super postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS'
      NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 30;
  ELSE
    ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';
  END IF;
END
\$\$;
SQL
c_ok "App role '$DB_USER' ready"

if echo "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';" | run_super postgres | grep -q 1; then
  c_info "Database '$DB_NAME' already exists"
else
  echo "CREATE DATABASE $DB_NAME ENCODING 'UTF8' TEMPLATE template0;" | run_super postgres
  c_ok "Database '$DB_NAME' created"
fi

run_super postgres <<SQL
GRANT CONNECT ON DATABASE $DB_NAME TO $DB_USER;
SQL

# ── 5. .env ──────────────────────────────────────────────────────────────────
if [ -f .env ] && [ "$FORCE_ENV" -eq 0 ]; then
  c_info ".env already exists (use --force-env to regenerate)"
else
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))')"
  cat > .env <<ENV
# Generated by setup-local.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_URL=postgres://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME
SESSION_SECRET=$SESSION_SECRET
NODE_ENV=development
PORT=$APP_PORT
ENV
  chmod 600 .env
  c_ok ".env written (SESSION_SECRET generated, 600 perms)"
fi

# ── 6. npm install ───────────────────────────────────────────────────────────
if [ -d node_modules ]; then
  c_info "node_modules present (skipping npm install)"
else
  c_info "Installing dependencies (npm install)…"
  npm install --no-audit --no-fund
  c_ok "Dependencies installed"
fi

# ── 7. Schema + migration (only if not already applied — schema.sql is not
#       itself re-runnable, so we detect existing state and skip) ─────────────
schema_present="$(echo "SELECT to_regclass('public.roles') IS NOT NULL;" | run_super "$DB_NAME" -t -A 2>/dev/null | tr -d '[:space:]')"
if [ "$schema_present" = "t" ]; then
  c_info "schema.sql already applied (skipping)"
else
  run_super "$DB_NAME" < schema.sql >/dev/null
  c_ok "schema.sql applied"
fi

migration_present="$(echo "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname='asset_status' AND e.enumlabel='Retired');" | run_super "$DB_NAME" -t -A 2>/dev/null | tr -d '[:space:]')"
if [ "$migration_present" = "t" ]; then
  c_info "migration-001.sql already applied (skipping)"
else
  run_super "$DB_NAME" < migration-001.sql >/dev/null
  c_ok "migration-001.sql applied"
fi

migration2_present="$(echo "SELECT to_regclass('public.procurement_thresholds') IS NOT NULL;" | run_super "$DB_NAME" -t -A 2>/dev/null | tr -d '[:space:]')"
if [ "$migration2_present" = "t" ]; then
  c_info "migration-002.sql already applied (skipping)"
else
  run_super "$DB_NAME" < migration-002.sql >/dev/null
  c_ok "migration-002.sql applied"
fi

migration3_present="$(echo "SELECT to_regclass('public.device_categories') IS NOT NULL;" | run_super "$DB_NAME" -t -A 2>/dev/null | tr -d '[:space:]')"
if [ "$migration3_present" = "t" ]; then
  c_info "migration-003.sql already applied (skipping)"
else
  run_super "$DB_NAME" < migration-003.sql >/dev/null
  c_ok "migration-003.sql applied"
fi

migration4_present="$(echo "SELECT to_regclass('public.vendors') IS NOT NULL;" | run_super "$DB_NAME" -t -A 2>/dev/null | tr -d '[:space:]')"
if [ "$migration4_present" = "t" ]; then
  c_info "migration-004.sql already applied (skipping)"
else
  run_super "$DB_NAME" < migration-004.sql >/dev/null
  c_ok "migration-004.sql applied"
fi

# Grant privileges on everything the schema just created (and for future objects)
run_super "$DB_NAME" <<SQL
GRANT USAGE ON SCHEMA public TO $DB_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $DB_USER;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO $DB_USER;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $DB_USER;
SQL
c_ok "Privileges granted to '$DB_USER'"

# ── 8. First admin (idempotent — seed-admin skips if one exists) ─────────────
c_info "Ensuring an Admin login exists…"
EDIMS_ADMIN_USERNAME="$ADMIN_USER" \
EDIMS_ADMIN_EMAIL="$ADMIN_EMAIL" \
EDIMS_ADMIN_PASSWORD="$ADMIN_PASS" \
node seed-admin.js

echo
echo "============================================================"
c_ok "Local setup complete."
echo "============================================================"
echo "  Start the server:"
echo "      npm start            # production-style"
echo "      npm run dev          # auto-reload on file changes"
echo
echo "  Then open:   http://localhost:$APP_PORT"
echo "  Login:       $ADMIN_USER  /  (the password you set; default ChangeMeLocally1)"
echo
echo "  Change the default password from the Users screen after first login."
echo "  To expose this on your LAN, see QUICKSTART-LOCAL.md (section 'Run it on the LAN')."
echo "============================================================"
