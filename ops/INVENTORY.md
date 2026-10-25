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
- **Front LCD** (960 × 376, USB `0416:90a1`, `/dev/ttyACM0`): shows live status from onas through `wtr-lcd.service` (since 2026-10-22), see `ops/host`.

## Guests

IP "dhcp → x" means the address isn't pinned (it may be a DHCP reservation, **?**).

| ID | Name | IP | What it is | Notes |
|----|------|----|------------|-------|
| 100 | haos (VM) | ? | Home Assistant OS | 2 c / 4 G |
| 101 | caddy | 192.168.2.5 | TLS + reverse proxy for `*.teich.network` (home, evcc, immich, wearables, health-api) | Customized, see `ops/guests/101-caddy` |
| 102 | homepage | 192.168.2.4 | gethomepage dashboard (:3000), home.teich.network. Config is managed in `ops/guests/102-homepage`; secrets live in `/opt/homepage/.env` | Mounts host `/`, `/bulk` and `/fast` read-only (for disk widgets?) |
| 103 | immich | 192.168.2.13 | Immich 3.3.4 (bare-metal install, Postgres 16, Redis) | Photos from `/bulk/photos`. Also on Tailscale. 12 cores |
| 104 | arr | dhcp → .119 | Docker: Jellyfin, Sonarr, Radarr, SABnzbd, qBittorrent, Audiobookshelf, Booklore (`grimmory` image), MariaDB | `/bulk/media`, `/fast/apps`; iGPU passthrough; Tailscale |
| 105 | dash | VLAN5 dhcp → 192.168.5.30 | **AAC** production BI: Postgres 16, importer, dashboard, rclone Dropbox sync | Tailscale `dash.grouse-crested.ts.net`. No PatchMon agent |
| 106 | cloudflared-teich | dhcp → .181 | Connector for tunnel `HOMELAB_PROD` (Teich account): gate.d4f.com → gatey | `/etc/cloudflared/config.yml` is a leftover and is ignored (the token-run tunnel is remotely managed) |
| 107 | gatey | dhcp → .93 | Gate control for the property, used by Oren and neighbors. Public at gate.d4f.com | Code `~/src/gatey` (github.com/teich/gatey). The tunnel targets .93, which has been DHCP-reserved since 2026-10-21 |
| 108 | quickbooks (VM) | ? | Windows 11, QuickBooks. **AAC** | 4 c / 16 G |
| 109 | cloudflared-aac | VLAN5 dhcp → 192.168.5.57 | Connector for tunnel `BV_AAC` (AAC account). Only route: n8n.asphaltanchors.com → 192.168.5.214:5678, **dead since n8n was removed** | Token in the unit's command line; cloudflared 2026.3.0 (old); no PatchMon agent |
| 110 | evcc | 192.168.2.20 | evcc solar/EV charging (:7070) | Stale Tailscale node "evcc" (offline 247 days) |
| 111 | uptimekuma | dhcp → .115 | Uptime Kuma (:3001) | Homepage links to the DHCP IP |
| 112 | proxmox-backup-server | 192.168.2.9 | PBS 4.2.8 (upgraded 2026-10-21); datastore `bulk-backups` = `/bulk/backups/pbs`; 128 GB S3 cache at `/mnt/s3-cache` | Daily GC + prune. No verify job yet. B2 offsite datastore in progress, see `ops/guests/112-proxmox-backup-server` |
| 113 | aac-external-apps | VLAN5 | **stopped**. Abandoned Docker host from 2025-10-31; only `hello-world` was ever run | Cruft |
| 114 | patchmon | dhcp reserved → .122 | PatchMon server (:3000) | Recreated 2026-10-21 08:36 |
| 115 | 2core | 192.168.2.6 | In development: alternative UI for the property's Tucor irrigation controllers. Docker `/opt/2core` (:8787 on localhost; reached over Tailscale) | Code in `~/src` and GitHub |
| 116 | personal-windows (VM) | — | Windows 11, **stopped** | EFI disk lacks the 2023 Secure Boot certs (nightly backup warning) |
| 117 | gamm | VLAN5 dhcp → 192.168.5.232 | **AAC** Google Ads MCP gateway, tailnet-only at `gamm.grouse-crested.ts.net` via tailscale serve | Code `~/src/aac/gamm`. Moved from the LAN (.218) to VLAN 5 on 2026-10-22 (snapshot `pre-vlan5`). Its PatchMon agent reports through the AAC → PatchMon firewall policy |
| 119 | onas | dhcp → .189 | Samba shares (media, backups, photos, videos, roms) + this dashboard (:3000) | Customized, see `ops/guests/119-onas` (Node 24 from NodeSource, `onas.service`, 2026-10-22) |
| 122 | books | VLAN5 dhcp → 192.168.5.149 | **AAC** SlowBooks Pro (Docker prod stack: app + Postgres 17), tailnet-only at `books.grouse-crested.ts.net` via tailscale serve | Created 2026-10-22, see `ops/guests/122-books`. No PatchMon agent yet |
| 123 | wearables | 192.168.2.14 | Open Wearables 0.10.0 (Docker, published images: API, Celery, Postgres 18, Redis, portal). wearables.teich.network (portal) and wearables-api.teich.network (API) via Caddy. Also the Teich Health app backend (`teich-health.service`, Go, :8100, health-api.teich.network) | Created 2026-10-24, see `ops/guests/123-wearables`. No public URL, so provider webhooks can't reach it (pull sync only). No PatchMon agent yet |
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
- **Offsite (started 2026-10-21):** Backblaze B2 bucket `teich-wtr-pbs` as the PBS datastore `b2-offsite`. Encrypted guest backups sync nightly, and WTR sends photos, videos, arr configs and old machine backups itself (`ops/host`). The first upload of about 5.6 TB at about 25 Mbps should finish around mid-November.
- **Alert email** (fixed 2026-10-21): WTR's Postfix relays through Gmail (smtp.gmail.com:587, app password for oren@teich.net) and PBS relays through WTR. See `ops/host`. Before the fix, port 25 was blocked and alerts had been stuck since at least 2026-10-18.
- `/bulk/backups` also holds AAC, Cadillac, m1-laptop and `DELETE-oren-m1-laptop` folders **?**

## Patch state

Patching is done from PatchMon (http://192.168.2.122:3000): open a host and start a patch run, which runs apt on that guest through its agent. Before 2026-10-21 most guests had never been updated since install. On 2026-10-21 PatchMon patched every agent guest (about 700 packages, mostly Debian security fixes) after `pre-catchup` snapshots (`pre-patchmon-test` on 2core), and all services came back. Only patchmon (114) itself had updates left (3). The arr Docker images were updated by hand the same day (PatchMon only reports Docker updates; pull them on the arr guest). Since 2026-10-21 every running LXC installs Debian security updates automatically each day (`ops/common/security-updates`); everything else waits for a PatchMon "patch all" run. The PatchMon agent is missing on dash (105), cloudflared-aac (109), books (122) and wearables (123). VLAN 5 is isolated from the LAN, so on 2026-10-22 a UniFi firewall policy "Allow AAC to PatchMon" (zone AAC → Internal, TCP 192.168.2.122:3000 only, index 10000, ahead of the built-in "Isolated Networks" block) was added to let agents on VLAN 5 check in. gamm (117) reports again; other LAN ports stay blocked from VLAN 5.

## Network

Checked with `ops/bin/unifi` on 2026-10-21.

- **Gateway**: UniFi Cloud Gateway Fiber "Bennett-Valley" at 192.168.2.1 (BV = Bennett Valley). WANs: Comcast (public 73.158.57.90) and Starlink.
- **Networks**: Default 192.168.2.0/24, DHCP pool .50–.254. AAC, VLAN 5, 192.168.5.0/24, DHCP pool .6–.254.
- **UniFi devices**: switches in Oren Office, Utility Closet, Garage and Pool House; U7 APs in Oren Office, Kitchen Attic, Garage and Pool House (outdoor).
- **Static guest IPs** (.2 host, .4, .5, .6, .9, .13, .14, .20) sit below the DHCP pool, so DHCP never hands them out. Two unlisted devices also answer below the pool: .7 (MAC 3c:8a:1f:0d:2c:1b) and .21 (dc:4f:22:5e:87:ce), seen 2026-10-24 **?**
- **Tailnets**: two. `teich.net` (giraffe-gamma.ts.net) is personal and holds WTR and the home guests. `asphaltanchors.com` (grouse-crested.ts.net) is AAC and holds dash, gamm, books (all `tag:server`) and quickbooks. AAC work doesn't go through WTR: dash, gamm and books run Tailscale SSH (`tailscale set --ssh`, enabled on gamm and books 2026-10-22), so `ssh root@gamm` works from the Mac on the AAC tailnet. The AAC policy already had an SSH rule that lets `oren@asphaltanchors.com` in as root. `pct exec` on WTR is for host-level work only. Switch the Mac with `tailscale switch`.

### Guest addressing

| Guest | IP | How it's assigned |
|-------|----|-------------------|
| arr 104 | .119 | DHCP, reserved |
| gatey 107 | .93 | DHCP, reserved (2026-10-21) |
| haos VM 100 | .3 | Static inside HAOS |
| patchmon 114 | .122 | DHCP, reserved 2026-10-21 (Default network set on the reservation 2026-10-22). Every PatchMon agent, and the AAC → PatchMon firewall policy, points at http://192.168.2.122:3000 |
| uptimekuma 111 | .115 | DHCP, not reserved (Homepage links to it) |
| onas 119 | .189 | DHCP, not reserved (Samba shares) |
| quickbooks VM 108 | 192.168.5.221 | DHCP, not reserved |
| dash 105, cloudflared-aac 109, gamm 117 | 192.168.5.30, .5.57, .5.232 | DHCP, not reserved (outbound tunnel / Tailscale only, so a change is harmless) |
| cloudflared-teich 106 | .181 | DHCP, not reserved (harmless) |
| books 122 | 192.168.5.149 | DHCP, not reserved (Tailscale only, so a change is harmless) |

### Reservation cleanup (2026-10-21)

Removed 11 reservations unused for a year or more, at Oren's request. Four of them (.3 homeassistant, .5 toodle, .13 UNMS, .20 IotaWatt-Garage) sat on the static IPs of haos, caddy, immich and evcc. The others were .8, .12 ha-bv, .11 unifi, .14 mineos-bv, .15 tick, .136 ampvm and .216 rustdeskserver, together with its dead local DNS record `rustdesk.teich.network`. The client records were kept; only the fixed IPs were removed.

## Cloudflare and Vercel

Checked on 2026-10-21 with `cf` 1.0.0-beta.20 and `vercel` 59.23. Status codes come from an HTTPS request to each hostname. **?** marks an open question for Oren.

### Accounts

- **Cloudflare AAC** (`805dfbc806bf099214ef74cdb7d21dc7`): 10 zones, all on the Free plan.
  - Workers: shopify-ip-geo, asphalt-anchors-mockup, testlog-web, asphalt-anchors-sites, sink, tools, asphalt-anchors-brand, landing.
  - Pages: help (help.asphaltanchors.com).
  - Storage: R2 buckets pbs-backup, quickbooks-backup, sink and testlog-web-files (2.35 GB in total, so **the backup buckets are effectively empty**). D1 databases testlog-web, sink, tools-margin-tracker and aac-fyi-db. KV namespace sink.
  - Access: testlog. Tunnel: BV_AAC.
- **Cloudflare Teich** (`02bd603968db4f77d62a3c447ee329a2`): 13 zones.
  - Workers: garden, photos, cpc, zednine.
  - Pages: sa-course-guide, pdrhighlights-site, 2026-presentation.
  - Storage: R2 buckets photos and pdrhighlights (1.1 GB). D1 database tennis-scheduler-db.
  - Tunnels: HOMELAB_PROD, p-teich (down) and phone-gate (down).
- **Vercel** team `orent` (Hobby plan): projects teich (teich.net), simantob (simantob.com), v0-geology-portfolio-design and v0-shopify-storefront-design (never deployed to production). Domains added in Vercel: teich.net, simantob.com and d4f.com (**d4f.com has no DNS pointing at Vercel**, so that entry is stale). All production deploys are Ready.

### Zones

| Zone | Acct | What it serves | Registrar / expiry |
|------|------|----------------|--------------------|
| asphaltanchors.com | AAC | Shopify store (apex, www). Workers: brand, frontline, geoip, go, mockup, testlog (behind Access), tools. help → Pages. Google mail. news keeps its SES MX and SPF records (for sending). n8n → BV_AAC tunnel | CF, 2027-05-12 |
| asphalt-anchors.com | AAC | GoDaddy parking/forwarding (proxied) + GoDaddy mail; brand → Worker | CF, 2027-05-12 |
| askaac.com | AAC | GoDaddy forwarding IPs (proxied); Google mail | elsewhere **?** |
| bolt-hold.com | AAC | GoDaddy forwarding IPs and GoDaddy mail subdomains | elsewhere **?** |
| aac.fyi | AAC | Worker → redirect to asphaltanchors.com | elsewhere **?** |
| asphaltanchorscorp.com | AAC | Redirect to asphaltanchors.com; Google mail | elsewhere **?** |
| boltholdanchor.com, boltholdanchors.com | AAC | Cloudflare placeholder page | CF, 2027-09-08 |
| designatedparking.com | AAC | Wix site (www); Google mail; old mail/store/m hosts | elsewhere **?** |
| dp-corp.com | AAC | GoDaddy forwarding + GoDaddy mail | CF, 2028-08-16 |
| teich.net | Teich | Vercel (apex, www, scheduler). Workers: p and photos (photo site), garden, 9fji. 2026-span → Pages. blog → Squarespace. store → 3.131.150.69 (shared redirect service, unconfigured). Google mail | CF, 2033-06-02 |
| teich.network | Teich | `*` → LAN (Caddy, unproxied); photos → tunnel p-teich. No apex record (deleted 2026-10-21) | CF, 2027-10-07 |
| d4f.com | Teich | gate → HOMELAB_PROD tunnel (gatey); Fastmail mail | CF, 2030-06-02 |
| simantob.com | Teich | Vercel; Google mail | CF, 2027-06-02 |
| zednine.com | Teich | Worker zednine; blobs → R2; Google mail | CF, 2027-06-02 |
| constancepeck.com, constancepeckcollection.com | Teich | Worker (both); Google mail | CF, 2027-06-02 |
| pdrhighlights.com | Teich | Pages; dl → R2; Cloudflare Email Routing | CF, 2027-03-01 |
| strixvan.com | Teich | Nothing. Van sold; Pages project and DNS deleted 2026-10-21 | CF, 2027-06-28, auto-renew off (left to lapse) |
| canvaslabs.com | Teich | 3.131.150.69, a shared redirect service on AWS EC2 (probably a former DNS provider's URL forwarding), redirecting to usecanvas.com | CF, 2027-10-20 |
| zed9.org | Teich | Google mail only | CF, 2027-01-29 |
| highlanddesignboulder.com, usecanvas.com | Teich | No records (parked) | CF, 2027-09-20 / 2027-01-26 |

### Broken or suspicious (2026-10-21)

Deleted on 2026-10-21 at Oren's request: qb.asphaltanchors.com (an unused RustDesk proxy idea), a.teich.net (dangling Vercel CNAME with an expired certificate) the teich.network apex (pointed at the old WAN IP), the news. and survey.asphaltanchors.com A records (their VPS was hacked and deleted), and strixvan.com (Pages project and DNS; the van is sold).

- **AAC, customer-facing**
  - n8n.asphaltanchors.com returns **502** (n8n was removed).
  - asphalt-anchors.com fails the TLS handshake and www returns 404. askaac.com, bolt-hold.com and www.asphaltanchorscorp.com time out. dp-corp.com returns **525**. These are GoDaddy forwarding IPs behind Cloudflare's proxy, which doesn't work. The goal is zero GoDaddy and zero Wix; nobody uses the GoDaddy mailboxes.
  - The GoDaddy mail subdomains on bolt-hold.com return 530 or time out.
  - designatedparking.com: m returns 525 and store returns 523; mail and webmail time out. The main www site (Wix) is fine.
- **Teich**
  - blog.teich.net returns 404 (Squarespace).
  - store.teich.net returns 404, and canvaslabs.com returns 525; both point at a shared redirect service on AWS. store.teich.net isn't configured there, and canvaslabs.com redirects to usecanvas.com, which has no DNS.
  - photos.teich.network returns 530 (tunnel p-teich is down).
  - The Vercel domain entry for d4f.com is stale.
- **Working as expected**
  - 2026-span.teich.net returns 401 (password-protected).
  - testlog redirects to Cloudflare Access.
  - blobs.zednine.com and dl.pdrhighlights.com return 404 at the root, which is normal for public R2 buckets.
