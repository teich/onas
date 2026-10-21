# 101 caddy

Reverse proxy and TLS for `*.teich.network` at 192.168.2.5. Routes are in `/etc/caddy/Caddyfile` on the guest (not yet tracked here).

## Customizations

- **Cloudflare DNS module.** The wildcard cert uses the DNS-01 challenge through `caddy-dns/cloudflare`, which the Debian package doesn't include. `caddy add-package` swaps in a custom build from caddyserver.com.
- **Apt hook** (`files/`). Every apt upgrade puts the stock binary back and takes every site down (this happened on 2026-10-21, with 2.11.4 → 2.11.7). `99caddy-cloudflare` runs `caddy-ensure-cloudflare` after each dpkg run, and that script rebuilds and restarts Caddy if the module is missing. It writes to the journal under the tag `caddy-ensure-cloudflare`.

## Checks

`check.sh` verifies that the hook is installed, the module is present and the service is running.
