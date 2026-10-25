#!/bin/sh
# Runs inside LXC 123. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
systemctl is-active -q teich-health || { echo "teich-health.service not running"; fail=1; }
curl -sf http://127.0.0.1:8100/healthz >/dev/null || { echo "teich-health /healthz failing"; fail=1; }
[ "$(stat -c %a /etc/teich-health/env 2>/dev/null)" = 600 ] || { echo "/etc/teich-health/env missing or not mode 600"; fail=1; }
[ "$(stat -c %a /var/lib/teich-health 2>/dev/null)" = 700 ] || { echo "/var/lib/teich-health missing or not mode 700 (it holds source credentials)"; fail=1; }
bad=$(/usr/local/bin/teich-health-admin connections 2>/dev/null | awk 'NR>1 && $4 != "ok"')
[ -z "$bad" ] || { echo "connections needing attention:"; echo "$bad"; fail=1; }
exit $fail
