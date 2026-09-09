# EDIMS — Quickstart (Windows)

Self-contained Windows path. It does not use or interfere with the Linux
`setup-local.sh` — different files, no shared state. Use this on Windows; use
`QUICKSTART-LOCAL.md` on Linux.

---

## TL;DR

```powershell
cd deploy
.\setup-local.bat            # or: npm run setup:win
npm start
```

(`setup-local.bat` will ask once for your PostgreSQL `postgres` password.)
Then open **http://localhost:3000** and log in with `admin` /
`ChangeMeLocally1`, and change that password from the **Users** screen.

---

## 1. Prerequisites

- **Node.js 20+** — install the LTS from <https://nodejs.org>, then open a
  **new** PowerShell window so `node` is on PATH. Check: `node --version`.
- **PostgreSQL 16+** — install from
  <https://www.postgresql.org/download/windows/> (the EDB installer).
  **Write down the password you set for the `postgres` superuser** — the setup
  script needs it once. The installer registers a Windows service that starts
  automatically, so the server is running after install.

You do **not** need to add `psql` to PATH — the script finds it automatically
under `C:\Program Files\PostgreSQL\<version>\bin`.

---

## 2. Run it locally

Open PowerShell, `cd` into the `deploy` folder, and run **either**:

```powershell
.\setup-local.bat
```

or, if you prefer PowerShell directly (the `.bat` just does this for you with
the execution policy bypassed for that one process):

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-local.ps1
```

It will prompt once for the `postgres` superuser password, then — only where
needed — create the `edims_db` database and `edims_app` role, write a `.env`
with a generated `SESSION_SECRET`, run `npm install`, apply `schema.sql` and
`migration-001.sql`, and create the first Admin login. It is safe to run again.

Start the server:

```powershell
npm start                   # production-style
node --watch server.js      # auto-reload on file changes (Windows-friendly dev)
```

> On Windows use `node --watch server.js` (or `npm run dev:win`) for auto-reload.
> The plain `npm run dev` script is Linux-only — it uses `NODE_ENV=development`
> inline, which Windows shells don't accept. `npm start` works everywhere.

The first time the server listens, **Windows Defender Firewall** may pop up a
prompt — allow access on **Private networks** so LAN clients can reach it.

Open **http://localhost:3000**.

### Useful variations

```powershell
# Provide the postgres password up front (no prompt):
.\setup-local.ps1 -PostgresPassword 'your-postgres-pw'

# Custom app DB password / port:
.\setup-local.ps1 -DbPass 'something-strong' -AppPort 4000

# Set the first admin's credentials up front:
.\setup-local.ps1 -AdminUser me -AdminEmail me@home -AdminPass 'at-least-12-chars'

# psql in a non-standard place:
.\setup-local.ps1 -PsqlPath 'D:\PostgreSQL\16\bin\psql.exe'

# Wipe everything and start clean:
.\setup-local.ps1 -Reset

# Regenerate the .env:
.\setup-local.ps1 -ForceEnv
```

To add more users later, use the in-app **Users** screen (Admin only).

---

## 3. Run it on the LAN

The server already listens on all interfaces, so other machines can reach it
once Windows Firewall allows the port.

**a. Open the port (run PowerShell as Administrator):**

```powershell
New-NetFirewallRule -DisplayName "EDIMS LAN" -Direction Inbound `
  -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

**b. Find this PC's LAN IP:**

```powershell
ipconfig | Select-String IPv4
```

Other machines then open **http://YOUR-IP:3000** (e.g. `http://192.168.1.50:3000`).

Optionally give it a friendly name by editing
`C:\Windows\System32\drivers\etc\hosts` (open Notepad as Administrator) on each
client and adding:

```
192.168.1.50   tac-inventory.local
```

### Optional: HTTPS on the LAN

The server switches to HTTPS automatically if it finds
`certs\local-cert.key` and `certs\local-cert.crt`. The easiest way to make a
self-signed pair on Windows is OpenSSL (it ships with **Git for Windows**, so
run this in **Git Bash**, or install OpenSSL separately):

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/local-cert.key -out certs/local-cert.crt \
  -subj "/CN=tac-inventory.local"
```

Then `npm start` again — it will report HTTPS mode.

> Once certs are present the session cookie is marked `secure`, so you **must**
> use `https://…`; logging in over `http://` will silently fail to store the
> cookie. Browsers will warn about the self-signed cert — expected on a private
> LAN. If you don't need encryption internally, plain HTTP is fine.

---

## 4. Good to know

- **Account lockout:** 5 wrong passwords locks an account for 30 minutes. To
  clear it, in `psql`:
  `UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE username='admin';`
- **Re-opening PowerShell after installs:** PATH changes from the Node/Postgres
  installers only apply to newly opened terminals.
- **Commit a lockfile:** after the first `npm install`, commit the generated
  `package-lock.json` for reproducible installs.
- **`schema.sql` is a reconstruction** (see the deployment guide). Diff it
  against any real backup before pointing this at a database with existing data.

---

## 5. Windows files in this bundle (all additive — nothing Linux is touched)

- `setup-local.ps1` — the Windows setup script (PowerShell 5.1+, ships with
  Windows 10/11).
- `setup-local.bat` — double-click launcher that runs the `.ps1` with the
  execution policy bypassed for that one process only (changes no system setting).
- `QUICKSTART-WINDOWS.md` — this file.
- `.gitattributes` — pins line endings per file type so a Windows checkout never
  corrupts the Linux `setup-local.sh`, and vice versa.
- `package.json` gains two **additional** scripts (`dev:win`, `setup:win`); the
  existing Linux scripts are unchanged.
