#!/bin/bash
# seed.sh — runs ON the build host (temp-admin.sh copies it to /tmp and removes it): creates jamesbond-$TAG as admin in
# each org of $ORGS with the checkout's own scripts/seed-user.ts, over a private port-forward to the production Mongo.
# Dry run unless EXECUTE=--execute. The password comes from /tmp/jb-$TAG-pw, which this script deletes when it ends.
set -euo pipefail
: "${TAG:?}" "${ORGS:?}"
PORT=${PORT:-27124}
CHECKOUT=${CHECKOUT:-$HOME/lgr}
export PATH="$HOME/.bun/bin:$PATH"
cd "$CHECKOUT"
if ss -ltn | grep -q ":$PORT "; then echo "$PORT busy"; exit 2; fi
timeout 900 kubectl -n lgr port-forward svc/mongodb "$PORT":27017 >"/tmp/jb-$TAG-pf.log" 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true; rm -f "/tmp/jb-$TAG-pw"' EXIT
for _ in $(seq 1 20); do ss -ltn | grep -q ":$PORT " && break; sleep 1; done
sec() { kubectl -n lgr get secret mongodb-secret -o jsonpath="{.data.$1}" | base64 -d; }
UE=$(V="$(sec MONGO_INITDB_ROOT_USERNAME)" bun -e 'console.log(encodeURIComponent(process.env.V))')
PE=$(V="$(sec MONGO_INITDB_ROOT_PASSWORD)" bun -e 'console.log(encodeURIComponent(process.env.V))')
DB=$(sec MONGO_INITDB_DATABASE)
export MONGODB_URI="mongodb://$UE:$PE@127.0.0.1:$PORT/$DB?authSource=admin&directConnection=true"
# A password file written on Windows may end in CR LF: seed-user would store the CR, and every sign-in would fail.
PW=$(tr -d '\r\n' < "/tmp/jb-$TAG-pw")
for ORG in $ORGS; do
  echo "=== $ORG"
  bun scripts/seed-user.ts --org "$ORG" --email "jamesbond-$TAG@lgr.internal" --username "jamesbond-$TAG" --password "$PW" --first James --last Bond --role admin ${EXECUTE:-} 2>&1 | grep -v -i password
done
