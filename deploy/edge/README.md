# FMS station installation kit (edge gateway)

This kit installs the FMS edge gateway on a station's industrial mini-PC. The gateway receives jsonPTS uploads from the PTS-2 forecourt controller and keeps a durable local outbox. It fiscalises each sale with the ZRA VSDC, prints the receipt and syncs to the FMS cloud.

| File | Purpose |
|---|---|
| `docker-compose.yml`, `.env.example` | Docker install (recommended): the gateway plus Postgres 16 on a persistent volume, `restart: always`, rotated logs |
| `install-systemd.sh`, `systemd/fms-edge-gateway.service` | Native install without Docker: verified release tarball, local PostgreSQL 16, systemd unit, journald retention |
| `keepalived/` | VRRP virtual IP for a primary/standby gateway pair |
| `update.sh` | Signed, digest-pinned image update with automatic rollback |
| `COMMISSIONING.md` | Site commissioning checklist, including PTS-2 REMOTE SERVER SETTINGS |

## Hardware baseline

- **Mini-PC.** Use a fanless industrial unit (x86-64, 4 cores, 8 GB RAM, 256 GB industrial SSD with power-loss protection). The outbox is sized for 30 or more days offline. One busy station produces about 600 sales and roughly 5k tank readings a day, so a 30-day outbox is well under 5 GB.
- **Optional second unit** as hot standby on the same LAN, sharing a VIP (see `keepalived/`).
- **Network.** Forecourt LAN switch, PTS-2 on Ethernet, and a dual-WAN router (see below).
- **Printing.** An ESC/POS receipt printer on TCP 9100, USB or serial. Use a ZRA-approved fiscal device if ZRA requires one (DESIGN §12).

## Power: UPS and NUT

- Put the mini-PC(s), the PTS-2, the LAN switch and the WAN router on a **line-interactive or online UPS** with at least 60 minutes of runtime. Diesel generator change-over at Zambian stations commonly causes 5–30 s gaps.
- Connect the UPS over USB to the primary gateway and run **NUT** (`nut-server` on the primary, `nut-client` on the standby):
  - `/etc/nut/ups.conf`: `[station-ups] driver = usbhid-ups port = auto`
  - `upsmon.conf`: `MONITOR station-ups@localhost 1 upsmon <pw> primary`. Set `SHUTDOWNCMD "/sbin/shutdown -h +0"`, and shut down at low battery only.
- An orderly shutdown stops `fms-edge-gateway` and then PostgreSQL. Even without one, Postgres (with `fsync=on` and `synchronous_commit=on`) plus the PTS-2 SD-card re-send means no sale is lost.
- Set the BIOS to **"power on after AC loss"** so the unit restarts by itself.
- Optionally, export the UPS state to the gateway's heartbeat. The integrator should check whether the gateway supports this.

## WAN: 4G failover router

- Primary uplink is fibre or ADSL. Backup is a **4G/LTE router with dual SIMs on different operators** (for example Airtel and MTN). Use the router's WAN failover (ping/health check to `fms.example.zm`) with automatic failback.
- Only outbound HTTPS (443) to the FMS cloud and ZRA VSDC is needed. Block all inbound traffic from the WAN, and keep the PTS-2 and the gateway UI on the LAN only.
- Watch out for **CGNAT**: many stations will share public IPs on 4G. Cloud rate limits are per IP and are sized for this (see `deploy/k8s/base/ingress.yaml`).
- Data budget is roughly 50–150 MB a day per station when real-time status is enabled. Use a status upload interval of 1–5 s, not faster, on metered links.
- Optionally, the router can provide a management VPN (WireGuard) for remote support. Never port-forward 8100/8101.

## Primary/standby gateways (VRRP)

1. Install the gateway on both units with distinct `GATEWAY_CODE`s. Register the second unit with role `standby` in the admin console.
2. Install keepalived on both units with `keepalived/keepalived.conf`, adjusting `router_id`, `priority`, the IPs and `auth_pass`. Also install `check_gateway.sh` and `notify.sh` (chmod 755).
3. Point the PTS-2 at the **VIP** (for example `http://192.168.10.10:8100/jsonPTS`).
4. Failover test: power off the primary. The VIP should move within about 5 s, and the PTS-2 keeps uploading to the standby, which fiscalises and syncs. Records the primary had not yet synced are sent when it comes back. Cloud ingest is idempotent.
5. Swapping out a failed unit: see `deploy/README.md`, section "Edge gateway swap".

## Fleet updates

- CI builds the edge-gateway image once per release and **signs it with cosign**. The native install uses a signed tarball instead. CI also produces an SBOM and runs a Trivy scan, and critical CVEs block the release.
- Stations accept only `image@sha256:` references whose signature verifies against `/etc/fms-edge/cosign.pub` (`update.sh`).
- **Staged rollout rings.** Each ring must be healthy for its whole soak time before the next one starts:

  | Ring | Stations | Soak |
  |---|---|---|
  | 0 | Lab plus 2 company-owned pilot stations | 48 h |
  | 1 | About 5% (one per province) | 72 h |
  | 2 | About 25% | 72 h |
  | 3 | Everyone else | — |

  "Healthy" means no increase in gateway restarts, fiscal backlog, outbox backlog or `TotalizerMismatch` alerts for that ring (the Grafana "FMS overview" dashboard filtered by station).
- Updates run in the off-peak window, 01:00–04:00 local time. A failed health check rolls back automatically (`update.sh`, `install-systemd.sh`).
- The local DB schema must stay backwards compatible for one release, so that a rollback is always possible.
- The fleet agent (systemd timer, Ansible or a cloud `upgrade` command piggy-backed on EdgeBatch responses) is chosen by the platform team. The scripts here are agent-agnostic.
