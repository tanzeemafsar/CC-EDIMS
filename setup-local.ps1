#Requires -Version 5.1
<#
=============================================================================
 EDIMS - setup-local.ps1   (Windows)
 Self-contained Windows equivalent of setup-local.sh. Does not touch, depend
 on, or conflict with the Linux script.

   powershell -ExecutionPolicy Bypass -File setup-local.ps1
   # or just double-click setup-local.bat

 It is idempotent: safe to run again. It will, only where needed,
   1. check Node 20+ and locate the psql client,
   2. confirm a PostgreSQL server is reachable as a superuser,
   3. create the database, app role, and privileges,
   4. write a .env with a freshly generated SESSION_SECRET,
   5. npm install,
   6. apply schema.sql and migration-001.sql,
   7. create the first Admin login,
   8. tell you how to start the server.

 Common overrides (all optional):
   -DbPass 'strong-pw'  -AppPort 4000
   -PostgresPassword 'the-password-you-set-when-installing-PostgreSQL'
   -PsqlPath 'C:\Program Files\PostgreSQL\16\bin\psql.exe'
   -AdminUser me -AdminEmail me@home -AdminPass 'at-least-12-chars'
   -Reset        # drop & recreate the database (wipes all data)
   -ForceEnv     # overwrite an existing .env
=============================================================================
#>
[CmdletBinding()]
param(
  [string] $DbName          = 'edims_db',
  [string] $DbUser          = 'edims_app',
  [string] $DbPass          = 'edims_local_dev_pw',
  [string] $DbHost          = 'localhost',
  [int]    $DbPort          = 5432,
  [int]    $AppPort         = 3000,

  [string] $PgSuperUser     = 'postgres',
  [string] $PostgresPassword,                 # superuser password (Windows has no peer auth)
  [string] $PsqlPath,                         # full path to psql.exe if not on PATH

  [string] $AdminUser       = 'admin',
  [string] $AdminEmail      = 'admin@local.test',
  [string] $AdminPass       = 'adminadminadmin',   # >= 12 chars

  [switch] $Reset,
  [switch] $ForceEnv
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Write-Ok   ($m) { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Info ($m) { Write-Host "[..]   $m" -ForegroundColor Cyan }
function Write-Warn2($m) { Write-Host "[!]    $m" -ForegroundColor Yellow }
function Die        ($m) { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }

Write-Host "============================================================"
Write-Host " EDIMS - local setup (Windows)"
Write-Host "============================================================"

# ---- 1. Node 20+ ------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "Node.js is not installed or not on PATH. Install Node 20+ from https://nodejs.org (LTS), then re-open PowerShell."
}
$nodeVer = (& node -p "process.versions.node")
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 20) { Die "Node 20+ required (found v$nodeVer)." }
Write-Ok "Node v$nodeVer"

# ---- 2. Locate psql ---------------------------------------------------------
function Find-Psql {
  if ($PsqlPath) {
    if (Test-Path $PsqlPath) { return $PsqlPath } else { Die "psql not found at -PsqlPath '$PsqlPath'." }
  }
  if ($env:EDIMS_PSQL -and (Test-Path $env:EDIMS_PSQL)) { return $env:EDIMS_PSQL }
  $cmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  # Typical EDB installer location: C:\Program Files\PostgreSQL\<ver>\bin\psql.exe
  foreach ($base in @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL")) {
    if (Test-Path $base) {
      $hit = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
             Sort-Object Name -Descending |
             ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } |
             Where-Object { Test-Path $_ } |
             Select-Object -First 1
      if ($hit) { return $hit }
    }
  }
  return $null
}

$Psql = Find-Psql
if (-not $Psql) {
  Die @"
Could not find psql.exe. Install PostgreSQL 16+ from
  https://www.postgresql.org/download/windows/  (EDB installer),
or pass the path explicitly, e.g.:
  -PsqlPath 'C:\Program Files\PostgreSQL\16\bin\psql.exe'
"@
}
Write-Ok "psql: $Psql"

# ---- 3. Superuser password (no peer auth on Windows) ------------------------
if ($PostgresPassword) {
  $env:PGPASSWORD = $PostgresPassword
} elseif (-not $env:PGPASSWORD) {
  Write-Info "Enter the password for the PostgreSQL '$PgSuperUser' superuser (set when you installed PostgreSQL)."
  $sec = Read-Host -AsSecureString "  $PgSuperUser password"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Helper: run SQL (from a string) against a database as the superuser.
function Invoke-Sql {
  param([string] $Database, [string] $Sql, [switch] $Quiet)
  $a = @('-U', $PgSuperUser, '-h', $DbHost, '-p', "$DbPort", '-d', $Database, '-v', 'ON_ERROR_STOP=1', '-w')
  if ($Quiet) { $a += @('-q') }
  $Sql | & $Psql @a
  if ($LASTEXITCODE -ne 0) { Die "psql failed (exit $LASTEXITCODE) while running SQL against '$Database'." }
}

# Helper: run a .sql file against a database as the superuser.
function Invoke-SqlFile {
  param([string] $Database, [string] $File)
  $a = @('-U', $PgSuperUser, '-h', $DbHost, '-p', "$DbPort", '-d', $Database, '-v', 'ON_ERROR_STOP=1', '-w', '-q', '-f', $File)
  & $Psql @a | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "psql failed (exit $LASTEXITCODE) while applying $File." }
}

# Helper: single-value scalar query (-t -A), returns a trimmed string.
function Get-SqlScalar {
  param([string] $Database, [string] $Sql)
  $a = @('-U', $PgSuperUser, '-h', $DbHost, '-p', "$DbPort", '-d', $Database, '-t', '-A', '-w', '-c', $Sql)
  $out = & $Psql @a 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ("$out").Trim()
}

# ---- connectivity -----------------------------------------------------------
$ping = Get-SqlScalar -Database 'postgres' -Sql 'SELECT 1;'
if ($ping -ne '1') {
  $svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc -and $svc.Status -ne 'Running') {
    Die "Could not connect: the '$($svc.Name)' service is $($svc.Status). Start it (admin PowerShell): Start-Service $($svc.Name)"
  }
  Die "Could not connect to PostgreSQL as '$PgSuperUser' on ${DbHost}:$DbPort. Check the server is running and the password is correct."
}
Write-Ok "PostgreSQL server reachable as '$PgSuperUser'"

# ---- optional reset ---------------------------------------------------------
if ($Reset) {
  Write-Warn2 "-Reset: dropping database '$DbName' (all data lost)..."
  Invoke-Sql -Database 'postgres' -Sql "DROP DATABASE IF EXISTS $DbName;" -Quiet
}

# ---- 4. Role, database, privileges (idempotent) -----------------------------
$roleSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DbUser') THEN
    CREATE ROLE $DbUser WITH LOGIN PASSWORD '$DbPass'
      NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 30;
  ELSE
    ALTER ROLE $DbUser WITH LOGIN PASSWORD '$DbPass';
  END IF;
END
`$`$;
"@
Invoke-Sql -Database 'postgres' -Sql $roleSql -Quiet
Write-Ok "App role '$DbUser' ready"

$dbExists = Get-SqlScalar -Database 'postgres' -Sql "SELECT 1 FROM pg_database WHERE datname='$DbName';"
if ($dbExists -eq '1') {
  Write-Info "Database '$DbName' already exists"
} else {
  Invoke-Sql -Database 'postgres' -Sql "CREATE DATABASE $DbName ENCODING 'UTF8' TEMPLATE template0;" -Quiet
  Write-Ok "Database '$DbName' created"
}
Invoke-Sql -Database 'postgres' -Sql "GRANT CONNECT ON DATABASE $DbName TO $DbUser;" -Quiet

# ---- 5. .env ----------------------------------------------------------------
$envPath = Join-Path $PSScriptRoot '.env'
if ((Test-Path $envPath) -and (-not $ForceEnv)) {
  Write-Info ".env already exists (use -ForceEnv to regenerate)"
} else {
  $secret = (& node -e "console.log(require('crypto').randomBytes(64).toString('hex'))").Trim()
  $stamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $lines  = @(
    "# Generated by setup-local.ps1 on $stamp",
    "DATABASE_URL=postgres://${DbUser}:${DbPass}@${DbHost}:${DbPort}/${DbName}",
    "SESSION_SECRET=$secret",
    "NODE_ENV=development",
    "PORT=$AppPort"
  )
  # Write UTF-8 WITHOUT BOM and with LF endings — a BOM on the first line breaks
  # dotenv parsing of DATABASE_URL, and LF keeps it identical to the Linux file.
  $text = ($lines -join "`n") + "`n"
  [System.IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok ".env written (SESSION_SECRET generated)"
}

# ---- 6. npm install ---------------------------------------------------------
if (Test-Path (Join-Path $PSScriptRoot 'node_modules')) {
  Write-Info "node_modules present (skipping npm install)"
} else {
  Write-Info "Installing dependencies (npm install)..."
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "npm install failed (exit $LASTEXITCODE)." }
  Write-Ok "Dependencies installed"
}

# ---- 7. Schema + migration (only if not already applied) --------------------
$schemaPresent = Get-SqlScalar -Database $DbName -Sql "SELECT to_regclass('public.roles') IS NOT NULL;"
if ($schemaPresent -eq 't') {
  Write-Info "schema.sql already applied (skipping)"
} else {
  Invoke-SqlFile -Database $DbName -File (Join-Path $PSScriptRoot 'schema.sql')
  Write-Ok "schema.sql applied"
}

$migrationPresent = Get-SqlScalar -Database $DbName -Sql "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname='asset_status' AND e.enumlabel='Retired');"
if ($migrationPresent -eq 't') {
  Write-Info "migration-001.sql already applied (skipping)"
} else {
  Invoke-SqlFile -Database $DbName -File (Join-Path $PSScriptRoot 'migration-001.sql')
  Write-Ok "migration-001.sql applied"
}

# Later migrations, each detected by an object it creates
foreach ($m in @(
    @{ File = 'migration-002.sql'; Marker = 'procurement_thresholds' },
    @{ File = 'migration-003.sql'; Marker = 'device_categories' },
    @{ File = 'migration-004.sql'; Marker = 'vendors' },
    @{ File = 'migration-005.sql'; Marker = 'approval_requests' }
)) {
  $present = Get-SqlScalar -Database $DbName -Sql "SELECT to_regclass('public.$($m.Marker)') IS NOT NULL;"
  if ($present -eq 't') {
    Write-Info "$($m.File) already applied (skipping)"
  } else {
    Invoke-SqlFile -Database $DbName -File (Join-Path $PSScriptRoot $m.File)
    Write-Ok "$($m.File) applied"
  }
}

# Grant privileges on everything the schema created (and for future objects).
$grantSql = @"
GRANT USAGE ON SCHEMA public TO $DbUser;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $DbUser;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $DbUser;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO $DbUser;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA public TO $DbUser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $DbUser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $DbUser;
"@
Invoke-Sql -Database $DbName -Sql $grantSql -Quiet
Write-Ok "Privileges granted to '$DbUser'"

# ---- 8. First admin (idempotent — seed-admin skips if one exists) -----------
Write-Info "Ensuring an Admin login exists..."
$env:EDIMS_ADMIN_USERNAME = $AdminUser
$env:EDIMS_ADMIN_EMAIL    = $AdminEmail
$env:EDIMS_ADMIN_PASSWORD = $AdminPass
try {
  & node seed-admin.js
  if ($LASTEXITCODE -ne 0) { Die "seed-admin.js failed (exit $LASTEXITCODE)." }
} finally {
  Remove-Item Env:\EDIMS_ADMIN_USERNAME, Env:\EDIMS_ADMIN_EMAIL, Env:\EDIMS_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  # Don't leave the superuser password sitting in the session environment.
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "============================================================"
Write-Ok "Local setup complete."
Write-Host "============================================================"
Write-Host "  Start the server:"
Write-Host "      npm start                  # production-style"
Write-Host "      node --watch server.js     # auto-reload on changes"
Write-Host ""
Write-Host "  Then open:   http://localhost:$AppPort"
Write-Host "  Login:       $AdminUser  /  (the password you set; default ChangeMeLocally1)"
Write-Host ""
Write-Host "  Change the default password from the Users screen after first login."
Write-Host "  To expose this on your LAN, see QUICKSTART-WINDOWS.md (section 'Run it on the LAN')."
Write-Host "============================================================"
