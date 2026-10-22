#!/bin/sh
# Runs inside LXC 119. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
[ "${major:-0}" -ge 24 ] || { echo "node is ${major:-missing}, want 24+ (NodeSource repo)"; fail=1; }
systemctl is-active -q onas || { echo "onas service not active"; fail=1; }
systemctl is-active -q nas-dashboard 2>/dev/null && { echo "old nas-dashboard service still running"; fail=1; }
systemctl is-active -q smbd || { echo "smbd not active"; fail=1; }
# /api/health is 503 when any collector has missed three of its intervals.
health=$(node -e 'fetch("http://127.0.0.1:3000/api/health").then(async r => { const h = await r.json(); console.log(r.status === 200 ? "ok" : "stale: " + h.stale.join(", ")); }).catch(e => console.log("unreachable: " + e.message))')
[ "$health" = ok ] || { echo "onas health $health"; fail=1; }
exit $fail
