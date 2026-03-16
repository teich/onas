# NAS Dashboard

A self-hosted dashboard for monitoring and managing a Proxmox ZFS NAS over SSH, running as an LXC container service.

## Features

- **Storage** — Live ZFS pool status, vdev topology, per-pool I/O sparklines (2s polling), dataset/volume table with snapshot counts, and a detail panel for per-dataset properties and snapshot management
- **Shares** — SMB share configuration UI backed by `/etc/samba/smb.conf`; create, edit, and delete shares with live reload
- **Users** — SMB user management via `useradd` + `smbpasswd`; create users, reset passwords, delete users

## Architecture

```
/opt/nas-dashboard/
  server.js          Express API — runs on port 3000
  package.json       Server deps (express, ssh2)
  public/            Vite build output — served statically
  client/
    src/
      App.tsx
      index.css
      lib/            types.ts · helpers.ts · api.ts
      components/
        Topbar.tsx
        storage/      StorageView · PoolCard · IoSection · DatasetTable · DetailPanel
        shares/       SharesView · ShareRow · SharePanel
        users/        UsersView · UserRow · UserPanel
```

**Backend** — Node.js/Express. ZFS data is fetched by SSHing to the Proxmox host at `192.168.2.2` (system SSH key, no library needed). SMB config and user management run locally inside the LXC.

**Frontend** — Vite + React + TypeScript. Built to `public/` and served by Express. Dark industrial aesthetic: Syne display font, IBM Plex Mono, amber for the `bulk` pool, cyan for `fast`.

## ZFS Setup (Proxmox host 192.168.2.2)

| Pool | Config | Size |
|------|--------|------|
| `bulk` | RAIDZ2 — 6× WD 6TB | 32.7T |
| `fast` | Mirror — 2× WD Black SN850X 2TB NVMe | 1.81T |

## Bind Mounts (LXC → host)

These are configured on the Proxmox host in the LXC config and expose the bulk datasets inside the container for Samba:

| Host path | Mount point |
|-----------|-------------|
| `/bulk/media` | `/srv/media` |
| `/bulk/backups` | `/srv/backups` |
| `/bulk/photos` | `/srv/photos` |
| `/bulk/videos` | `/srv/videos` |
| `/bulk/roms` | `/srv/roms` |

## Running

The dashboard runs as a systemd service:

```bash
systemctl status nas-dashboard
systemctl restart nas-dashboard
journalctl -u nas-dashboard -f
```

## Development

```bash
# Terminal 1 — Express API
node server.js

# Terminal 2 — Vite dev server with HMR (proxies /api → :3000)
cd client && npm run dev
```

## Production build

```bash
cd client && npm run build   # outputs to ../public/
# then restart the service to serve the new build
systemctl restart nas-dashboard
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/zfs` | Pool list, datasets, snapshots |
| GET | `/api/iostat` | Per-pool I/O rates (2-sample delta) |
| GET | `/api/dataset/:name` | ZFS properties for one dataset |
| POST | `/api/snapshot` | Create a snapshot |
| GET | `/api/smb` | Parse `/etc/samba/smb.conf` → share list |
| PUT | `/api/smb` | Write share list → reload smbd |
| GET | `/api/users` | List SMB users via `pdbedit -L` |
| POST | `/api/users` | Create user (`useradd` + `smbpasswd -a`) |
| DELETE | `/api/users/:name` | Delete user (`smbpasswd -x` + `userdel`) |
| PUT | `/api/users/:name/password` | Reset password via `smbpasswd -s` |
