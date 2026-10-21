# WTR inventory

Snapshot taken 2026-10-21 by Claude Code. Live state: `pct list`, `qm list`, `ops/bin/check`. Items marked **?** are open questions for Oren.

## Host

- **WTR**: Proxmox VE 9.2 (Debian 13), kernel 7.0.14. 16 cores, 60 GB RAM. LAN 192.168.2.2 on `vmbr0`; VLAN 5 (192.168.5.0/24) on `vmbr0v5` for the AAC guests. Tailscale 100.97.147.50. Web UI https://192.168.2.2:8006.
- **Pools**:
  - `bulk`: RAIDZ2, 6× WD 6 TB, 32.7 T, 57% used.
  - `fast`: mirror, 2× SN850X 2 TB NVMe, 16% used.
  - A third NVMe is the boot disk. `sdg` is an empty USB SD-card reader (Genesys 05e3:0764), not a drive.
  - Monthly scrubs (last one 2026-10-11, no errors). All pools and disks healthy.
- **Datasets** on `bulk`: media 6.9 T, photos 3.0 T (4 T quota), videos 753 G, backups 1.8 T, roms 25 G. Two are empty: timemachine (1 T quota) and home.
- **Repos**: pve-no-subscription, Debian trixie, Tailscale. 0 pending host updates.

## Guests

IP "dhcp → x" means the address isn't pinned (it may be a DHCP reservation, **?**).

| ID | Name | IP | What it is | Notes |
|----|------|----|------------|-------|
| 100 | haos (VM) | ? | Home Assistant OS | 2 c / 4 G |
| 101 | caddy | 192.168.2.5 | TLS + reverse proxy for `*.teich.network` (home, evcc, immich) | Customized, see `ops/guests/101-caddy` |
| 102 | homepage | 192.168.2.4 | gethomepage dashboard (:3000) | Mounts host `/`, `/bulk` and `/fast` read-only (for disk widgets?) |
| 103 | immich | 192.168.2.13 | Immich 3.3.4 (bare-metal install, Postgres 16, Redis) | Photos from `/bulk/photos`. Also on Tailscale. 12 cores |
| 104 | arr | dhcp → .119 | Docker: Jellyfin, Sonarr, Radarr, SABnzbd, qBittorrent, Audiobookshelf, Booklore (`grimmory` image), MariaDB | `/bulk/media`, `/fast/apps`; iGPU passthrough; Tailscale |
| 105 | dash | VLAN5 dhcp → 192.168.5.30 | **AAC** production BI: Postgres 16, importer, dashboard, rclone Dropbox sync | Tailscale `dash.grouse-crested.ts.net`. No PatchMon agent |
| 106 | cloudflared-teich | dhcp → .181 | Connector for tunnel `HOMELAB_PROD` (Teich account): gate.d4f.com → gatey | `/etc/cloudflared/config.yml` is a leftover and is ignored (the token-run tunnel is remotely managed) |
| 107 | gatey | dhcp → .93 | Gate control for the property, used by Oren and neighbors. Public at gate.d4f.com | Code `~/src/gatey` (github.com/teich/gatey). The tunnel targets .93, which has been DHCP-reserved since 2026-10-21 |
| 108 | quickbooks (VM) | ? | Windows 11, QuickBooks. **AAC** | 4 c / 16 G |
| 109 | cloudflared-aac | VLAN5 dhcp → 192.168.5.57 | Connector for tunnel `BV_AAC` (AAC account). Only route: n8n.asphaltanchors.com → 192.168.5.214:5678, **dead since n8n was removed** | Token in the unit's command line; cloudflared 2026.3.0 (old); no PatchMon agent |
| 110 | evcc | 192.168.2.20 | evcc solar/EV charging (:7070) | Stale Tailscale node "evcc" (offline 247 days) |
| 111 | uptimekuma | dhcp → .115 | Uptime Kuma (:3001) | Homepage links to the DHCP IP |
| 112 | proxmox-backup-server | 192.168.2.9 | PBS; datastore `bulk-backups` = `/bulk/backups/pbs` | Daily GC + prune. No verify job, no sync/remote |
| 113 | aac-external-apps | VLAN5 | **stopped**. Abandoned Docker host from 2025-10-31; only `hello-world` was ever run | Cruft |
| 114 | patchmon | dhcp → .122 | PatchMon server (:3000) | Recreated 2026-10-21 08:36 |
| 115 | 2core | 192.168.2.6 | In development: alternative UI for the property's Tucor irrigation controllers. Docker `/opt/2core` (:8787 on localhost; reached over Tailscale) | Code in `~/src` and GitHub |
| 116 | personal-windows (VM) | — | Windows 11, **stopped** | EFI disk lacks the 2023 Secure Boot certs (nightly backup warning) |
| 117 | gamm | dhcp → .218 | **AAC** Google Ads MCP gateway, `gamm.grouse-crested.ts.net` | Code `~/src/aac/gamm` |
| 119 | onas | dhcp → .189 | Samba shares (media, backups, photos, videos, roms) + this dashboard (:3000) | |
| 301 | acc-external-apps (VM) | VLAN5 | **stopped**. Second try at 113 (2025-11-12): Docker + virtiofs mount of `/fast/apps`; only `hello-world` was ever run | Cruft. Name has an "acc" typo |

Removed 2026-10-21 09:05 by oren@pve (cruft, confirmed): 120 ollama, 121 n8n. The 2026-10-20 PBS backups of both still exist.

## Cloudflare tunnels (checked 2026-10-21 with `cf`)

| Account | Tunnel | State | Routes | Connector |
|---------|--------|-------|--------|-----------|
| Teich | HOMELAB_PROD | healthy | gate.d4f.com → 192.168.2.93:3000 (gatey) | LXC 106 |
| Teich | p-teich | **down**, no connector | photos.teich.network → immich (returns **530**). Meant as a friendly Immich share URL for friends **?** | none |
| Teich | phone-gate | **down**, no routes | — | none |
| AAC | BV_AAC | healthy | n8n.asphaltanchors.com → 192.168.5.214:5678 (returns **502**, n8n is gone) | LXC 109 |

## Backups and alerting

- **Guest backups**: nightly at 21:00 to PBS, all guests, snapshot mode. Retention: 7 daily, 4 weekly, 12 monthly, 1 yearly. Succeeding every night.
- **Not backed up**: bind mounts are excluded from guest backups. That leaves out `/bulk/photos`, `/bulk/media`, `/bulk/videos`, `/fast/apps` (the arr configs) and `/bulk/backups` itself. These datasets have **no automatic ZFS snapshots** (only manual ones from 2026-10-13) and **no offsite copy**.
- **PBS is on the same pool it protects.** Losing `bulk` loses both the data and the backups.
- **Alert email doesn't work.** Postfix sends straight to smtp.google.com:25, outbound port 25 is blocked, and 11 messages are stuck in the queue. Backup, ZFS and SMART alerts never arrive.
- `/bulk/backups` also holds AAC, Cadillac, m1-laptop and `DELETE-oren-m1-laptop` folders **?**

## Patch state (apt upgradable, 2026-10-21)

immich 210 · uptimekuma 152 · PBS 137 · arr 88 · onas 85 · homepage 54 · cloudflared-teich 54 · evcc 54 · 2core 18 · gamm 8 · the rest 0. The PatchMon agent is missing on dash (105) and cloudflared-aac (109).

## Network

Checked with `ops/bin/unifi` on 2026-10-21.

- **Gateway**: UniFi Cloud Gateway Fiber "Bennett-Valley" at 192.168.2.1 (BV = Bennett Valley). WANs: Comcast (public 73.158.57.90) and Starlink.
- **Networks**: Default 192.168.2.0/24, DHCP pool .50–.254. AAC, VLAN 5, 192.168.5.0/24, DHCP pool .6–.254.
- **UniFi devices**: switches in Oren Office, Utility Closet, Garage and Pool House; U7 APs in Oren Office, Kitchen Attic, Garage and Pool House (outdoor).
- **Static guest IPs** (.2 host, .4, .5, .6, .9, .13, .20) sit below the DHCP pool, so DHCP never hands them out.

### Guest addressing

| Guest | IP | How it's assigned |
|-------|----|-------------------|
| arr 104 | .119 | DHCP, reserved |
| gatey 107 | .93 | DHCP, reserved (2026-10-21) |
| haos VM 100 | .3 | Static inside HAOS |
| patchmon 114 | .122 | DHCP, reserved 2026-10-21. Every PatchMon agent points at http://192.168.2.122:3000 |
| uptimekuma 111 | .115 | DHCP, not reserved (Homepage links to it) |
| onas 119 | .189 | DHCP, not reserved (Samba shares) |
| quickbooks VM 108 | 192.168.5.221 | DHCP, not reserved |
| dash 105, cloudflared-aac 109 | 192.168.5.30, .5.57 | DHCP, not reserved (outbound tunnel / Tailscale only, so a change is harmless) |
| cloudflared-teich 106, gamm 117 | .181, .218 | DHCP, not reserved (harmless) |

### Reservation cleanup (2026-10-21)

Removed 11 reservations unused for a year or more, at Oren's request. Four of them (.3 homeassistant, .5 toodle, .13 UNMS, .20 IotaWatt-Garage) sat on the static IPs of haos, caddy, immich and evcc. The others were .8, .12 ha-bv, .11 unifi, .14 mineos-bv, .15 tick, .136 ampvm and .216 rustdeskserver, together with its dead local DNS record `rustdesk.teich.network`. The client records were kept; only the fixed IPs were removed.

## Outside WTR: Cloudflare (Teich account)

- **Workers**: `photos` (likely p.teich.net, public photo site, github.com/teich/photos), `garden`, `cpc`, `zednine` **?**
- **Pages**: strixvan.com, pdrhighlights.com, 2026-span.teich.net, sa-course-guide.pages.dev **?**
