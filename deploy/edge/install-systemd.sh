#!/usr/bin/env bash
# Native install of the FMS edge gateway on a Debian 12 / Ubuntu 24.04
# industrial mini-PC (alternative to deploy/edge/docker-compose.yml).
#
#   sudo ./install-systemd.sh --release fms-edge-gateway-v0.1.0.tar.gz \
#        --sig fms-edge-gateway-v0.1.0.tar.gz.sig --env ./gateway.env
#
# The release tarball is produced by CI (built repo with
# services/edge-gateway/dist + node_modules). It is verified against the
# FMS release public key before anything is installed.
set -euo pipefail

RELEASE="" SIG="" ENV_FILE="" PUBKEY="/etc/fms-edge/release-signing.pub"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --sig)     SIG="$2"; shift 2 ;;
    --env)     ENV_FILE="$2"; shift 2 ;;
    --pubkey)  PUBKEY="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$RELEASE" && -f "$SIG" && -f "$ENV_FILE" ]] || { echo "need --release, --sig and --env" >&2; exit 2; }
[[ -f "$PUBKEY" ]] || { echo "missing release public key $PUBKEY (install from the commissioning USB)" >&2; exit 1; }

echo "==> verifying release signature"
openssl dgst -sha256 -verify "$PUBKEY" -signature "$SIG" "$RELEASE"

echo "==> installing packages (Node.js 20, PostgreSQL 16, chrony, nut-client)"
apt-get update
apt-get install -y ca-certificates curl gnupg postgresql-16 chrony nut-client
if ! command -v node >/dev/null || ! node -v | grep -q '^v20\.'; then
  # NodeSource apt repository for Node 20 LTS
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update && apt-get install -y nodejs
fi
systemctl enable --now postgresql chrony

echo "==> service user and directories"
id fms-edge >/dev/null 2>&1 || useradd --system --home /var/lib/fms-edge --shell /usr/sbin/nologin fms-edge
# lp / dialout give access to USB and serial printers
usermod -aG lp,dialout fms-edge || true
install -d -o fms-edge -g fms-edge -m 0750 /var/lib/fms-edge
install -d -o root -g fms-edge -m 0750 /etc/fms-edge
install -d -m 0755 /opt/fms-edge-gateway/releases

echo "==> local database"
PGPASS="$(grep -E '^EDGE_PG_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)"
[[ -n "$PGPASS" ]] || PGPASS="$(openssl rand -hex 24)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge') THEN
    CREATE ROLE edge LOGIN PASSWORD '${PGPASS}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE edge OWNER edge' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'edge')\gexec
SQL

echo "==> environment file"
install -o root -g fms-edge -m 0640 "$ENV_FILE" /etc/fms-edge/gateway.env
grep -q '^DATABASE_URL=' /etc/fms-edge/gateway.env || \
  echo "DATABASE_URL=postgres://edge:${PGPASS}@127.0.0.1:5432/edge" >> /etc/fms-edge/gateway.env
grep -q '^PORT=' /etc/fms-edge/gateway.env || echo "PORT=8100" >> /etc/fms-edge/gateway.env
grep -q '^UI_PORT=' /etc/fms-edge/gateway.env || echo "UI_PORT=8101" >> /etc/fms-edge/gateway.env

echo "==> unpacking release"
VERSION="$(basename "$RELEASE" .tar.gz)"
DEST="/opt/fms-edge-gateway/releases/$VERSION"
rm -rf "$DEST" && install -d "$DEST"
tar -xzf "$RELEASE" -C "$DEST"
PREVIOUS="$(readlink -f /opt/fms-edge-gateway/current || true)"
ln -sfn "$DEST" /opt/fms-edge-gateway/current

echo "==> journald log rotation"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/fms.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=1G
MaxRetentionSec=90day
EOF
systemctl restart systemd-journald

echo "==> systemd unit"
install -m 0644 "$(dirname "$0")/systemd/fms-edge-gateway.service" /etc/systemd/system/fms-edge-gateway.service
systemctl daemon-reload
systemctl enable fms-edge-gateway
systemctl restart fms-edge-gateway

echo "==> health check"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8100/healthz >/dev/null; then
    echo "edge gateway healthy ($VERSION)"; exit 0
  fi
  sleep 2
done
echo "health check failed; rolling back to ${PREVIOUS:-none}" >&2
if [[ -n "$PREVIOUS" ]]; then ln -sfn "$PREVIOUS" /opt/fms-edge-gateway/current; systemctl restart fms-edge-gateway; fi
exit 1
