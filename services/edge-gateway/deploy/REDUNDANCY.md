# Edge gateway redundancy (primary / standby)

## Why not a database lock

Each gateway is a separate mini-PC with its own local PostgreSQL. A Postgres advisory lock only
works inside one database server, so it cannot elect a leader between two machines. Sharing one
database between both boxes would make that database the single point of failure we are trying to
remove. The design therefore leaves the decision to the network layer.

## Design

```
            PTS-2 (uploads to 192.168.1.10:8100/jsonPTS)
                         |
              VIP 192.168.1.10 (VRRP, keepalived)
              /                                   \
   gateway A (MASTER, prio 150)          gateway B (BACKUP, prio 100)
   local Postgres A                      local Postgres B
   fiscal + sync: ON                     fiscal + sync: OFF (until it holds the VIP)
```

1. **keepalived (VRRP) owns a virtual IP** on the station LAN. The PTS-2 *Server IPv4 address* is
   set to the VIP. keepalived's `track_script` polls `GET /readyz` on the local UI port, so the VIP
   moves when the gateway process or its database dies, as well as when the box goes down. See
   `keepalived.conf.example`.
2. **Only the instance holding the VIP runs the fiscal pipeline and cloud sync.** The gateway checks
   this itself (`src/ha.ts`):
   - `HA_MODE=vip`: active while `HA_VIP` is configured on a local network interface. This is the
     recommended mode and needs no extra scripts.
   - `HA_MODE=file`: active while `HA_STATE_FILE` contains `MASTER`, as written by the keepalived
     notify hook `ha-notify.sh`.
   - `HA_MODE=standby`: never active. Use it for a cold spare that only stores uploads.
   - `HA_MODE=always`: a single gateway, which is the default.
   The listener always accepts uploads. Normally only the VIP holder receives them, but a packet that
   reaches the standby directly is still stored durably.
3. **A double send is harmless (idempotent design):**
   - **Fiscal:** the invoice number is deterministic
     (`<station>-P<pump>-<txno>-<yyyyMMddHHmmss>`) and `FiscalClient.signSale` is idempotent on it.
     If both gateways ever sign the same sale, ZRA returns the existing receipt instead of issuing a
     second one.
   - **Cloud:** batch records are upserted on natural keys (pump/transaction/ended_at,
     tank/measured_at, invoice_no and so on), so the same sale arriving from both gateways becomes
     one row.
   - **PTS-2:** a packet is confirmed only after it is committed locally. A packet confirmed by A
     will not be re-sent to B, and a packet that A did not confirm is re-sent through the VIP to
     whichever gateway holds it.

## Failover behaviour

| Event | Result |
|---|---|
| A crashes or loses power | B takes the VIP within about 3 s and becomes active. The PTS-2 re-sends unconfirmed records to B. B fiscalises new sales and syncs. |
| A's Postgres down | `/readyz` fails, keepalived lowers A, and B takes the VIP. |
| A comes back | A holds sales it confirmed before the crash. When it is active again (or as soon as it is online, if you run it with `HA_MODE=always` temporarily), it fiscalises and syncs them. Duplicates are harmless. |
| Split brain (both hold the VIP) | Both fiscalise and sync. The idempotency rules above prevent double receipts and double rows. |

**Residual risk.** If A dies, sales A had *confirmed* but not yet fiscalised or synced stay on A's
disk until A is repaired. They are not lost, only delayed. To limit the delay, keep A's disk
(SSD + UPS) and repair or boot A promptly. You can also point the PTS-2's second upload target
(see DESIGN §6) at the cloud ingest-api, so that the cloud fiscal-worker can sign anything left
unsigned beyond its threshold.

## Install on the standby

Install it the same way as the primary (see README). Then:
- set `HA_MODE=vip` and `HA_VIP=192.168.1.10` on both nodes
- use the same `STATION_CODE`, `PTS_ID`/`PTS_SECRET`, `GATEWAY_CODE` and `GATEWAY_KEY` (the cloud
  sees a single gateway identity)
- use the same `ZRA_DEVICE_SERIAL` only if ZRA allows one VSDC device registration to be shared
  (VERIFY with ZRA); otherwise register a second device for the standby
- in keepalived, set `state BACKUP` and `priority 100`
