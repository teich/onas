#!/bin/sh
# Runs inside LXC 123. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
for s in db redis app celery-worker celery-beat frontend; do
	state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "openwearables-$s-1" 2>/dev/null)
	case "$state" in
	"running " | "running healthy") ;;
	*) echo "openwearables-$s-1: ${state:-missing}"; fail=1 ;;
	esac
done
curl -sf http://127.0.0.1:8000/ | grep -q 'Server is running' || { echo "API on :8000 not answering"; fail=1; }
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)
case "$code" in 2*|3*) ;; *) echo "portal on :3000 returned $code"; fail=1 ;; esac
docker inspect -f '{{.Config.Image}}' openwearables-app-1 2>/dev/null | grep -q -- '-onas$' || { echo "app is not on the local -onas image (no Tonal provider); run wearables-build"; fail=1; }
revoked=$(docker exec openwearables-db-1 psql -U open-wearables -d open-wearables -tAc "select count(*) from user_connection where provider = 'tonal' and status <> 'active'" 2>/dev/null)
[ "${revoked:-0}" = 0 ] || { echo "$revoked Tonal connection(s) not active: rerun the Tonal connect step (README)"; fail=1; }
[ "$(stat -c %a /etc/openwearables/env 2>/dev/null)" = 600 ] || { echo "/etc/openwearables/env missing or not mode 600"; fail=1; }
systemctl is-active -q teich-health || { echo "teich-health.service not running"; fail=1; }
curl -sf http://127.0.0.1:8100/healthz >/dev/null || { echo "teich-health /healthz failing (can it reach OW with its API key?)"; fail=1; }
[ "$(stat -c %a /etc/teich-health/env 2>/dev/null)" = 600 ] || { echo "/etc/teich-health/env missing or not mode 600"; fail=1; }
exit $fail
