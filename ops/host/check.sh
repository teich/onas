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
exit $fail
