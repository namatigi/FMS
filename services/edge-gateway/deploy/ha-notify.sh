#!/bin/sh
# keepalived notify hook: records the VRRP state for HA_MODE=file.
STATE_FILE="${HA_STATE_FILE:-/run/fms-edge/ha-state}"
mkdir -p "$(dirname "$STATE_FILE")"
echo "$1" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
logger -t fms-edge-ha "VRRP state -> $1"
