# Automatic Debian security updates

Shared by every running LXC listed in `targets`. Push with `ops/bin/push common/security-updates`; `ops/bin/check` (no arguments) runs `check.sh` in each target.

## Why (2026-10-21)

Before 2026-10-21 most guests had never been updated since install; PatchMon showed about 700 pending updates, mostly Debian security fixes. PatchMon can patch a host when someone starts a run, but it can't patch on a schedule: its patch policies only set when a run you start goes ahead (immediately, delayed or at a fixed time). Oren chose automatic security updates, with PatchMon as the dashboard.

## What

- `unattended-upgrades` installed (with apt; not a file here, so `check.sh` flags it if missing).
- `20auto-upgrades` turns on the daily run (`apt-daily-upgrade.timer`, around 06:00 plus a random delay).
- `52unattended-security-only` clears Debian's default origin list and allows **only Debian-Security for the running release**. Vendor repos (Docker, Caddy, Tailscale, cloudflared, Proxmox, PostgreSQL, Jellyfin) and regular Debian point updates are left for a manual PatchMon "patch all" run. That keeps the Caddy package from replacing the custom binary (see `guests/101-caddy`). No automatic reboots; containers share WTR's kernel anyway.
- Logs on each guest: `/var/log/unattended-upgrades/`. The check flags a guest whose last run is more than 3 days old or logged an error.

## Adding a guest

Install `unattended-upgrades` on it, add its `<vmid>-<hostname>` to `targets`, and push.

## Routine

Security fixes install themselves. About monthly, run "patch all" from PatchMon for everything else, and pull Docker images on hosts that run them (PatchMon reports outdated images but can't update them).
