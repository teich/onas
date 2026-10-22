# onas

The state and control plane for WTR, the Proxmox host: it collects what's running and how healthy it is on a schedule, keeps that (with history) in SQLite, and serves a dashboard plus a small set of logged actions. It also manages the SMB shares and users served from the onas LXC (119). Plan and phases: [docs/PLAN.md](docs/PLAN.md).

## How it works

```
collectors (scheduled) ──▶ SQLite /var/lib/onas/onas.db ──▶ /api/state, /api/events (SSE) ──▶ UI
        │                                                        ▲
        └── Proxmox API (token), SSH to WTR only as fallback      └── actions (logged in `actions`)
```

- **Collectors** (`server/collectors/`) each run on their own interval: `pve` (guests and node load, 10 s), `node` (load average, kernel, 30 s), `zfs` (pools by API, datasets and snapshots by SSH, 60 s), `smb` (local, 60 s), `disks` (SMART, hourly), `updates` (host apt, hourly), `maintenance` (metric rollups and pruning). Every run is recorded in `collector_runs`; a failing collector keeps its last good data and shows as failing in the UI.
- **Proxmox access** (`server/pve.js`) uses the HTTPS API with the tokens in `/etc/onas/pve.env`. Without a token, or when the token isn't allowed (PVE 9 wants `Sys.Modify` to list apt updates), it runs the same path through `pvesh` over one multiplexed SSH connection.
- **Reads never touch WTR.** `/api/state` is assembled from the database in a few milliseconds; `/api/events` pushes it again whenever a collector finishes or an action is recorded.
- **Actions** (guest power, PVE snapshots, delete; ZFS snapshots; SMB shares and users) go through `server/routes/`, are recorded in the `actions` table and re-run the relevant collector.
- **History**: `metrics` keeps 48 h of 10-second samples, `metrics_5m` 90 days of 5-minute averages. `/api/metrics?series=host.cpu&hours=24`.
- `/api/health` returns 503 and lists stale collectors when any has missed three intervals.

```
server/
  index.js        Express app, SSE, health, metrics
  db.js           node:sqlite, migrations in migrations/NNN_*.sql
  scheduler.js    runs collectors, records runs
  pve.js ssh.js   Proxmox API / pvesh-over-SSH, multiplexed SSH
  collectors/     one module per source
  routes/         guests, storage (ZFS snapshots), smb
  state.js        builds the dashboard state from the database
client/           Vite + React + TypeScript, built to public/
```

## Running

Node 24 or later (it uses the built-in `node:sqlite`).

```bash
npm install && (cd client && npm install)
npm run dev                 # API on :3000 with ./onas-dev.db; reads WTR over SSH unless PVE_* tokens are set
cd client && npm run dev    # Vite with HMR, proxies /api to :3000
```

SMB collection only works inside the LXC (it reads `/etc/samba/smb.conf` and runs `pdbedit`), so it shows as failing on a Mac.

## Deploying

```bash
ops/guests/119-onas/deploy
```

Builds the client, installs Node 24 and the unit if needed, copies the app to `/opt/onas`, restarts `onas.service` and runs `check.sh`. See [ops/guests/119-onas](ops/guests/119-onas/README.md).

## Storage on WTR

| Pool | Config | Size |
|------|--------|------|
| `bulk` | RAIDZ2, 6× WD 6TB | 32.7T |
| `fast` | Mirror, 2× WD Black SN850X 2TB NVMe | 1.81T |

The SMB shares are bulk datasets bind-mounted into LXC 119: `/bulk/{media,backups,photos,videos,roms}` → `/srv/…`.
