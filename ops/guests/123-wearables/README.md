# 123 wearables

The helper server for the **Teich Health** iPhone app (code in `~/src/teich-health`), at **https://health-api.teich.network** through Caddy (101). Debian 13, unprivileged, 2 cores / 4 GB, static IP **192.168.2.14** because Caddy proxies to it.

## What it is

The phone is the store. The app reads Apple Health on the phone and keeps its own copy of everything else. This server only does what a phone does badly: it stays signed in to sources that have no public API, pulls from them every hour, keeps their raw responses, and hands each phone what changed (`GET /v1/changes?since=<cursor>`). Tonal is the only source today; Eight Sleep is next. Each source is a Go package with its own sign-in prompts, so connecting a new one needs no app change.

History (2026-10-24/25): this guest first ran Open Wearables 0.10.0 (Docker) with a Tonal provider patched in, and an earlier version of this server in front of it. Oren decided OW was too heavy for an app whose real store is the phone, so on 2026-10-25 OW was removed (containers, volumes, images, `/etc/openwearables`, the `wearables` and `wearables-api` Caddy routes; Caddyfile backup `Caddyfile.bak-2026-10-25-remove-ow` on 101). Its data wasn't kept: Health data is on the phones and Tonal's history comes back from Tonal. Docker is still installed but unused.

## How it runs

- `teich-health.service` runs `/usr/local/bin/teich-health serve` as the `teich-health` user on :8100, with `/etc/teich-health/env` (mode 600; no secrets, just `LISTEN` and `DB_PATH`).
- **State** is one SQLite file, `/var/lib/teich-health/teich-health.db`: people, paired phones (token hashes only), each person's connection to each source, and every raw record. **Source credentials are in it** (Tonal's id and refresh tokens, never passwords), so the directory is mode 700. Tonal rotates its refresh token on every use; the server saves the new one before doing anything else, and a person only has to sign in again if a refresh is rejected (the app then says "Sign in to Tonal again").
- **Deploy** the binary with `~/src/teich-health/server/deploy` (tests, cross-compile, push, restart). `pct push` can't overwrite the running binary and still exits 0, so the script pushes `teich-health.new` and renames it. The unit and `teich-health-admin` come from here (`ops/bin/push 123-wearables`).

## Admin

`pct exec 123 -- /usr/local/bin/teich-health-admin <command>` (full path: `pct exec` has no `/usr/local/bin` on PATH):

- `people`, `add-person <name>`: one person per phone owner (Oren is 1).
- `pair <person>`: a one-time code (30 minutes) to type into the app. Then the person connects their sources in the app's Settings.
- `devices`, `revoke <id>`: paired phones.
- `connections`: each connection's status, last sync and error.
- `sync <person> <source>`: sync now and print how many records changed.

## Checks

`check.sh` verifies the service is running, `/healthz` answers, the env file is mode 600, and no connection is waiting for a new sign-in or failing.
