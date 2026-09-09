# EDIMS — Quickstart (Linux)

Get it running on your machine first, then expose it to the LAN. This is the
short path; the longer production/PM2/systemd writeup is in
`EDIMS-Deployment-Guide.md`.

---

## TL;DR

```bash
cd deploy
bash setup-local.sh      # creates DB, role, .env, schema, first admin
npm start                # or: npm run dev  (auto-reload)
```

Open **http://localhost:3000** and log in with `admin` / `ChangeMeLocally1`,
then change that password from the **Users** screen.

---

## 1. Prerequisites

- **Node.js 20+** — `node --version`
- **PostgreSQL 16+** running locally — `psql --version`

If PostgreSQL isn't installed:

```bash
sudo apt update
sudo apt install -y postgresql postgresql-client      # Debian/Ubuntu
sudo systemctl enable --now postgresql                # start it on boot + now
```

(Fedora: `sudo dnf install -y postgresql-server postgresql && sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql`.)

---

## 2. Run it locally

```bash
cd deploy
bash setup-local.sh
```

The script is safe to run more than once. It will, only where needed:
create the `edims_db` database and the `edims_app` role, write a `.env` with a
freshly generated `SESSION_SECRET`, run `npm install`, apply `schema.sql` and
`migration-001.sql`, and create the first Admin login.

Then start the server:

```bash
npm start        # production-style
npm run dev      # development with auto-reload on file changes
```

You should see:

```
[DB] Connected — PostgreSQL 16...
[SERVER] EDIMS running on port 3000 (development)
```

Open **http://localhost:3000**.

### Useful variations

```bash
# Use your own DB name / password / port:
DB_PASS='something-strong' PORT=4000 bash setup-local.sh

# Set the first admin's credentials up front (no prompt):
EDIMS_ADMIN_USERNAME=me EDIMS_ADMIN_EMAIL=me@home \
  EDIMS_ADMIN_PASSWORD='at-least-12-chars' bash setup-local.sh

# Wipe everything and start clean:
bash setup-local.sh --reset

# Your PostgreSQL superuser access is non-standard:
PG_SUPER='psql -U postgres -h localhost' bash setup-local.sh
```

To add more users later, use the in-app **Users** screen (Admin only) — you
don't need the seed script again.

---

## 3. Run it on the LAN

The server already listens on all interfaces (`0.0.0.0`), so other machines on
your network can reach it as soon as the firewall allows it. Two steps:

**a. Open the port for your LAN only.**

```bash
sudo apt install -y ufw
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp comment 'EDIMS LAN'
sudo ufw enable
```

Replace `192.168.1.0/24` with your actual subnet.

**b. Find this machine's LAN IP and hand it out.**

```bash
hostname -I        # e.g. 192.168.1.50
```

Other machines then open **http://192.168.1.50:3000**.

Optionally give it a friendly name by adding a line to `/etc/hosts` on each
client (or to your router/pi-hole DNS):

```
192.168.1.50   tac-inventory.local
```

…then browse to **http://tac-inventory.local:3000**.

### Optional: HTTPS on the LAN

```bash
bash scripts/gen-local-cert.sh      # writes certs/local-cert.{key,crt}
npm start                            # auto-detects the certs, switches to HTTPS
```

> **Important:** once certs are present the session cookie is marked `secure`,
> so you **must** use `https://…` — logging in over plain `http://` will appear
> to do nothing (the cookie won't be stored). Browsers will warn about the
> self-signed cert; that's expected on a private LAN.

---

## 4. Good to know

- **Account lockout:** 5 wrong passwords locks an account for 30 minutes. If you
  lock yourself out while testing, wait it out or clear it in SQL:
  `UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE username='admin';`
- **Commit a lockfile:** the bundle ships without `package-lock.json`. After the
  first `npm install`, commit the generated lockfile so future installs are
  reproducible (and `npm ci` works).
- **Sessions table grows:** `connect-pg-simple` prunes expired sessions every
  15 minutes while the server runs, so for normal use this is handled.
- **`schema.sql` is a reconstruction** (see the deployment guide). It satisfies
  every query the app makes; diff it against any real backup before pointing
  this at a database that already has data.

---

## 5. What changed in this revision

- Added `setup-local.sh` — one idempotent command for the whole local setup.
- `seed-admin.js` now also accepts `EDIMS_ADMIN_USERNAME` / `_EMAIL` /
  `_PASSWORD` so it can create the first admin without an interactive prompt
  (the interactive flow is unchanged when you don't pass them).
- `server.js`: unknown `/api/*` routes now return a JSON `404` instead of the
  SPA's HTML page, so the frontend surfaces real API errors instead of silently
  receiving an empty object.
