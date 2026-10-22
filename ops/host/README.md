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
