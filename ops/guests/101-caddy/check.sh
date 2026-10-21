#!/bin/sh
# Runs inside LXC 101. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
[ -x /usr/local/sbin/caddy-ensure-cloudflare ] || { echo "hook script missing"; fail=1; }
[ -f /etc/apt/apt.conf.d/99caddy-cloudflare ] || { echo "apt hook config missing"; fail=1; }
caddy list-modules 2>/dev/null | grep -qx dns.providers.cloudflare || { echo "caddy lacks dns.providers.cloudflare"; fail=1; }
systemctl is-active -q caddy || { echo "caddy service not active"; fail=1; }
exit $fail
