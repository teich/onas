#!/bin/sh
# Runs on WTR itself. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
[ "$(postconf -h relayhost)" = "[smtp.gmail.com]:587" ] || { echo "postfix relayhost is not Gmail"; fail=1; }
[ -s /etc/postfix/sasl_passwd.db ] || { echo "postfix sasl_passwd.db missing"; fail=1; }
dpkg -s libsasl2-modules >/dev/null 2>&1 || { echo "libsasl2-modules not installed"; fail=1; }
systemctl is-active -q postfix || { echo "postfix not active"; fail=1; }
queued=$(mailq 2>/dev/null | grep -c '^[0-9A-F]')
[ "$queued" -eq 0 ] || { echo "$queued messages stuck in the mail queue"; fail=1; }
systemctl is-active -q wtr-offsite-backup.timer || { echo "wtr-offsite-backup.timer not active"; fail=1; }
systemctl is-failed -q wtr-offsite-backup.service && { echo "last offsite backup failed (journalctl -u wtr-offsite-backup)"; fail=1; }
[ -s /etc/wtr-offsite-backup.env ] || { echo "/etc/wtr-offsite-backup.env missing"; fail=1; }
[ -s /etc/pve/priv/storage/pbs-lxc.enc ] || { echo "PBS encryption key missing"; fail=1; }
# ZFS ARC tuning (etc/modprobe.d/zfs.conf), live and in the initramfs that applies it at boot.
zp=/sys/module/zfs/parameters
[ "$(cat $zp/zfs_arc_max)" = 12884901888 ] || { echo "zfs_arc_max is $(cat $zp/zfs_arc_max), not 12 GiB"; fail=1; }
[ "$(cat $zp/zfs_arc_dnode_limit_percent)" = 25 ] || { echo "zfs_arc_dnode_limit_percent is not 25"; fail=1; }
[ "/boot/initrd.img-$(uname -r)" -nt /etc/modprobe.d/zfs.conf ] \
	|| { echo "initramfs older than /etc/modprobe.d/zfs.conf (run update-initramfs -u -k all)"; fail=1; }
awk '$1 == "dnode_size" { d = $3 } $1 == "arc_dnode_limit" { l = $3 } END { exit !(d > l) }' /proc/spl/kstat/zfs/arcstats \
	&& { echo "ZFS dnodes over the ARC dnode limit (arc_prune will spin)"; fail=1; }
# Front LCD: wtr-lcd running, the panel taking frames, and those frames coming from onas.
[ -e /dev/serial/by-id/usb-Synwit_USB_Virtual_COM-if00 ] || { echo "front LCD USB device missing"; fail=1; }
lcd() { sed -n "s/^$1=//p" /run/wtr-lcd/status 2>/dev/null; }
now=$(date +%s)
started=$(lcd started)
acked=$(lcd acked)
since=$(lcd fallback_since)
if ! systemctl is-active -q wtr-lcd; then
	echo "wtr-lcd (front LCD) not active"; fail=1
elif [ $((now - ${acked:-${started:-0}})) -ge 120 ]; then
	err=$(lcd error)
	echo "front LCD has taken no frame for 2+ min${err:+: $err} (journalctl -u wtr-lcd)"; fail=1
elif [ "$(lcd source)" = fallback ] && [ -n "$since" ] && [ $((now - since)) -ge 300 ]; then
	echo "front LCD on its own fallback for $(((now - since) / 60)) min: $(lcd reason)"; fail=1
fi
# Automatic ZFS snapshots (etc/sanoid/sanoid.conf): the timer runs, and each dataset has a
# recent autosnap (hourly ones within 2 h, daily-only within 26 h).
dpkg -s sanoid >/dev/null 2>&1 || { echo "sanoid not installed"; fail=1; }
systemctl is-active -q sanoid.timer || { echo "sanoid.timer not active"; fail=1; }
now=$(date +%s)
for spec in bulk/photos:7200 bulk/videos:7200 fast/apps:7200 bulk/backups:93600; do
	ds=${spec%%:*}; max=${spec#*:}
	last=$(zfs list -Hp -t snapshot -o name,creation -s creation "$ds" 2>/dev/null | awk -v d="$ds@autosnap_" 'index($1, d) == 1 { t = $2 } END { print t + 0 }')
	[ $((now - last)) -le "$max" ] || { echo "$ds has no autosnap in the last $((max / 3600)) h"; fail=1; }
done
exit $fail
