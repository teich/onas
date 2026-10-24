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
[ "$(stat -c %a /etc/openwearables/env 2>/dev/null)" = 600 ] || { echo "/etc/openwearables/env missing or not mode 600"; fail=1; }
exit $fail
