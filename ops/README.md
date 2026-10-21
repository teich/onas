# ops

Every change we make on WTR or a guest, beyond what the guest's installer gave us, lives here. If it isn't in this folder, it's undocumented and could disappear without anyone noticing.

```
ops/
  bin/push <id-name>     copy guests/<id-name>/files/ onto that guest's /
  bin/check [id-name…]   run each guest's check.sh inside it; prints only problems
  bin/unifi <cmd>        read-only UniFi queries: networks, clients, known, reservations, devices
                         (key in Keychain as `unifi-api`; it can write, so make changes only when asked)
  guests/<id>-<name>/
    README.md            what the guest is, what we changed and why (with dates)
    files/               files to install, laid out as a root filesystem
    check.sh             runs inside the guest; prints a line for each problem, exit 1 if any
```

## Rules

1. **Change it here, then push.** Never hand-edit a managed file on the guest. If you fixed something by hand during an outage, copy it back here before you finish.
2. **Every customization gets a "why" line** in the guest's README, with the date and what broke.
3. **Every customization gets a check.** If it can silently stop working (an upgrade overwrites it, a service stops), `check.sh` should catch it. `ops/bin/check` across all guests is what tells us something has drifted.
4. **Secrets never go here.** Reference where they live on the guest instead (for example `/etc/caddy/cloudflare.env`).
5. **Name directories `<vmid>-<hostname>`** to match `pct list` / `qm list`. LXCs only for now; `push` and `check` use `pct exec`.
