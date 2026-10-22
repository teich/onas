# 112 proxmox-backup-server

Proxmox Backup Server. Datastore `bulk-backups` = `/bulk/backups/pbs`.

## Postfix relays through WTR (2026-10-21)

**Why:** like WTR, it had no relay host and would have tried to send to Google on the blocked port 25. Relaying through WTR keeps the Gmail app password in one place.

**What:** `files/etc/postfix/main.cf` sets `relayhost = [192.168.2.2]:25`. WTR accepts relay from 192.168.2.9 only (see `ops/host`), so PBS needs to keep that static IP.
