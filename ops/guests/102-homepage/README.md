# 102 homepage

[gethomepage](https://gethomepage.dev) 2.x at http://192.168.2.4:3000 and https://home.teich.network. Installed by community-scripts into `/opt/homepage`; runs as the `homepage` systemd service (`next start`).

## What's managed here

`files/opt/homepage/config/`: `services.yaml`, `settings.yaml`, `widgets.yaml` and `bookmarks.yaml`. These are the only files `ops/bin/push 102-homepage` writes. Homepage picks up config changes without a restart.

Not managed, so these stay only on the guest:

- `/opt/homepage/.env` holds every secret, as `HOMEPAGE_VAR_<NAME>=…` lines, plus `HOMEPAGE_ALLOWED_HOSTS`. The config refers to them as `{{HOMEPAGE_VAR_<NAME>}}`. Next.js loads `.env` when the service starts, so **restart homepage after adding a variable**.
- `config/proxmox.yaml` holds the Proxmox API token behind the `proxmoxVMID` status dots.

## Conventions

- Every guest-backed tile sets `proxmoxNode/proxmoxVMID/proxmoxType`, so its dot shows whether the guest is running.
- Tiles with a LAN or public URL also set `siteMonitor`. Tailnet-only URLs (`*.ts.net`) can't use it, because this LXC isn't on Tailscale.
- Widget `url`s use IPs, not `arr`. That name resolves only through Tailscale MagicDNS. The clickable `href`s keep `arr`, which works from any device on the tailnet.

## History

- 2026-10-21: Brought under ops/. Secrets moved from inline values to `.env`. Fixed the Jellyfin widget (Jellyfin 12 removed the `/emby` endpoints, so the widget now uses `version: 2`). Fixed Booklore (`arr` didn't resolve). Added Home Assistant, Gate, Irrigation, UniFi, PatchMon, Proxmox Backup, NAS, an Asphalt Anchors group and Ops bookmarks.

## Checks

`check.sh` verifies that the service is running, that every `HOMEPAGE_VAR_*` the config uses is set in `.env`, and that `services.yaml` still carries the managed header.
