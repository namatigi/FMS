#!/usr/bin/env bash
# Fleet update for a Docker-based station gateway. Run by the fleet agent
# (cron / systemd timer / Ansible) when the cloud assigns this station to a
# rollout ring. Only signed images are accepted.
#
#   sudo ./update.sh ghcr.io/oxoafrica/fms/edge-gateway@sha256:<digest>
#
# Requires cosign and the FMS release public key at
# /etc/fms-edge/cosign.pub (installed at commissioning).
set -euo pipefail
cd /opt/fms-edge

IMAGE_REF="${1:?usage: update.sh <image@sha256:digest>}"
[[ "$IMAGE_REF" == *@sha256:* ]] || { echo "refusing to deploy a mutable tag; pass image@sha256:digest" >&2; exit 2; }

echo "==> verifying signature of $IMAGE_REF"
cosign verify --key /etc/fms-edge/cosign.pub "$IMAGE_REF" >/dev/null

PREV_IMAGE="$(grep -E '^EDGE_IMAGE=' .env | cut -d= -f2-)"
PREV_TAG="$(grep -E '^EDGE_TAG=' .env | cut -d= -f2-)"

echo "==> pulling"
docker pull "$IMAGE_REF"

# Restarting is safe at any time: the outbox is durable and the PTS-2
# re-sends unconfirmed records. Rings are scheduled outside peak hours.
echo "==> applying"
NEW_IMAGE="${IMAGE_REF%@*}"
NEW_DIGEST="${IMAGE_REF#*@}"
sed -i -E "s#^EDGE_IMAGE=.*#EDGE_IMAGE=${NEW_IMAGE}#; s#^EDGE_TAG=.*#EDGE_TAG=PLACEHOLDER#" .env
# compose builds "<EDGE_IMAGE>:<EDGE_TAG>"; a digest needs "@" so retag locally.
docker tag "$IMAGE_REF" "${NEW_IMAGE}:${NEW_DIGEST#sha256:}"
sed -i -E "s#^EDGE_TAG=PLACEHOLDER#EDGE_TAG=${NEW_DIGEST#sha256:}#" .env
docker compose up -d edge-gateway

echo "==> health check"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8100/readyz >/dev/null 2>&1; then
    echo "updated to $IMAGE_REF"; exit 0
  fi
  sleep 2
done

echo "health check failed: rolling back to ${PREV_IMAGE}:${PREV_TAG}" >&2
sed -i -E "s#^EDGE_IMAGE=.*#EDGE_IMAGE=${PREV_IMAGE}#; s#^EDGE_TAG=.*#EDGE_TAG=${PREV_TAG}#" .env
docker compose up -d edge-gateway
exit 1
