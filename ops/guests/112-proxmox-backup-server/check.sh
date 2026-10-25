#!/bin/sh
# Runs inside LXC 112. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
[ "$(postconf -h relayhost)" = "[192.168.2.2]:25" ] || { echo "postfix relayhost is not WTR"; fail=1; }
systemctl is-active -q postfix || { echo "postfix not active"; fail=1; }
systemctl is-active -q proxmox-backup-proxy || { echo "proxmox-backup-proxy not active"; fail=1; }
failed=$(systemctl --failed --no-legend --plain | awk '{print $1}' | tr '\n' ' ')
[ -z "$failed" ] || { echo "failed units: $failed"; fail=1; }
mountpoint -q /mnt/s3-cache || { echo "S3 cache volume not mounted at /mnt/s3-cache"; fail=1; }
queued=$(mailq 2>/dev/null | grep -c '^[0-9A-F]')
[ "$queued" -eq 0 ] || { echo "$queued messages stuck in the mail queue"; fail=1; }
# Jobs on the local datastore (2026-10-25): a weekly verify job, and no prune job without keep
# options (retention comes from the PVE vzdump job's prune-backups).
grep -q '^verification: bulk-backups-verify' /etc/proxmox-backup/verification.cfg 2>/dev/null \
	|| { echo "verify job bulk-backups-verify missing"; fail=1; }
awk '/^prune:/ { if (id != "" && !keep) print id; id = $2; keep = 0 } /^[ \t]+keep-/ { keep = 1 } END { if (id != "" && !keep) print id }' \
	/etc/proxmox-backup/prune.cfg 2>/dev/null | while read -r id; do echo "prune job $id has no keep options"; done | grep . && fail=1
exit $fail
