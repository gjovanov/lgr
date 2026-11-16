#!/bin/bash
# What can this place reach? Run it in the guest, and again in a container on it:
#
#   guard-check.sh open github.com:443 closed 10.10.130.1:22 closed <a cluster node>:6443
#
# Every pair is "open|closed host:port". One line per probe with how long the answer took, and a
# non-zero end when a probe is not what was expected. A closed destination is REFUSED, so it
# answers in milliseconds: "closed" after 4000 ms is a silent drop or a dead host, not the guard.
# ⚠ "closed" alone cannot tell a guard from a port nobody listens on: probe a port that answers
# from the host itself, and read the guards' counters (README, "Checks").
set -uo pipefail
bad=0
while [ $# -ge 2 ]; do
  want=$1
  target=$2
  shift 2
  host=${target%:*}
  port=${target##*:}
  t0=$(date +%s%N)
  if timeout 4 bash -c "</dev/tcp/$host/$port" 2>/dev/null; then got=open; else got=closed; fi
  ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  if [ "$got" = "$want" ]; then verdict=ok; else verdict=WRONG; bad=$((bad + 1)); fi
  printf '%-34s %-7s %5s ms  %s\n' "$target" "$got" "$ms" "$verdict"
done
exit $((bad > 0))
