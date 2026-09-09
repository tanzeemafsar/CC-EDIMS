#!/usr/bin/env bash
# =============================================================================
# EDIMS — scripts/gen-local-cert.sh
# Generates a self-signed certificate valid for the local LAN hostname.
# Produces: certs/local.key  (private key, RSA-4096)
#           certs/local.crt  (certificate, SHA-256, 825-day validity)
#
# Usage:
#   bash scripts/gen-local-cert.sh
#   bash scripts/gen-local-cert.sh --hostname tac-inventory.local --ip 192.168.1.100
#
# Prerequisites: openssl (pre-installed on Ubuntu 24.04)
# =============================================================================

set -euo pipefail

HOSTNAME_VAL="tac-inventory.local"
IP_VAL="127.0.0.1"
DAYS=825
CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"

# Parse optional args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) HOSTNAME_VAL="$2"; shift 2 ;;
    --ip)       IP_VAL="$2";       shift 2 ;;
    --days)     DAYS="$2";         shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

mkdir -p "${CERT_DIR}"
KEY_FILE="${CERT_DIR}/local-cert.key"
CRT_FILE="${CERT_DIR}/local-cert.crt"
EXT_FILE="${CERT_DIR}/san.ext"

echo "[GEN-CERT] Generating RSA-4096 private key…"
openssl genrsa -out "${KEY_FILE}" 4096 2>/dev/null

echo "[GEN-CERT] Writing SAN extension config…"
cat > "${EXT_FILE}" << EOF
[req]
default_bits       = 4096
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
C  = US
ST = Private
L  = LAN
O  = EDIMS Internal
CN = ${HOSTNAME_VAL}

[v3_req]
subjectAltName = @alt_names
keyUsage       = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = ${HOSTNAME_VAL}
DNS.2 = localhost
IP.1  = ${IP_VAL}
IP.2  = 127.0.0.1
EOF

echo "[GEN-CERT] Signing certificate (${DAYS} days, SHA-256, SAN: ${HOSTNAME_VAL} / ${IP_VAL})…"
openssl req -new -x509 \
  -key  "${KEY_FILE}" \
  -out  "${CRT_FILE}" \
  -days "${DAYS}" \
  -config "${EXT_FILE}" \
  -extensions v3_req \
  2>/dev/null

# Lock down private key
chmod 600 "${KEY_FILE}"
chmod 644 "${CRT_FILE}"
rm -f "${EXT_FILE}"

echo ""
echo "[GEN-CERT] ✓ Certificate generated:"
echo "  Key:  ${KEY_FILE}"
echo "  Cert: ${CRT_FILE}"
echo ""
echo "[GEN-CERT] Certificate details:"
openssl x509 -in "${CRT_FILE}" -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null || true

echo ""
echo "[GEN-CERT] To trust this cert on LAN clients:"
echo "  Ubuntu:  sudo cp ${CRT_FILE} /usr/local/share/ca-certificates/edims.crt && sudo update-ca-certificates"
echo "  Windows: Import ${CRT_FILE} into 'Trusted Root Certification Authorities' via certmgr.msc"
echo "  macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CRT_FILE}"
echo ""
echo "[GEN-CERT] CERT_KEY_PATH=${KEY_FILE}"
echo "[GEN-CERT] CERT_CRT_PATH=${CRT_FILE}"
echo "[GEN-CERT] Add these to your .env file."
