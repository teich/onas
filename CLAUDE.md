# Homelab operations

This repo is the onas dashboard, and also the place to start when Oren says "X isn't working" about a home service. Diagnose first, fix the narrowest thing, and say what changed.

## Access

- **WTR** is the Proxmox host: `ssh root@192.168.2.2` (key auth from Oren's Mac works).
- Run commands inside an LXC with `pct exec <id> -- <cmd>`; VMs with `qm`.
- `pct list` / `qm list` give the live inventory. Static IPs: `pct config <id> | grep ip=`.

## Request path for `*.teich.network`

DNS points `*.teich.network` at **192.168.2.5 = LXC 101 `caddy`**, which terminates TLS (wildcard cert via Cloudflare DNS challenge) and proxies by host:

| Host | Backend |
|------|---------|
| home / homepage.teich.network | LXC 102 `homepage` (192.168.2.4) |
| evcc.teich.network | LXC 110 `evcc` (192.168.2.20:7070) |
| immich.teich.network | LXC 103 `immich` (192.168.2.13) |

If a site gives "connection refused", check Caddy before the backend. A 502 means Caddy is fine and the backend is down.

## Customizations live in `ops/`

Anything we change on a guest beyond its stock install goes in `ops/guests/<vmid>-<name>/` (files, a README with the why, and a `check.sh`), then gets deployed with `ops/bin/push`. Read [ops/README.md](ops/README.md) before changing anything on a guest. When diagnosing, run `ops/bin/check` early: it reports any customization that has drifted or stopped working. If you fix something by hand, put the fix into `ops/` before you finish.

## Known failure modes

- **Caddy won't start after an apt upgrade** (`module not registered: dns.providers.cloudflare`). The Debian package replaces the custom binary. An apt hook now repairs this on its own (`ops/guests/101-caddy`). If it fails, check `journalctl -t caddy-ensure-cloudflare`, or fix it by hand with `caddy add-package github.com/caddy-dns/cloudflare` and then restart Caddy.
- **Immich** is installed by the community-scripts `update` script into `/opt/immich` (not Docker). `immich-web` Requires `immich-ml`, so an ML failure takes the web UI down too. An interrupted `update` can leave a duplicated `packageImportMethod: hardlink` in `/opt/immich/source/pnpm-workspace.yaml`; delete the duplicate and rerun `update`. Logs: `/var/log/immich/{web,ml}.log`.
- After a WTR reboot, check `systemctl --failed` inside the guests. Services can hit systemd's start limit within a second and stay down.

## Other guests worth knowing

`gamm` (117) is the Google Ads MCP gateway (code in `~/src/aac/gamm`). `dash` (105) is the production BI stack. `patchmon` (114) tracks pending updates. `uptimekuma` (111) monitors uptime. `proxmox-backup-server` (112) is at 192.168.2.9. Service write-ups live in Notion (Docs, Area = Operations).
