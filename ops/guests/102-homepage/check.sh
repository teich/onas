#!/bin/sh
# Runs inside LXC 102. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
cd /opt/homepage || { echo "/opt/homepage missing"; exit 1; }
systemctl is-active -q homepage || { echo "homepage service not active"; fail=1; }
for v in $(grep -ho '{{HOMEPAGE_VAR_[A-Z0-9][A-Z0-9_]*}}' config/*.yaml | tr -d '{}' | sort -u); do
	grep -q "^$v=." .env 2>/dev/null || { echo "$v referenced in config but not set in .env"; fail=1; }
done
grep -q "Managed by onas" config/services.yaml || { echo "services.yaml was replaced outside ops/ (no managed header)"; fail=1; }
exit $fail
