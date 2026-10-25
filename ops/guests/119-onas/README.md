# 119 onas

Samba file server for the `bulk` datasets (media, backups, photos, videos, roms, bind-mounted from WTR under `/srv`) and the onas dashboard on :3000. The dashboard's code is this repo; this folder is how it's installed.

## Customizations

- **Node.js 24 from NodeSource** (2026-10-22). Debian 13 ships Node 20, which reached upstream end of life in April 2026; onas uses the built-in `node:sqlite`, which needs Node 22.5 or later. `files/etc/apt/sources.list.d/nodesource.sources` plus the repo key (fingerprint `6F71F525282841EEDAF851B42F59B5F99B1BE0B4`). Like the other vendor repos, it's updated by PatchMon runs, not by the daily security-only updates.
- **`onas.service`** (2026-10-22) runs `/opt/onas`. It replaced `nas-dashboard.service`, which ran a git checkout in `/opt/nas-dashboard`; that's disabled and left in place for now.
- **`/etc/onas/`**: `guests.json` (labels and links per guest, copied from the old `/etc/pve-dash/`; format in `guests.example.json`), `pve-ca.pem` (WTR's PVE root CA, copied by `deploy`) and `pve.env` (API tokens, mode 600; not in this repo).
- **Proxmox API tokens** (created 2026-10-22, outside a Claude session): `oren@pve!collector` with PVEAuditor on `/` for reads, and `oren@pve!actions` with PVEAdmin on `/` for guest actions. `create-pve-tokens` would instead make a dedicated `onas@pve` user whose actions token only has PVEVMAdmin on `/vms`; it hasn't been run.
- **PBS API token** (script added 2026-10-25, not yet run): `create-pbs-token` makes `onas@pbs` and the token `onas@pbs!onas` with Audit on `/` in PBS (LXC 112), and appends `PBS_TOKEN` to `pve.env`. Until it's run the Backups view reads PBS over SSH (`pct exec 112 -- proxmox-backup-debug api get`), about 25 s per collection instead of under one.
- **`/etc/onas/backups.json`** (2026-10-25): datasets deliberately left out of backups, each with the reason, and notes shown beside a dataset. Anything not backed up and not listed here is flagged on the Backups tab. Pushed by `deploy`.
- **HTTPS over Tailscale** (2026-10-22): Oren joined the guest to the tailnet as `onas.giraffe-gamma.ts.net`, and `tailscale serve --bg --https=443 http://127.0.0.1:3000` publishes the app at https://onas.giraffe-gamma.ts.net (tailnet only). HTTPS matters: browsers only expose WebGPU, which the storage map, snapshot timeline and heatmap use, in a secure context. `tailscale serve status` shows it; the config persists in tailscaled's state.
- **State** is in `/var/lib/onas/onas.db` (SQLite). It's safe to delete when onas is stopped; collectors refill it within a minute, but metric history and the activity log are lost.
- **SSH to WTR**: onas uses root's key to reach `root@192.168.2.2` for what the Proxmox API can't do (ZFS datasets and snapshots), and for everything until the API tokens exist.
- **Front LCD frame** (2026-10-22): `/api/lcd/frame` serves the picture for WTR's physical front screen. `wtr-lcd` on the host fetches it every second (see [ops/host](../../host/README.md)); if onas stops serving it, the screen switches to its own fallback within a few seconds and `ops/bin/check host` reports it after 5 minutes. `deploy` builds the renderer (`server/lcd-render.cjs`) from `client/src/lib/lcd.ts`.
- **`TZ=America/Los_Angeles` in `onas.service`** (2026-10-22): the container runs on UTC, and the frame's clock is drawn in onas's local time. Nothing else in onas uses local time.

## Deploy

```sh
ops/guests/119-onas/deploy             # build, install, restart, run check.sh
ops/guests/119-onas/create-pve-tokens  # once: PVE API user onas@pve with read and actions tokens
```

## Checks

`check.sh` verifies Node 24+, that `onas` and `smbd` are running, the old service isn't, and `/api/health` reports every collector fresh.
