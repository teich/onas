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
- **Our own backend image** (2026-10-24), so we can add a Tonal provider. `wearables-build` clones upstream at `OW_VERSION`, applies `files/etc/openwearables/patches/*.patch` in order with `git am`, and builds `local/open-wearables-backend:<version>-onas`; the compose file runs that with `pull_policy: never`. The frontend stays the published image. A patch that stops applying fails the build, so nothing is dropped silently. The source of the patch is `~/src/open-wearables`, branch `teich/tonal` (from tag 0.10.0); regenerate with `git format-patch 0.10.0..teich/tonal -o files/etc/openwearables/patches` (use the current upstream tag) after changing it. `ops/bin/push` only adds and overwrites, so delete a renamed or dropped patch on the guest too, or the build will apply it twice.

## Tonal

Added 2026-10-24 at Oren's request. Tonal has no official API, so this uses the unofficial one documented by [tonal-api](https://github.com/danmarai/tonal-api) and [toneget](https://github.com/curlrequests/toneget). It can break whenever Tonal changes its app. Oren chose a native provider over a sidecar, and wanted it to stay out of Open Wearables' own code as much as possible: everything is in `backend/app/services/providers/tonal/`, and outside it only the provider and score-category enums, the factory, the API router list (one line, for the sign-in form) and an icon change. Project notes are in Notion: Personal projects → Tonal connector for Open Wearables.

- **What it syncs** on the normal hourly pull: each Tonal workout (title as `label`, heart rate and calories from the Apple Watch pairing, per-movement sets with weight, reps, 1RM, power and ROM in `segments`, fetched with `include=segments`), and the strength score history as health scores, category `strength`, provider `tonal`, linked to the workout that changed them.
- **Everything Tonal sends is kept** (2026-10-24, so the app can tell chains and eccentric sets apart and use Tonal's 1RM for PRs). Each set has `chains`/`eccentric` with the extra weight, `peak_weight_lb` (weight plus chains or eccentric load), `spotter_mode`, average power and velocity, and Tonal's raw summary and set activity under `tonal` (raw set weights are per motor, half the summary's on two-handed moves). Each movement keeps its own Tonal fields, and a last `tonal_workout` segment holds the rest of the workout. About 6.5 MB for 119 workouts. Tonal's power numbers aren't watts despite the `_w` name. A sync now rewrites the segments of workouts already stored, so after changing what's extracted, re-pull the whole history: `docker exec openwearables-app-1 python -c "from uuid import UUID; from app.database import SessionLocal; from app.services.providers.tonal.strategy import TonalStrategy; s=SessionLocal(); print(TonalStrategy().workouts.load_data(s, UUID('<ow-user-id>'), start_date='2015-01-01T00:00:00Z'))"`.
- **Strength score `value` is the overall score ÷ 10** (`qualifier` = `x10`), because `health_score.value` is numeric(6,3) and Tonal scores pass 1,000. `components` holds the real overall, upper, lower and core scores. Oren's choice, to avoid a schema migration.
- **Connecting, per person** (2026-10-24, so Oren's wife can connect her own Tonal): open the user's pairing page, `https://wearables.teich.network/users/<ow-user-id>/pair`, and choose Tonal. Tonal's Auth0 only accepts its own app's redirect, so instead of Tonal's login page the person gets our form (`/api/v1/oauth/tonal/signin` on the API, `tonal/signin.py`). It takes the Tonal email and password, or sends an email code if the password is left empty, signs in with Tonal once, and hands the tokens to Open Wearables' normal callback under a one-time code. Only the tokens are kept, never the password. The callback queues its usual 90-day backfill; ours queues 400 days five minutes later, because a second pull of the same account while one is running is skipped.
- **Fallback from a shell**, e.g. to repair a revoked connection: `docker exec -it openwearables-app-1 python -m app.services.providers.tonal.connect <ow-user-id> [--days N]` asks for the same sign-in in the terminal. Tonal rotates the refresh token on every refresh, so a connection that stops refreshing needs a fresh sign-in either way.
- The same workouts also arrive from Apple Health (source "Tonal", provider apple) with only duration and calories. Provider priority decides which one summaries use.

## Teich Health backend

Added 2026-10-24 at Oren's request, for the Teich Health iPhone app (code in `~/src/teich-health`). OW's docs expect an app's own backend to sit in front of it: OW's read API only takes API keys, and any key can read every user, so keys and the SDK app secret stay on the server. Oren didn't want to patch OW for per-user reads, so this is a separate service.

- **What it does**: pairs each phone with one OW user, hands the phone upload-only SDK tokens for Apple Health sync (`POST /v1/sdk-token`), and serves that user's dashboard and Tonal exercise history (`/v1/dashboard`, `/v1/exercises[/{id}]`). The exercise views are built from the Tonal workouts' per-set `segments`, cached 5 minutes per user.
- **Runs** as `teich-health.service` (Go binary `/usr/local/bin/teich-health`, user `teich-health`) on :8100, reached through Caddy at **https://health-api.teich.network** (route added to the Caddyfile on 101; backup `Caddyfile.bak-2026-10-24-teich-health`). State is a SQLite file of paired devices in `/var/lib/teich-health`.
- **Credentials**: `/etc/teich-health/env` (mode 600, not in this repo) holds an OW API key named "teich-health backend" and the SDK application "teich-health iOS", both created in OW for this.
- **Deploy** the binary with `~/src/teich-health/server/deploy`; the unit and `teich-health-admin` come from here (`ops/bin/push 123-wearables`) `pct push` can't overwrite the running binary and still exits 0, so the script pushes `teich-health.new` and renames it.
- **Pairing a phone**: `pct exec 123 -- /usr/local/bin/teich-health-admin users` to find the OW user ID, then `... teich-health-admin pair <ow-user-id>` prints a one-time code (30 minutes) to type into the app. `devices` lists paired phones and `revoke <id>` unpairs one.

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

Then bump `OW_VERSION` in `/etc/openwearables/env` and the default in `compose.yml`, `ops/bin/push 123-wearables`, then `wearables-build && wearables-compose pull && wearables-compose up -d`. The app migrates on start. If `wearables-build` stops at `git am`, rebase `teich/tonal` in `~/src/open-wearables` onto the new tag, run the Tonal tests (`uv run pytest tests/providers/tonal tests/providers/test_provider_coverage.py`), regenerate the patch and push again.

## Backups

Nightly PBS backups of the guest include the Docker volumes (`openwearables_postgres_data`, `openwearables_redis_data`) and `/etc/openwearables`. Crash-consistent, as with books.

## Checks

`check.sh` verifies every container is running, Postgres is healthy, the API and portal answer, and the env file is mode 600.
