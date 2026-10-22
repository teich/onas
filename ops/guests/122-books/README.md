# 122 books

SlowBooks Pro (AAC bookkeeping) at https://books.grouse-crested.ts.net, reachable only from the AAC tailnet. Created 2026-10-22 by Claude Code at Oren's request.

Debian 13, unprivileged, `nesting=1,keyctl=1` for Docker, `/dev/net/tun` for Tailscale. On the AAC VLAN 5 (`tag=5`, like dash 105), DHCP; it only needs outbound access, so the address doesn't matter.

## How it runs

- **The app** is SlowBooks' own production compose stack (`docker-compose.prod.yml`: the app plus PostgreSQL 17 over TLS), run from a pristine release checkout in `/opt/slowbooks` (tag `v2.25.0`). Docker's `restart: unless-stopped` brings it back after a reboot.
- **`slowbooks-compose`** (`files/usr/local/bin/`) is `docker compose` with the project, env file and override filled in. Use it for everything: `slowbooks-compose ps`, `logs -f slowbooks`, `up -d --build`.
- **`/etc/slowbooks/env`** (mode 600, not in this repo) holds the generated secrets (`POSTGRES_PASSWORD`, `PAYROLL_ENCRYPTION_SECRET`, `SESSION_SECRET_KEY`) and settings (`FORCE_HTTPS=true`, `TRUST_PROXY_HEADERS=true`, `CORS_ALLOW_ORIGINS=https://books.grouse-crested.ts.net`, `APP_WORKERS=2`). **`PAYROLL_ENCRYPTION_SECRET` must be kept**: without it a restored database can't decrypt payroll and saved API keys. Copy it to 1Password.
- **`/etc/slowbooks/certs/postgres/`** is a self-signed pair for the app → Postgres hop, which never leaves Docker's network (the prod file requires `sslmode=require`).
- **Tailscale**: joined as `books`; `tailscale serve --bg --https=443 http://127.0.0.1:3001` publishes it on the tailnet only. The config persists in tailscaled's state; `tailscale serve status` shows it.

## Customizations

- **`files/etc/slowbooks/compose.tailnet.yml`** (2026-10-22), layered on the prod compose file:
  - publishes the app on **127.0.0.1:3001 only**, so tailscale serve is the one way in (the prod file publishes nothing);
  - sets **`FORWARDED_ALLOW_IPS=*`** for uvicorn. docker-proxy connects from the bridge gateway (172.18.0.1), not 127.0.0.1, so uvicorn otherwise ignores tailscale serve's `X-Forwarded-Proto: https` and `FORCE_HTTPS` redirects every request to https forever. Safe because nothing but tailscaled can reach the port;
  - mounts the Postgres cert from `/etc/slowbooks/certs/postgres` instead of `./certs/postgres`, so the checkout stays clean.

## Upgrading

Take a dump first, then move the checkout to the new tag and rebuild (the app migrates on start):

```sh
pct exec 122 -- sh -c 'slowbooks-compose exec -T postgres pg_dump -U bookkeeper bookkeeper | gzip > /root/pre-upgrade.sql.gz'
pct exec 122 -- sh -c 'cd /opt/slowbooks && git fetch --depth 1 origin tag vX.Y.Z && git checkout -q vX.Y.Z && slowbooks-compose up -d --build'
```

## Backups

Nightly PBS backups of the guest include the Docker volumes (`slowbooks_postgres_data`, uploads, backups) and `/etc/slowbooks`. A PBS snapshot of a running Postgres is crash-consistent, which Postgres recovers from; a nightly `pg_dump` is the open gap if a logical copy is wanted too.

## Checks

`check.sh` verifies both containers are running and healthy, the port is bound to loopback only, `/health` answers through the forwarded-HTTPS path, Tailscale is up and `tailscale serve` points at the app.
