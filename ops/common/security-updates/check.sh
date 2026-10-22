#!/bin/sh
# Runs inside each guest listed in targets. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q "ok installed" || { echo "unattended-upgrades not installed"; fail=1; }
[ -f /etc/apt/apt.conf.d/52unattended-security-only ] || { echo "security-only config missing"; fail=1; }
apt-config dump APT::Periodic::Unattended-Upgrade | grep -q '"1"' || { echo "automatic upgrades switched off"; fail=1; }
systemctl is-active -q apt-daily-upgrade.timer || { echo "apt-daily-upgrade.timer not active"; fail=1; }
log=/var/log/unattended-upgrades/unattended-upgrades.log
if [ -f "$log" ]; then
	[ -n "$(find "$log" -mtime -3)" ] || { echo "no unattended-upgrades run in 3 days"; fail=1; }
	awk '/Starting unattended upgrades script/ { run = "" } { run = run $0 "\n" } END { printf "%s", run }' "$log" \
		| grep -q ERROR && { echo "last unattended-upgrades run logged an error ($log)"; fail=1; }
fi
exit $fail
