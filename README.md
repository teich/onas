# onas

The state and control plane for WTR, the Proxmox host: it collects what's running and how healthy it is on a schedule, keeps that (with history) in SQLite, and serves a dashboard plus a small set of logged actions. It also manages the SMB shares and users served from the onas LXC (119). Plan and phases: [docs/PLAN.md](docs/PLAN.md).

## How it works

```
collectors (scheduled) ──▶ SQLite /var/lib/onas/onas.db ──▶ /api/state, /api/events (SSE) ──▶ UI
        │                                                        ▲
        └── Proxmox API (token), SSH to WTR only as fallback      └── actions (logged in `actions`)
```

- **Collectors** (`server/collectors/`) each run on their own interval: `pve` (guests and node load, 10 s), `node` (load average, kernel, 30 s), `hardware` (per-disk I/O, temperatures and NIC traffic read over SSH in one round-trip, mapped onto WTR's physical drive bays, M.2 slots and ports, 10 s), `zfs` (pools by API, datasets and snapshots by SSH, 60 s), `smb` (local, 60 s), `disks` (SMART, hourly), `updates` (host apt, hourly), `maintenance` (metric rollups and pruning). Every run is recorded in `collector_runs`; a failing collector keeps its last good data and shows as failing in the UI.
- **Proxmox access** (`server/pve.js`) uses the HTTPS API with the tokens in `/etc/onas/pve.env`. Without a token, or when the token isn't allowed (PVE 9 wants `Sys.Modify` to list apt updates), it runs the same path through `pvesh` over one multiplexed SSH connection.
- **Reads never touch WTR.** `/api/state` is assembled from the database in a few milliseconds; `/api/events` pushes it again whenever a collector finishes or an action is recorded.
- **Actions** (guest power, PVE snapshots, delete; ZFS snapshots; SMB shares and users) go through `server/routes/`, are recorded in the `actions` table and re-run the relevant collector.
- **History**: `metrics` keeps 48 h of 10-second samples, `metrics_5m` 90 days of 5-minute averages. `/api/metrics?series=host.cpu&hours=24`. The hardware series (`disk.<serial>.{read,write,busy,temp}`, `nic.<name>.{rx,tx}`, `cpu.temp`) have no Proxmox RRD data, so `maintenance` averages them into `metrics_5m` itself.
- **Hardware slots**: the `hardware` collector assumes which physical slot each disk and NIC is in (SATA port N is bay N; M.2 drives and NICs by PCI order; the defaults are at the top of `collectors/hardware.js`) and marks it `slotSource: "assumed"`. `/etc/onas/hardware.json`, `{ "slots": { "<disk serial or NIC name>": "<slot key>" } }`, overrides that (`"config"`). HDD temperatures come from `smartctl -n standby`, at most every 5 minutes and only for a drive that has done I/O since its last read, so a spun-down drive is not woken and SMART polling does not keep an idle drive from sleeping; an idle drive keeps its last temperature, with the time it was read.
- `/api/health` returns 503 and lists stale collectors when any has missed three intervals.
- **Front LCD**: `/api/lcd/frame` is the picture for WTR's physical front screen, 240 x 94 RGB drawn by the same `drawLcd()` (`client/src/lib/lcd.ts`) as the Machine view's virtual one. `npm run build:lcd` in `client/` bundles it for Node as `server/lcd-render.cjs` (deploy does this). `wtr-lcd` on WTR fetches it once a second: see [ops/host](ops/host/README.md).

```
server/
  index.js        Express app, SSE, health, metrics
  db.js           node:sqlite, migrations in migrations/NNN_*.sql
  scheduler.js    runs collectors, records runs
  pve.js ssh.js   Proxmox API / pvesh-over-SSH, multiplexed SSH
  collectors/     one module per source
  routes/         guests, storage (ZFS snapshots), smb
  state.js        builds the dashboard state from the database
  lcd.js          the front LCD frame (renders client/src/lib/lcd.ts)
client/           Vite + React + TypeScript, built to public/
  src/viz/machine/  the Machine view's WebGPU point-cloud engine; types.ts is the model format
  public/wtr-max/   the point cloud of WTR itself, exported by model/wtr-max/build.py
model/wtr-max/    Blender script that builds the AOOSTAR WTR MAX and samples it; research notes
```

## The Machine view

The front page draws WTR (an AOOSTAR WTR MAX) as a live point cloud of about 400k points, so it answers what Proxmox doesn't: which physical bay holds which disk, whether it's healthy, how hot each part is, and what is moving data right now. The slot list beside it carries the same information as text and works without WebGPU.

- **Lenses.** Colour is the lens; motion is live activity in all of them. *Drives* tints each drive by its pool and pulses a failing one in its actual bay. *Heat* colours every sensor against its own limit (HDD 25–55 °C, NVMe 30–80, CPU 40–95, RAM 30–85). *Traffic* draws data as a river: each device's spur feeds trunks through the SATA controller and the board to the CPU, cool toward the CPU (reads, rx) and warm away from it (writes, tx).
- **Selecting** a bay slides its tray out and opens a card with SMART, vdev errors, live I/O, a 1-hour sparkline and what lives on the pool. `#/machine?slot=bay3` links straight to it; the Storage tab's disk tiles link there too.
- **Slots are assumed** until confirmed in `/etc/onas/hardware.json` (see Hardware slots above). The M.2 placement in particular is inferred: see [model/wtr-max/README.md](model/wtr-max/README.md).
- **The model** is rebuilt with `blender -b --factory-startup --python model/wtr-max/build.py -- --out client/public/wtr-max` and checked with `node model/wtr-max/check.mjs`. Part keys are fixed (`bay1`..`bay6`, `m2s1`..`m2s5`, `lan1`, `sfp1`, ...) because the collector's slots name them.
- **Tuning** the look: `cd client && npm run dev`, then open `/lab.html` (dev only, not in the build) for per-part controls, lens presets, look sliders and a benchmark. `node client/scripts/placeholder-model.mjs` writes a stand-in model to `client/lab/placeholder/` if the real one is missing.

## Running

Node 24 or later (it uses the built-in `node:sqlite`).

```bash
npm install && (cd client && npm install)
npm run dev                 # API on :3000 with ./onas-dev.db; reads WTR over SSH unless PVE_* tokens are set
cd client && npm run dev    # Vite with HMR, proxies /api to :3000 (ONAS_API=http://host:port for another API)
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
