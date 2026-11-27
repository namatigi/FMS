# Station commissioning checklist

Station: ________  Code: ________  PTS-2 ID: ________________________  Gateway code(s): ________
Engineer: ________  Date: ________  ZRA TPIN / branch (bhfId): ________ / ___

Menu and field names follow the PTS-2 technical guide (R12, April 2026): automatic operation is on pp. 107–109 and communication to the remote server on pp. 110–117. Check the exact labels against the controller's firmware version.

## A. Before the site visit

- [ ] Station, tanks, fuel grades and nozzles have been created in the FMS admin console, and match the physical forecourt (pump/nozzle → grade → tank).
- [ ] Controller registered with its **PTS ID** and a newly generated **secret key**. Each controller gets its own secret, so never reuse one.
- [ ] Gateway(s) registered (`POST /api/v1/admin/gateways`). Record the API key; it is shown only once.
- [ ] ZRA VSDC: the device is initialised for the station's TPIN and branch, and the fuel items are registered (`saveItem`).
- [ ] Mini-PC imaged, with the cosign/release public key installed. `.env` prepared and stored in the vault.

## B. Hardware and network

- [ ] UPS installed and NUT configured. Pull mains and confirm the UPS carries the load, then confirm an orderly shutdown at low battery.
- [ ] BIOS set to "power on after AC loss".
- [ ] Fixed LAN addresses assigned: PTS-2 ______, gateway A ______, gateway B ______, VIP ______.
- [ ] WAN primary and 4G backup both tested. Unplug the primary and check that HTTPS to `fms.example.zm` still works.
- [ ] No inbound WAN ports open. Ports 8100/8101 are reachable from the LAN only.
- [ ] NTP: the gateway clock is synchronised (chrony). The PTS-2 date/time and time zone are set to Africa/Lusaka.

## C. Gateway install

- [ ] Docker: `docker compose up -d`, then `docker compose ps` shows both containers healthy. Or native: `install-systemd.sh` reports "healthy".
- [ ] `curl http://<VIP>:8100/healthz` returns 200, and the local UI `http://<VIP>:8101` loads.
- [ ] Standby unit (if fitted): keepalived is running and `ip addr` shows the VIP on exactly one unit.

## D. PTS-2: REMOTE SERVER SETTINGS

Open the PTS-2 web configuration and go to the remote server settings.

- [ ] **Server URI**: `http://<gateway VIP>:8100/jsonPTS`. Use the VIP, never a unit's own IP. For direct mode without a gateway, use `https://fms.example.zm/ingest/pts`.
- [ ] **Secret key**: the controller secret registered in A.
- [ ] **Upload of pump transactions**: enabled.
- [ ] **Upload of tank measurements**: enabled.
- [ ] **Upload of in-tank deliveries**: enabled.
- [ ] **Upload of alert records**: enabled.
- [ ] **Upload of status**: enabled, at a 1–5 s interval.
- [ ] Upload of GPS records and configuration: enable if the guide lists them. They are optional.
- [ ] Optional **second (backup) remote server**: `https://fms.example.zm/ingest/pts` (direct-mode fallback), if the firmware supports two targets.
- [ ] **SD flash saving** enabled for transactions, tank measurements, deliveries and alerts. Confirm the SD card is present and has free space.
- [ ] Request/response timeouts and retry interval left at the guide's defaults. Confirm the controller's *uploaded* counter increases.

## E. PTS-2: automatic operation (no POS)

For each pump:

- [ ] **Auto-authorise** on nozzle up.
- [ ] **Auto-close** the transaction on nozzle down.
- [ ] **Read totals** (totalisers) automatically after each transaction. FMS uses these to detect manual-mode dispensing.
- [ ] Fuel grade prices on the PTS-2 match the station prices in FMS, and are at or below the ERB cap.

## F. End-to-end acceptance

- [ ] Dispense a test sale on every nozzle. Each one appears in the gateway UI, gets a ZRA receipt number, prints with a QR code, and shows up in the FMS portal within 1 minute.
- [ ] The opening totaliser for each pump and nozzle has been recorded in the commissioning sheet. The cloud shows no `TotalizerMismatch` alert.
- [ ] The ATG shows every tank with the correct product, volume, water and temperature. Check against a manual dip.
- [ ] Deliveries: either a test delivery was recorded, or deliveries are scheduled to be checked at the first real drop.
- [ ] **WAN outage test**: unplug the WAN for 10 minutes and make a sale. It should print (if the VSDC is reachable over 4G) or be queued `pending`, and the gateway backlog should grow. Reconnect, and the backlog should drain to 0.
- [ ] **Gateway failover test** (dual units): power off the active unit during a sale. The sale is not lost and the VIP moves.
- [ ] **PTS-2 power cycle**: no records are lost, and the uploaded counter catches up.
- [ ] Station shows **online** in the regulator view (`v_station_health`).
- [ ] Price change from the FMS portal: the edge `set_prices` command is applied on the PTS-2.

## G. Handover

- [ ] Owner and manager accounts are created, and the mobile app is logged in.
- [ ] Station staff have been shown the local UI (offline status, reprint).
- [ ] Commissioning sheet signed by the engineer and the station manager, and uploaded to FMS.
- [ ] Station status changed from `commissioning` to `active`.
