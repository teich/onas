# 112 proxmox-backup-server

Proxmox Backup Server. Datastore `bulk-backups` = `/bulk/backups/pbs`.

## Postfix relays through WTR (2026-10-21)

**Why:** like WTR, it had no relay host and would have tried to send to Google on the blocked port 25. Relaying through WTR keeps the Gmail app password in one place.

**What:** `files/etc/postfix/main.cf` sets `relayhost = [192.168.2.2]:25`. WTR accepts relay from 192.168.2.9 only (see `ops/host`), so PBS needs to keep that static IP.

## Upgraded to PBS 4.2 for the B2 offsite datastore (2026-10-21)

**Why:** offsite backups go to Backblaze B2 as a PBS S3 datastore, which is production-ready from PBS 4.2.

**What changed:**
- Upgraded 4.0.18 → 4.2.8 (`apt dist-upgrade`, 142 packages; log in `/root/pbs42-upgrade.log`).
- Apt sources cleaned up. The enterprise repo is `Enabled: no` (no subscription). Three leftover bookworm-era `.list` files were moved to `/root/apt-sources-pre-pbs42/`, including an active `pbs-install-repo.list` that pointed at the bookworm repo. Only `proxmox.sources` (trixie, pbs-no-subscription) is in use.
- Memory 2 → 4 GB. New `mp1`, a 128 GB volume on `fast` at `/mnt/s3-cache` with `backup=0`, holds the S3 datastore's local cache.
- `zfs-mount`, `zfs-share` and `zfs-zed` are masked. There's no ZFS inside this unprivileged container. The first two always failed, and `zed` started failing with ZFS 2.4.
- Rollback point: ZFS snapshot `fast/subvol-112-disk-0@pre-pbs42` (root disk only). `pct snapshot` refuses because of the `mp0` bind mount. Delete the snapshot once the B2 setup has run cleanly for a week.

## B2 offsite datastore (2026-10-21)

Configured with `proxmox-backup-manager` (PBS keeps it in `/etc/proxmox-backup/`; nothing here to push):

- S3 endpoint `backblaze`: `s3.us-west-001.backblazeb2.com`, region `us-west-001`, path style, quirk `skip-if-none-match-header`, upload capped at 3 MiB/s (`rate-out`) because the uplink is 40 Mbps. Oren entered the key (B2 app key `wtr-pbs`) himself.
- Datastore `b2-offsite` on bucket `teich-wtr-pbs`, cache `/mnt/s3-cache`. GC Sundays 04:00.
- Prune job `b2-offsite-prune` at 05:00: 7 daily, 4 weekly, 6 monthly. Verify job `b2-offsite-verify` monthly, re-verifying snapshots after 90 days. Verifying reads from B2, which is free up to 3× what's stored.
- Sync job `bulk-to-b2` at 23:00: local pull from `bulk-backups`, **encrypted snapshots only**, 2 workers. Guest backups are encrypted from 2026-10-21 (PVE storage `pbs-lxc` has `encryption-key`). Older, unencrypted snapshots stay local and age out under the normal retention.
- User `wtr-host@pbs` and token `wtr-host@pbs!offsite` have DatastoreBackup on `b2-offsite` only, for WTR's own file backups (see `ops/host`).
- An older endpoint `cf-r2` (AAC account R2) predates this work and is unused.

## Local datastore jobs (2026-10-25)

**Why:** onas's new Backups tab flagged two things on `bulk-backups`. Its prune job (`default-bulk-backups-aebc491a-55`, daily) had no keep options: every night its log listed all 646 snapshots as "remove" and it ended with a warning. Nothing was actually removed, but a job whose log says "remove everything" is one PBS change away from doing it. And no verify job had ever checked that the local backups still restore.

**What:**
- Removed the prune job. Retention for guest backups comes from the PVE vzdump job (`prune-backups keep-last=7,keep-daily=7,keep-weekly=4,keep-monthly=12,keep-yearly=1`, applied after each backup).
- Added verify job `bulk-backups-verify`: Saturdays 02:00, skips snapshots verified in the last 30 days. The first run reads the whole datastore (about 1.8 TB from the HDD pool) and will take hours.
- Old files: `/root/prune.cfg.pre-2026-10-25` and `/root/verification.cfg.pre-2026-10-25`. `check.sh` checks the verify job exists and that no prune job lacks keep options.
