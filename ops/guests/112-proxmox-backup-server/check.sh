#!/bin/sh
# Runs inside LXC 112. Prints one line per failed expectation; silent and exit 0 when healthy.
fail=0
[ "$(postconf -h relayhost)" = "[192.168.2.2]:25" ] || { echo "postfix relayhost is not WTR"; fail=1; }
systemctl is-active -q postfix || { echo "postfix not active"; fail=1; }
queued=$(mailq 2>/dev/null | grep -c '^[0-9A-F]')
[ "$queued" -eq 0 ] || { echo "$queued messages stuck in the mail queue"; fail=1; }
exit $fail
