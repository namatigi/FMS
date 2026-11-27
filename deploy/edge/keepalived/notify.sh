#!/bin/sh
# keepalived notify hook: $1=GROUP|INSTANCE $2=name $3=MASTER|BACKUP|FAULT
mkdir -p /run/fms-edge
echo "$3 $(date -u +%FT%TZ)" > /run/fms-edge/vrrp-state
logger -t fms-vrrp "VRRP $2 -> $3"
