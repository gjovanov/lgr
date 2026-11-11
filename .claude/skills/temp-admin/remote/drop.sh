#!/bin/bash
# drop.sh — runs ON the build host (temp-admin.sh copies it to /tmp and removes it): deletes the account $EMAIL in every
# org, and its Identity, over a private port-forward to the production Mongo. Prints what was deleted and what is left.
set -euo pipefail
: "${TAG:?}" "${EMAIL:?}"
PORT=${PORT:-27124}
CHECKOUT=${CHECKOUT:-$HOME/lgr}
export PATH="$HOME/.bun/bin:$PATH"
if ss -ltn | grep -q ":$PORT "; then echo "$PORT busy"; exit 2; fi
timeout 300 kubectl -n lgr port-forward svc/mongodb "$PORT":27017 >"/tmp/jb-$TAG-pf.log" 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do ss -ltn | grep -q ":$PORT " && break; sleep 1; done
sec() { kubectl -n lgr get secret mongodb-secret -o jsonpath="{.data.$1}" | base64 -d; }
UE=$(V="$(sec MONGO_INITDB_ROOT_USERNAME)" bun -e 'console.log(encodeURIComponent(process.env.V))')
PE=$(V="$(sec MONGO_INITDB_ROOT_PASSWORD)" bun -e 'console.log(encodeURIComponent(process.env.V))')
DB=$(sec MONGO_INITDB_DATABASE)
export MONGODB_URI="mongodb://$UE:$PE@127.0.0.1:$PORT/$DB?authSource=admin&directConnection=true"
# Run from the db package so `mongoose` resolves; the script itself lives in /tmp.
cd "$CHECKOUT/packages/db" && bun "/tmp/jb-$TAG-drop.ts"
