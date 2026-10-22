# Homelab operations

This repo is the onas dashboard, and also the place to start when Oren says "X isn't working" about a home service. Diagnose first, fix the narrowest thing, and say what changed.

## Access

- **WTR** is the Proxmox host: `ssh root@192.168.2.2` (key auth from Oren's Mac works).
- Run commands inside an LXC with `pct exec <id> -- <cmd>`; VMs with `qm`.
- `pct list` / `qm list` give the live inventory. Static IPs: `pct config <id> | grep ip=`.

## Domains

Convention (Oren, 2026-10-21): **teich.network** names things inside the home network (LAN or Tailscale, through Caddy). **teich.net** names things on the public internet (Cloudflare Workers and Pages, e.g. p.teich.net). Public property and business hostnames use their own domains (gate.d4f.com, *.asphaltanchors.com) through Cloudflare tunnels.

## Request path for `*.teich.network`

DNS points `*.teich.network` at **192.168.2.5 = LXC 101 `caddy`**, which terminates TLS (wildcard cert via Cloudflare DNS challenge) and proxies by host:

| Host | Backend |
|------|---------|
| home / homepage.teich.network | LXC 102 `homepage` (192.168.2.4) |
| evcc.teich.network | LXC 110 `evcc` (192.168.2.20:7070) |
| immich.teich.network | LXC 103 `immich` (192.168.2.13) |

If a site gives "connection refused", check Caddy before the backend. A 502 means Caddy is fine and the backend is down.

## The onas app

The dashboard in this repo runs at https://onas.giraffe-gamma.ts.net (Tailscale; plain http://192.168.2.189:3000 works but can't draw the WebGPU views) on LXC 119 as `onas.service` (`/opt/onas`, state in `/var/lib/onas/onas.db`). Deploy with `ops/guests/119-onas/deploy`. When it looks wrong, `curl http://192.168.2.189:3000/api/health` names any collector that's failing and why. See [README.md](README.md).

## Customizations live in `ops/`

Anything we change on a guest beyond its stock install goes in `ops/guests/<vmid>-<name>/` (files, a README with the why, and a `check.sh`), then gets deployed with `ops/bin/push`. Read [ops/README.md](ops/README.md) before changing anything on a guest. When diagnosing, run `ops/bin/check` early: it reports any customization that has drifted or stopped working. If you fix something by hand, put the fix into `ops/` before you finish.

## Known failure modes

- **Caddy won't start after an apt upgrade** (`module not registered: dns.providers.cloudflare`). The Debian package replaces the custom binary. An apt hook now repairs this on its own (`ops/guests/101-caddy`). If it fails, check `journalctl -t caddy-ensure-cloudflare`, or fix it by hand with `caddy add-package github.com/caddy-dns/cloudflare` and then restart Caddy.
- **Immich** is installed by the community-scripts `update` script into `/opt/immich` (not Docker). `immich-web` Requires `immich-ml`, so an ML failure takes the web UI down too. An interrupted `update` can leave a duplicated `packageImportMethod: hardlink` in `/opt/immich/source/pnpm-workspace.yaml`; delete the duplicate and rerun `update`. Logs: `/var/log/immich/{web,ml}.log`.
- After a WTR reboot, check `systemctl --failed` inside the guests. Services can hit systemd's start limit within a second and stay down.

## Inventory

[ops/INVENTORY.md](ops/INVENTORY.md) lists every guest, what it runs, its IP and the known gaps. Update it when guests are added or removed. Service write-ups live in Notion (Docs, Area = Operations). The backlog is the Notion Work overview row [WTR home server operations](https://app.notion.com/p/400a91fefc7581c2b6aefb02d3a41530); tick items off there as they're done.

Cloudflare: the `cf` CLI is authenticated for two accounts, so set `CLOUDFLARE_ACCOUNT_ID`. AAC is `805dfbc806bf099214ef74cdb7d21dc7` and Teich is `02bd603968db4f77d62a3c447ee329a2`. Start with `cf cli search "<task>"` rather than `--help`.
