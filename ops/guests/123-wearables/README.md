# 123 wearables

[Open Wearables](https://openwearables.io) 0.10.0, a self-hosted API that pulls health data from wearables (Garmin, Oura, Whoop, Polar, Strava, Fitbit, …). Created 2026-10-24 by Claude Code at Oren's request.

- **Portal**: https://wearables.teich.network (developer portal: sign in, API keys, users, connections)
- **API**: https://wearables-api.teich.network (Swagger at `/docs`)

Both go through Caddy (101), so they work on the LAN and over the tailnet. Debian 13, unprivileged, `nesting=1,keyctl=1` for Docker, 2 cores / 4 GB. Static IP **192.168.2.14** because Caddy proxies to it (.7 and .21 are taken by devices that aren't in the inventory).

## How it runs

- **The stack** is the docs' baseline production compose (Postgres 18, Redis 8, API, Celery worker and beat, SvelteKit portal) using the published images pinned to `OW_VERSION`. Not the repo's `docker-compose.yml`, which is a dev setup. The API publishes :8000, the portal :3000. Docker's `restart: unless-stopped` brings it back after a reboot.
- **`wearables-compose`** (`files/usr/local/bin/`) is `docker compose` with the project and env file filled in: `wearables-compose ps`, `logs -f app`. `pct exec` doesn't put `/usr/local/bin` on PATH, so call it by full path from WTR.
- **`/etc/openwearables/env`** (mode 600, not in this repo) is the upstream `backend/config/.env.example` for 0.10.0 with an "onas overrides" block appended (later lines win): generated `DB_PASSWORD`, `SECRET_KEY` and `ADMIN_PASSWORD`, `ADMIN_EMAIL=oren@teich.net`, the public URLs, `ENVIRONMENT=production`, `SENTRY_ENABLED=False`, `TELEMETRY_ENABLED=false`. Provider OAuth credentials go in that block too.
- The admin account was seeded on first start. Changing `ADMIN_PASSWORD` afterwards does nothing; change it in the portal.

## Customizations

- **`files/etc/openwearables/compose.yml`** (2026-10-24): the baseline compose with a shared backend anchor, the version pinned, and the env file moved to `/etc/openwearables/env`.
- **Caddy routes** for `wearables` and `wearables-api` were added to the Caddyfile on 101 (backup `Caddyfile.bak-2026-10-24`). The Caddyfile isn't tracked in ops yet.

## Providers

Each provider needs a developer app with its client ID/secret in the env file and the redirect URI `https://wearables-api.teich.network/api/v1/oauth/<provider>/callback` (check the provider page in the docs for the exact path). OAuth works from any browser that can reach the API. **Provider webhooks (Garmin, Oura, Strava push) need a public URL**, which this doesn't have; until a Cloudflare tunnel route is added, data arrives by the hourly pull sync (`SYNC_INTERVAL_SECONDS`).

## Clients

- **Oren's iPhone** (2026-10-24) syncs Apple Health through the React Native SDK's example app, built locally from `~/src/open-wearables-react-native-sdk` (branch `teich/ios27`, bundle ID `net.teich.openwearables`) because the official app is TestFlight-only. iOS 27 kills apps built with its SDK that don't adopt the UIScene lifecycle, and Expo 54's generated AppDelegate doesn't, so that branch adds a `SceneDelegate`. The fix lives in the generated `ios/` folder: don't run `expo prebuild --clean`; rebuild with `xcodebuild -configuration Release -destination generic/platform=iOS` and install with `xcrun devicectl device install app`.
- The phone reaches the API only on home Wi-Fi: `*.teich.network` resolves to Caddy's LAN address and nothing on the tailnet routes to it. HealthKit keeps the data, so syncs catch up at home.
- The first sync backfilled millions of records. The guest disk is 24 GB (4 GB used after the first hour); watch it.

## Upgrading

```sh
ssh root@192.168.2.2 "pct exec 123 -- sh -c 'docker exec openwearables-db-1 pg_dump -U open-wearables open-wearables | gzip > /root/pre-upgrade.sql.gz'"
```

Then bump `OW_VERSION` in `/etc/openwearables/env` and the default in `compose.yml`, `ops/bin/push 123-wearables`, and `wearables-compose pull && wearables-compose up -d`. The app migrates on start.

## Backups

Nightly PBS backups of the guest include the Docker volumes (`openwearables_postgres_data`, `openwearables_redis_data`) and `/etc/openwearables`. Crash-consistent, as with books.

## Checks

`check.sh` verifies every container is running, Postgres is healthy, the API and portal answer, and the env file is mode 600.
