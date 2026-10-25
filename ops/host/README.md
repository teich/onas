# WTR (Proxmox host)

Customizations on the host itself. `ops/bin/push host` installs `files/`; `ops/bin/check` runs `check.sh` on WTR along with the guests.

## Postfix relays through Gmail (2026-10-21)

**Why:** Postfix delivered straight to Google on port 25, which the ISP blocks. Alerts had been stuck in the queue since at least 2026-10-18, so backup, ZFS and SMART emails never arrived.

**What:** `files/etc/postfix/main.cf` relays through `[smtp.gmail.com]:587` with TLS and SASL as oren@teich.net. It also listens on 192.168.2.2 and accepts mail from PBS (192.168.2.9) only, so PBS relays through here (see `guests/112-proxmox-backup-server`).

- Needs `libsasl2-modules` (installed 2026-10-21; not in the stock install).
- The credential is a Google app password named `wtr-postfix`, stored only in `/etc/postfix/sasl_passwd` (root, 0600) and its `.db`. Not in this repo. To rotate it, revoke it at https://myaccount.google.com/apppasswords, create a new one, and rerun:

  ```
  ssh -t root@192.168.2.2 'read -rsp "App password: " P; echo; P=$(printf %s "$P" | tr -d " "); umask 077; printf "[smtp.gmail.com]:587 oren@teich.net:%s\n" "$P" > /etc/postfix/sasl_passwd; postmap /etc/postfix/sasl_passwd'
  ```

- `inet_protocols = ipv4` because WTR has no IPv6 route out.
- Test: `printf "Subject: test\n\nhi\n" | sendmail oren@teich.net`, then `journalctl -t postfix/smtp -n 5`.
- The pre-change file is at `/etc/postfix/main.cf.pre-relay`.

## Offsite backup of host data to B2 (2026-10-21)

**Why:** guest backups skip bind mounts, so photos, videos, the arr configs and the old machine backups had no offsite copy. Oren chose Backblaze B2 as a PBS S3 datastore; the comparison is in Notion ("WTR offsite backup options and prices (October 2026)").

**What:** `wtr-offsite-backup.timer` runs `/usr/local/sbin/wtr-offsite-backup` nightly at 23:30. It sends `/fast/apps`, `/bulk/backups/{AAC,Cadillac,m1-laptop}`, `/bulk/photos` and `/bulk/videos` to the `b2-offsite` datastore on PBS as `host/wtr`, encrypted, with metadata change detection so later runs only read changed files.

- Left out on purpose: `/bulk/media` and `/bulk/roms` (replaceable), `/bulk/backups/pbs` (synced by PBS itself), `dump`, `template`, `DELETE-oren-m1-laptop`.
- Credentials: `/etc/wtr-offsite-backup.env` (root, 0600) holds the API token `wtr-host@pbs!offsite`, which can only back up to `b2-offsite`. To replace it, regenerate the token in PBS and rewrite the file.
- **Encryption key:** `/etc/pve/priv/storage/pbs-lxc.enc` (fingerprint `fd:39:3b:a3…`), the same key PVE uses for guest backups. Its paper key is in 1Password ("WTR PBS encryption key"). **Without it the B2 copy can't be restored.**
- The uplink is 40 Mbps, so the PBS endpoint caps B2 uploads at 3 MiB/s (about 25 Mbps). The first upload of about 5.6 TB takes about 3 weeks; until it finishes, each nightly run waits for the previous one to end.
- Status: `journalctl -u wtr-offsite-backup`, or the `b2-offsite` datastore in the PBS UI.
- **One group per dataset (2026-10-25):** the first runs sent everything as a single group, `host/wtr`. The Oct 21 run died after 3 days on a B2 "connection reset", so it left no snapshot and the next run had no manifest to compare against: every night re-read all 5.6 TB. Now each dataset is its own group (`host/wtr-apps`, `host/wtr-photos`, …) and a failure only costs that dataset. The script carries on past a failed dataset and exits 1 at the end. Chunks already in B2 are not uploaded again, so the switch costs one more full read, not another upload. The old `host/wtr` group can be pruned once every new group has a snapshot.

## ZFS ARC tuning (2026-10-25)

**Why:** host CPU sat at about 15% during the offsite backup's file walk. Dnodes (ZFS's per-file metadata) reached 1.3 GiB against a limit of 651 MB, 10% of a 6 GiB ARC, so the kernel thread `arc_prune` spun on a whole core trying to evict them.

**What:** `etc/modprobe.d/zfs.conf` raises `zfs_arc_max` from 6 to 12 GiB (WTR has 62 GiB, about 17 GiB was free) and `zfs_arc_dnode_limit_percent` from 10 to 25, a 3 GiB dnode limit. The file is copied into the initramfs, so after changing it run `update-initramfs -u -k all`, and set the values live under `/sys/module/zfs/parameters` (or reboot). The old file is at `/root/zfs.conf.pre-arc-tuning`. `check.sh` checks the live values, that the initramfs is newer than the file, and that dnodes stay under the limit.

## Front LCD shows live status (2026-10-22)

**Why:** the 960 x 376 screen on the front of the case only ever showed the AOOSTAR logo. AOOSTAR's software for it is Windows-only, so nothing on Proxmox talked to it. Oren wanted it to read like a real control panel: the clock, CPU, memory, pools, network, bay activity and an alert line, matching the virtual screen on onas's Machine view.

**What:** `wtr-lcd.service` runs `/usr/local/sbin/wtr-lcd`, which uses only the Python standard library (nothing installed). Once a second it fetches `http://192.168.2.189:3000/api/lcd/frame`, a 240 x 94 frame drawn by onas with the same `drawLcd()` as the Machine view (`client/src/lib/lcd.ts`). It draws each dot as a solid 4 x 4 pixel square and sends the panel only the parts that changed. A full redraw takes about 1.3 s.

- **Brightness (2026-10-24):** the panel has no brightness command (the protocol has only on, off and image) and its backlight looks dim in a bright room. So `wtr-lcd` fills each dot solid (no gap between dots) and lifts every lit colour with a 0.6 gamma (`LIFT`); near-black colours stay dark. Only the physical panel looks different; the Machine view is unchanged.
- **Fallback:** after three missed fetches it draws its own panel instead, from local sensors: clock, CPU % and Tctl, memory, pool fill, the fastest linked port's traffic and the load average. The footer gives the reason: ONAS NOT RESPONDING, or ONAS SENT NO LCD FRAME when the running onas build lacks the endpoint. So the screen never freezes on old numbers. When the service stops, it draws "FRONT LCD SERVICE STOPPED" with the time.
- **The panel:** a Synwit MCU on USB (`0416:90a1`, cdc_acm), at `/dev/serial/by-id/usb-Synwit_USB_Virtual_COM-if00`, which answers each command with `A`. The protocol is from [zehnm/aoostar-rs](https://github.com/zehnm/aoostar-rs/blob/main/docs/lcd_protocol.md), reverse-engineered from the vendor's app; we use its exact messages and 47-byte chunks. That project's author warns that a malformed message could hang the panel firmware; a power cycle should recover it.
- **Hardening:** runs unprivileged (`DynamicUser`, group `dialout`) with access only to the ttyACM devices and `/dev/zfs` (for `zpool list`).
- **State:** `/run/wtr-lcd/status`: `source` (onas or fallback), `reason`, `fallback_since`, `acked` (the last frame the panel took) and `error`. `check.sh` reports these problems: the service isn't running, the panel has taken no frame for 2 minutes, or the screen has been on the fallback for 5 minutes.
- **By hand:** `wtr-lcd --off` / `--on` switch the panel off and on (it keeps the last image); `wtr-lcd --once` draws one frame (stop the service first).
- **To revert:** `systemctl disable --now wtr-lcd`, delete the unit and `/usr/local/sbin/wtr-lcd`, and `systemctl daemon-reload`. The panel keeps the "stopped" frame until it loses power; the logo is in its firmware and should come back after a power cycle.

## Automatic ZFS snapshots with sanoid (2026-10-25)

**Why:** `bulk/photos`, `bulk/videos`, `fast/apps` and `bulk/backups` are bind-mounted into guests, so vzdump skips them and they have no local backup copy; the offsite job sends them only to B2, and its first upload takes weeks. Guests write to them (immich has `/bulk/photos` read-write, arr has `/fast/apps`), so a bad update or a stray delete would have been unrecoverable. RAIDZ2 covers a failed disk, not a deleted file.

**What:** `sanoid` from Debian (`apt install sanoid`, which also brings `libcapture-tiny-perl`, `libconfig-inifiles-perl` and `mbuffer`). `etc/sanoid/sanoid.conf` snapshots photos, videos and apps hourly ×24, daily ×14 and monthly ×6, and `bulk/backups` daily ×14 and monthly ×6. Not recursive, so `bulk/backups/pbs` is left alone. `sanoid.timer` runs every 15 minutes and only creates and prunes `autosnap_*` snapshots; manual snapshots are untouched. The package's `/etc/cron.d/sanoid` only runs on systems without systemd.

- **Quota:** `bulk/photos` has `quota=4T` (not `refquota`), so snapshot space counts toward it. Deleted photos keep using quota until their last snapshot ages out (up to six months). There's about 1 TB of headroom; switching to `refquota=4T` would stop snapshots counting, if that ever matters.
- **Restoring:** each dataset's snapshots are browsable read-only at `<mountpoint>/.zfs/snapshot/<name>/`, for example `/bulk/photos/.zfs/snapshot/autosnap_2026-10-25_10:06:33_daily/`. Copy files back from there, or `zfs rollback` for a whole dataset (it destroys newer snapshots).
- `check.sh` checks sanoid is installed, its timer is active, and every dataset has a recent autosnap. onas's Backups tab shows each dataset's newest snapshot and flags any that has gone stale.
- **To revert:** `systemctl disable --now sanoid.timer`, `apt remove sanoid`, delete `/etc/sanoid/sanoid.conf`, and `zfs destroy` the `autosnap_*` snapshots if their space is wanted back.
