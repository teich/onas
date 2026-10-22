# onas: restructuring plan

Proposed by Claude Code, 2026-10-21. Decisions from Oren (2026-10-21) are under "Decisions" at the end. **Phase 1 is done and deployed (2026-10-22).**

## What onas is for

onas started as a NAS dashboard (ZFS, SMB shares, SMB users), grew into a dense Proxmox view, and the repo has since become where WTR operations start (`ops/`, `INVENTORY.md`). The goals on the Notion row [WTR home server operations](https://app.notion.com/p/400a91fefc7581c2b6aefb02d3a41530) say what it should become:

1. **An attention feed.** One short list of what needs touching across WTR, Cloudflare, Vercel, Tailscale and UniFi, silent when all is well, shown on Homepage and pushed as a daily ntfy digest.
2. **Homepage stays the front door.** onas doesn't compete with it. It feeds Homepage and is where you go to drill in and act.
3. **Agent control with approval.** Typed, safe actions (restart a guest, run a backup, fix permissions) that agents can request and Oren approves.
4. **Keep what Proxmox doesn't do well**: SMB shares and users, guest actions with context, snapshots. Drop screens that duplicate the Proxmox UI.

So onas is the **homelab's state and control plane**: it collects facts on a schedule, keeps them with history, turns them into findings, and offers a small set of audited actions. The UI is one client of that; Homepage, ntfy and agents are the others.

## Why it feels slow today

Measured on 2026-10-21 against the live app (192.168.2.189:3000):

| Request | Time | What it does |
|---|---|---|
| `/api/state` | 0.70–0.95 s | 7 SSH sessions for host stats (incl. a 0.5 s `sleep` for CPU), `pvesh` for guests, 4 more for ZFS every 30 s |
| `/api/host` | 0.63 s | the 7 SSH calls |
| `/api/guests` | 0.65 s | `pvesh get /cluster/resources` (slow CLI start-up) |

- **Nothing is collected until someone asks.** Every request does the work live, so the first paint is an empty dashboard full of zeros for about a second, then everything jumps in.
- **The page polls `/api/state` every 2 s**, with no guard against overlapping requests. One open tab means about 6 new SSH sessions per second to WTR and a full re-render of a single 690-line component, with the whole snapshot list in every response.
- **No history.** The charts start empty each time the page opens, and the activity log lives in memory, so a restart loses it.
- **Stale by accident.** `apt list --upgradable` is cached forever (until the service restarts). Errors are swallowed into empty arrays, so "down" looks like "nothing there".
- **Drift.** The deployed copy is `53a227f`, two commits behind `main`. It runs as root with no auth on the LAN, and it can destroy guests. onas isn't in `ops/`, so none of that is recorded or checked.
- **Dead code.** `ProxmoxDashboard.tsx` replaced the original views, but `components/{storage,shares,users,host}/` (about 2,000 lines) are still there, unused. The `ssh2` dependency is unused too.

## Target architecture

```
 collectors (scheduled)          SQLite (/var/lib/onas/onas.db)        clients
 ┌──────────────────────┐        ┌───────────────────────────┐       ┌────────────────┐
 │ pve     10 s  API    │──────▶ │ current state tables      │──────▶│ onas UI (SSE)  │
 │ zfs     60 s  SSH    │        │ metrics (raw + rollups)   │       │ Homepage widget│
 │ smb     60 s  local  │        │ findings (open/resolved)  │       │ ntfy digest    │
 │ smart   1 h   SSH    │        │ collector_runs            │       │ agents (later) │
 │ pbs     15 m  API    │        │ actions (audit log)       │       └────────────────┘
 │ patchmon 1 h  API    │        └───────────────────────────┘               │
 │ ops-check 1 h SSH    │                     ▲                              │
 │ cloudflare 15 m API  │                     └──── actions (typed, audited) ◀┘
 │ unifi   1 h  API     │
 └──────────────────────┘
```

**Reads never touch WTR.** Every API read is a SQLite query, a few milliseconds. The page renders the last known state immediately, with an age on each section ("ZFS · 40 s ago"), then live updates arrive over Server-Sent Events as collectors finish.

### Collectors

- One module per source, each with an interval, a timeout and a function that returns rows. A small scheduler runs them, never two of the same at once, and writes a `collector_runs` row (start, duration, ok/error, message). A failing collector keeps the last good data and shows as stale with its error, instead of blanking the screen.
- **Use the Proxmox API for Proxmox data** (an API token with the PVEAuditor role for reads): `/cluster/resources`, `/nodes/wtr/status`, `/nodes/wtr/disks/zfs`, `/nodes/wtr/disks/list` (SMART health), backup task history. It replies in tens of milliseconds, where `pvesh` takes half a second, and it already keeps RRD history we can backfill from.
- **SSH only for what the API lacks** (snapshot lists, `zpool status` detail, `smartctl` attributes, `ops/bin/check`), over one persistent connection (`ssh2`, which is already a dependency, or OpenSSH ControlMaster) instead of a new handshake per command.
- Starting set, in the order they matter: pve, zfs, smb, pbs, smart, ops-check. Then patchmon, cloudflare (tunnels, both accounts), unifi (DHCP audit), certificates, Vercel.

### Store

SQLite via `better-sqlite3`, WAL mode, plain SQL migrations in `server/migrations/`.

- **Current state**: `guests`, `pools`, `datasets`, `snapshots`, `disks`, `shares`, `smb_users`, `backups`, each replaced as a whole by its collector.
- **Metrics**: `metrics(ts, series, value)` for host CPU, RAM and I/O, and per-guest CPU and net. Raw for 48 h, 5-minute rollups for 90 days, nightly pruning. Tiny at this scale.
- **Findings**: `findings(key, severity, title, detail, source, first_seen, last_seen, resolved_at, snoozed_until)`. Rules are plain functions over the state tables (a pool isn't ONLINE, a disk fails SMART or runs hot, last backup older than 26 h, a check.sh drifted, a tunnel down, a guest IP not reserved, pending security updates older than 7 days). Keyed, so a finding keeps its first-seen date until it resolves.
- **Actions**: every change (UI or agent) is a row: who, what, target, status, output. Replaces the in-memory activity log.
- **Guest metadata** (labels, links, notes, which dashboard URL) moves from `/etc/pve-dash/guests.json` into the database, editable in the UI. Later it can be seeded from a checked-in inventory file that also generates the `INVENTORY.md` tables and Homepage's `services.yaml`, which is the Notion goal of generating Homepage from the inventory.

### Interface

Four views, each answering one question:

1. **Attention** (the default): open findings by severity, each with what to do and a link to the place to do it. When nothing is open it says so in one line, with a compact status strip: host load, pool health, last backup, update count. This is what makes it worth opening.
2. **Guests**: one table (status, CPU, RAM, IP and whether it's reserved, last backup, pending updates, drift) with service links. A guest detail drawer holds history charts, disks, snapshots, the actions and their log.
3. **Storage**: pools, then datasets with their shares and snapshot policy, so the share-to-dataset link is visible. Snapshot create, rollback and destroy.
4. **Shares & users**: SMB management, as today.

Plus an **Activity** log. The large host charts rail goes: Proxmox does that better, and the status strip plus per-guest history covers what we need.

Front end: keep Vite, React and TypeScript. Split `ProxmoxDashboard.tsx` into views with a small router. Use a query cache (TanStack Query) fed by the SSE stream so only changed sections re-render. Add skeletons sized like the real content, so nothing jumps.

### Security and operations

- Put onas in `ops/guests/119-onas` (unit file, env file location, `check.sh` that confirms it's up and collectors are fresh) and deploy from the repo with a script, so the running copy matches `main`.
- Serve it as `onas.teich.network` through Caddy. Require a login, or restrict access to Tailscale plus the LAN; at minimum gate destructive actions behind a confirmation token. Reserve its IP (.189), which is already on the backlog.
- Split credentials: a read-only PVE token for collectors and a separate, narrower one for actions.

## Phases

Each phase is shippable on its own.

**Phase 0: make today's app feel fast (about half a day).** Move the existing fetches into a background refresh loop and have `/api/state` serve from memory, so it answers in milliseconds. Add an in-flight guard and drop polling to 5 s. Show skeletons instead of zeros. Fix the forever-cached apt list. Deploy `main`. Delete the dead components. No schema yet, but it proves the collector shape.

**Phase 1: SQLite and collectors.** Scheduler, `collector_runs`, state tables, metrics with rollups, the PVE API token, one SSH connection, SSE. The UI reads only from the store, and the charts open with 24 h of history. onas moves into `ops/`.

**Phase 2: the attention feed.** Findings engine and the first rules. Add the pbs, smart, ops-check, patchmon and cloudflare collectors. Build the Attention view, a JSON endpoint for a Homepage `customapi` widget, and a daily ntfy digest that sends nothing when everything is fine. This is the Notion goal #1 and the main reason to open onas.

**Phase 3: rationalize the interface.** The four views, guest drawer, storage plus shares link, guest metadata in the database, auth through Caddy. Optionally the inventory file that generates `INVENTORY.md` tables and Homepage config.

**Phase 4: actions with approval.** A typed action registry (name, parameters, which guests, whether it needs approval). Agents call it over HTTP or MCP; anything that changes state waits as `pending` until Oren approves it in the UI or from the ntfy notification. Same audit table as UI actions. Modelled on gamm's propose/approve/apply flow.

## Decisions (Oren, 2026-10-21)

1. **Proxmox API for everything it supports; SSH only as a fallback.** Done in Phase 1: reads and guest actions use the API; SSH remains for ZFS datasets and snapshots, and for apt updates (PVE 9 wants `Sys.Modify` for that list).
2. **Access through Tailscale**, using its identity as the auth. Phase 3.
3. **Drop the host charts rail.** Done in Phase 1; the activity log moved into the main column.
4. **Self-host ntfy.** Phase 2.
5. **Skip Phase 0 as a separate step**; fold what Phase 1 needs into it. Also: Node 24 (from NodeSource) with the built-in `node:sqlite`.

## Phase 1 as built (2026-10-22)

- `server/` replaces `server.js`: scheduler and collectors (`pve` 10 s, `node` 30 s, `zfs` 60 s, `smb` 60 s, `disks` and `updates` hourly, `maintenance`), SQLite state, metrics with 5-minute rollups, `collector_runs`, an `actions` table, SSE on `/api/events`, `/api/health`, `/api/metrics`.
- The UI subscribes to SSE instead of polling, shows skeleton rows until the first state arrives, and shows each section's age (amber when its collector fails). Guest net rates are computed server-side. The unused storage/shares/users/host views were deleted.
- onas is in `ops/guests/119-onas` (Node 24, `onas.service`, `deploy`, `check.sh`).
- Measured on the live app: `/api/state` 17 ms (was 0.7–0.95 s); Proxmox reads 6–8 ms over the API (was about 650 ms through `pvesh`); the page is interactive in about 0.1 s with data.
- Not done yet: guest IPs and backup status in the guest table (Phase 2 collectors), Tailscale access (Phase 3).
