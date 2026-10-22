#!/bin/sh
# Runs inside LXC 122. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
for c in slowbooks-postgres-1 slowbooks-slowbooks-1; do
	state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
	[ "$state" = "running healthy" ] || { echo "$c: ${state:-missing}"; fail=1; }
done
# The app must only listen on loopback; tailscale serve is the way in.
ss -tlnH 'sport = :3001' | grep -v '127.0.0.1:3001' | grep -q . && { echo "port 3001 bound beyond loopback"; fail=1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' http://127.0.0.1:3001/health)
[ "$code" = 200 ] || { echo "/health via forwarded https returned $code (FORWARDED_ALLOW_IPS override?)"; fail=1; }
[ "$(stat -c %a /etc/slowbooks/env 2>/dev/null)" = 600 ] || { echo "/etc/slowbooks/env missing or not mode 600"; fail=1; }
tailscale status >/dev/null 2>&1 || { echo "tailscale not running"; fail=1; }
tailscale serve status 2>/dev/null | grep -q 'http://127.0.0.1:3001' || { echo "tailscale serve not proxying to 127.0.0.1:3001"; fail=1; }
exit $fail
