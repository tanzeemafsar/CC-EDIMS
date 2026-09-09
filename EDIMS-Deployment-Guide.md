# EDIMS — Deployment Guide
**Employee Device Inventory Management System v1.1.0**

This guide covers the file set in `edims-deploy-ready.zip`, which has been
audited and fixed end-to-end: every JS file syntax-checked, every API route
cross-referenced between frontend and backend, every file path verified to
resolve, and every env var name verified consistent across `server.js`,
`seed-admin.js`, `.env.example`, and `scripts/gen-local-cert.sh`.

> **Note on provenance:** an earlier review document referenced multiple zip
> "version" folders (`files (1)` through `files (6)`, a `proj/` root) with
> their own bug list. None of those folders were ever uploaded to this
> conversation, so I can't verify or carry forward claims about them. This
> guide is written only against the files actually audited here.

---

## 1. What was fixed

| # | File | Issue | Fix |
|---|------|-------|-----|
| 1 | `server.js` | `path` module used 5× but never `require`d → crash on boot | Added `require('path')` |
| 2 | `server.js` | `tlsOptions` referenced in session config before it existed (wrong scope) → `ReferenceError` | Replaced with an `httpsEnabled` boolean computed early, before session middleware |
| 3 | `server.js` | `IMAGES_DIR` used in `start()` but only ever defined inside `routes/scraper.js` → `ReferenceError` | Now uses `HW_IMAGES`, which is actually defined in `server.js` |
| 4 | `server.js` | Audit filter cast to nonexistent enum `network_verification_status` → SQL error on every filtered audit query | Cast corrected to `verification_status` (matches `schema.sql`) |
| 5 | `server.js` | No `.env` loader — `node server.js` / `npm start` would crash on a fresh clone unless run under PM2 | Added `require('dotenv').config()` at the top; added `dotenv` to `package.json` |
| 6 | `server.js` | Dead `buildFilters()` helper, defined but never called anywhere | Removed |
| 7 | `routes/export.js` | `COLOR` palette constant defined, then ignored — ~19 raw hex strings duplicated through the PDF code instead | Extended the palette with the legitimately distinct shades that were missing, replaced every magic string with the constant |
| 8 | `routes/export.js` | Dead `pdfStat()` helper, never called | Removed |
| 9 | `gen-local-cert.sh` | Printed `TLS_KEY_PATH`/`TLS_CERT_PATH` (server reads `CERT_KEY_PATH`/`CERT_CRT_PATH`); wrote `local.key`/`local.crt` (server defaults to `local-cert.key`/`local-cert.crt`) | Names aligned both ways — zero-config TLS now works after running the script |
| 10 | `ecosystem_config.js` | Filename had an underscore; PM2 and `package.json` both expect a dot | Renamed to `ecosystem.config.js` |
| 11 | — | `seed-admin.js` was referenced by `package.json` but never existed — **no way to log in on a fresh database** | Written from scratch: interactive prompts, bcrypt cost 12 (matches `server.js`'s own user-creation route), refuses to run twice unless `--force` |
| 12 | — | `schema.sql` never existed; `migration-001.sql` explicitly depends on it | Reconstructed from every column/query/procedure reference across `server.js`/`export.js`/`scraper.js`. **This is a reconstruction, not the original DDL — diff against any real backup before applying to a live system.** |
| 13 | `.env` | Windows CRLF line endings | Converted to LF; renamed to `.env.example` since a real `.env` with a published placeholder secret shouldn't ship as if it were ready to use |
| 14 | `public/index.html` | No favicon, no deep-linking (refresh always returns to the default view), no global session-expiry handling, table errors looked identical to "empty" | Added a generated favicon, hash-based routing with back/forward support, a global 401 interceptor that returns to login automatically, and a visually distinct error state (red text + retry button) wherever a fetch fails |

Everything in this list was verified by running the actual file (syntax
check, route cross-reference, or — where a network-isolated sandbox allowed
— an end-to-end boot test against stubbed dependencies), not just read by eye.

## 2. What's still worth knowing

- **`schema.sql` is a reconstruction.** It will satisfy every query the app
  makes, but if your real database has extra columns or different defaults
  the app never touches, this file won't know about them. Diff before
  applying to anything with existing data.
- **No `package-lock.json` is included.** The one that existed predates the
  new `dotenv` dependency and would make `npm ci` fail integrity checks. Run
  `npm install` once (not `npm ci`) on first deploy to generate a fresh,
  correct lockfile, then commit it.
- **Sessions table grows unbounded.** `connect-pg-simple` doesn't prune
  expired rows automatically. Add a periodic `DELETE FROM sessions WHERE
  expire < NOW()` (cron or a `pg_cron` job) if this runs for months unattended.
- **No rate limit on the export endpoints.** `/api/export/assets.pdf` etc.
  share the general `apiLimiter`, not a tighter one — low risk on a LAN, but
  worth knowing if this is ever exposed more broadly.
- **`sharp` ships native binaries.** Works out of the box on Ubuntu x86_64.
  If you ever deploy to Alpine/musl or ARM, you may need
  `npm install --platform=linuxmusl --arch=x64 sharp` or similar.

---

## 3. Deploy — Ubuntu Server 24.04

### Prerequisites
```
Ubuntu Server 24.04 LTS
PostgreSQL 16+
Node.js 20+
A static LAN IP on the server
```

### Step 1 — System packages
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y postgresql-16 postgresql-client-16

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version   # must be v20+
psql --version   # must be 16+
```

### Step 2 — Create the database and app user
```bash
sudo -u postgres psql << 'SQL'
CREATE DATABASE edims_db
    ENCODING 'UTF8'
    LC_COLLATE 'en_US.UTF-8'
    LC_CTYPE 'en_US.UTF-8'
    TEMPLATE template0;

CREATE USER edims_app WITH
    PASSWORD 'CHANGE_ME_STRONG_PASSWORD'
    NOSUPERUSER NOCREATEDB NOCREATEROLE LOGIN
    CONNECTION LIMIT 30;

GRANT CONNECT ON DATABASE edims_db TO edims_app;
\c edims_db
GRANT USAGE ON SCHEMA public TO edims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO edims_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO edims_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO edims_app;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA public TO edims_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edims_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO edims_app;
SQL
```
Replace `CHANGE_ME_STRONG_PASSWORD` with a real generated password before running this.

### Step 3 — Unpack the application
```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin edims
sudo mkdir -p /opt/edims
sudo unzip edims-deploy-ready.zip -d /tmp/edims-extract
sudo cp -r /tmp/edims-extract/deploy/. /opt/edims/
sudo chown -R edims:edims /opt/edims
```

### Step 4 — Install dependencies
```bash
cd /opt/edims
sudo -u edims npm install --omit=dev
```
Use `npm install`, not `npm ci`, on this first run — there is no lockfile
yet (see §2). Commit the lockfile it generates for future deploys.

### Step 5 — Configure environment
```bash
sudo -u edims cp .env.example .env
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
sudo -u edims nano .env
```
Set `DATABASE_URL` to the real connection string for the user/db created in
Step 2, and paste the generated value in for `SESSION_SECRET`. Then:
```bash
sudo chmod 600 /opt/edims/.env
```

### Step 6 — Apply the schema
```bash
cd /opt/edims
sudo -u postgres psql -d edims_db -f schema.sql
sudo -u postgres psql -d edims_db -f migration-001.sql
sudo -u postgres psql -d edims_db -c "\dt"
sudo -u postgres psql -d edims_db -c "SELECT * FROM roles;"
```
You should see three roles: `Admin`, `TAC`, `Viewer`.

### Step 7 — Create the first admin user
```bash
cd /opt/edims
sudo -u edims node seed-admin.js
```
Follow the interactive prompts (username, email, password — 12+ chars, not
echoed to the terminal). Without this step there is no way to log in.

### Step 8 — Optional: generate a local TLS certificate
```bash
cd /opt/edims
sudo -u edims bash scripts/gen-local-cert.sh
```
Produces `certs/local-cert.key` and `certs/local-cert.crt`. `server.js`
auto-detects these on boot and switches to HTTPS with TLS 1.3 enforced; if
they're absent it falls back to plain HTTP with a clear warning in the logs.

### Step 9 — Run it
```bash
cd /opt/edims
sudo -u edims npm start
```
Watch for:
```
[DB] Connected — PostgreSQL 16...
[SERVER] EDIMS running on port 3000 (production)
```
If you see a `[FATAL]` line instead, it'll name exactly what's missing
(`DATABASE_URL`, `SESSION_SECRET`, or a failed DB connection) — fix that
before moving on to process management.

### Step 10 — Process management (PM2)
```bash
sudo npm install -g pm2
cd /opt/edims
sudo -u edims pm2 start ecosystem.config.js
sudo -u edims pm2 save
pm2 startup   # follow the printed instructions to enable on boot
pm2 logs edims
pm2 monit
```

### Step 11 — Firewall (UFW)
```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp comment 'EDIMS LAN'
sudo ufw --force enable
sudo ufw status verbose
```
Replace `192.168.1.0/24` with your actual LAN subnet.

### Step 12 — Local DNS (pick one)
**Per-client `/etc/hosts`:**
```
192.168.1.100   tac-inventory.local
```
**Or a LAN DNS resolver (pfSense, pi-hole, etc.):** point
`tac-inventory.local` at the server's static IP.

### Step 13 — Verify
```bash
curl -s http://localhost:3000/api/auth/me
```
Expect `{"error":"Not authenticated."}` — that confirms the server is
actually answering requests. Then open `http://tac-inventory.local:3000`
(or `https://` if you completed Step 8) from any LAN machine and log in
with the account created in Step 7.

---

## 4. Backups
```bash
sudo tee /etc/cron.d/edims-backup << 'EOF'
0 2 * * * postgres pg_dump --format=custom edims_db | gzip > /var/backups/edims/edims_$(date +\%Y-\%m-\%d).dump.gz
EOF
sudo mkdir -p /var/backups/edims
sudo chown postgres:postgres /var/backups/edims
```

---

## 5. Package contents
```
deploy/
├── server.js                  ← main app
├── package.json                ← includes dotenv; no lockfile (see §2)
├── schema.sql                  ← reconstructed; diff before use on live data
├── migration-001.sql           ← adds 'Retired' status + retire_asset procedure
├── seed-admin.js                ← run once after schema.sql to create the first login
├── ecosystem.config.js         ← PM2 config
├── .env.example                 ← copy to .env and fill in real values
├── .gitignore
├── public/
│   ├── index.html               ← SPA frontend
│   ├── favicon.ico
│   └── images/hardware/         ← scraped hardware image cache (empty at deploy)
├── routes/
│   ├── export.js                ← CSV/PDF export routes
│   └── scraper.js               ← hardware spec scraper routes
├── scripts/
│   └── gen-local-cert.sh        ← generates a self-signed LAN TLS cert
└── logs/                        ← PM2 out_file/error_file target (empty at deploy)
```

*EDIMS v1.1.0 — internal/LAN deployment only.*
