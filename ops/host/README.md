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
