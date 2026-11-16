#!/bin/bash
# remote/tags.sh — runs ON the build host (tags.sh copies it to /tmp and removes it): scripts/assign-din-tags.ts for each
# org of $ORGS, over a private port-forward to the production Mongo. Dry run unless EXECUTE=--execute.
set -euo pipefail
: "${ORGS:?}"
PORT=${PORT:-27124}
CHECKOUT=${CHECKOUT:-$HOME/lgr}
export PATH="$HOME/.bun/bin:$PATH"
cd "$CHECKOUT"
if ss -ltn | grep -q ":$PORT "; then echo "$PORT busy"; exit 2; fi
log=$(mktemp /tmp/jb-tags-XXXXXX)
timeout 900 kubectl -n lgr port-forward svc/mongodb "$PORT":27017 >"$log.pf" 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true; rm -f "$log" "$log.pf"' EXIT
for _ in $(seq 1 20); do ss -ltn | grep -q ":$PORT " && break; sleep 1; done
sec() { kubectl -n lgr get secret mongodb-secret -o jsonpath="{.data.$1}" | base64 -d; }
UE=$(V="$(sec MONGO_INITDB_ROOT_USERNAME)" bun -e 'console.log(encodeURIComponent(process.env.V))')
PE=$(V="$(sec MONGO_INITDB_ROOT_PASSWORD)" bun -e 'console.log(encodeURIComponent(process.env.V))')
DB=$(sec MONGO_INITDB_DATABASE)
export MONGODB_URI="mongodb://$UE:$PE@127.0.0.1:$PORT/$DB?authSource=admin&directConnection=true"
for ORG in $ORGS; do
  echo "=== $ORG"
  bun run scripts/assign-din-tags.ts --org "$ORG" ${EXECUTE:-} >"$log" 2>&1 || echo "assign-din-tags exited $?"
  grep -E "needing|ecategor|vocabulary|bulkWrite|rror" "$log" | head -12
done
