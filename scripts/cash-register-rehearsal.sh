#!/usr/bin/env bash
# FR-21 §8.4 — rehearse a cash-register migration on a copy of prod. Run it on the build host:
#
#   FIELD_FROM=2026-09-26 FIELD_TO=2026-10-25 FIELD_DIGEST_DAY=2026-10-23 \
#     ./scripts/cash-register-rehearsal.sh <branch>      # e.g. feat/fr-21-r2d-doors
#
# Prod is only READ: a mongodump through a port-forward, restored into a throwaway mongod on
# 127.0.0.1:27299. Then, on the copy:
#   1. the field check (scripts/cash-register-field-check.ts) with the deployed code in ~/lgr — the
#      baseline;
#   2. with <branch>'s code: the preflight, `bun run migrate` twice (it must apply, then do nothing),
#      and the parity check;
#   3. the field check with <branch>'s code, then with the deployed code again. That last run is an
#      image rollback reading the migrated data.
# The dump, the throwaway and the branch's worktree are removed at the end. The outputs stay in
# /tmp/cash-register-rehearsal and hold business figures: they stay on this host, never in an issue
# or a PR. Credentials are read from the cluster's secret and never printed. The mongo tools run as
# this user, so the dump is this user's to delete.
set -euo pipefail
BRANCH="${1:?usage: $0 <branch>}"
: "${FIELD_FROM:?set FIELD_FROM=YYYY-MM-DD}" "${FIELD_TO:?set FIELD_TO=YYYY-MM-DD}" "${FIELD_DIGEST_DAY:?set FIELD_DIGEST_DAY=YYYY-MM-DD}"
export FIELD_FROM FIELD_TO FIELD_DIGEST_DAY
export PATH=$HOME/.bun/bin:$PATH
LOG() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }
OUT=/tmp/cash-register-rehearsal
WT=/tmp/lgr-rehearsal-wt
mkdir -p "$OUT"
ME="$(id -u):$(id -g)"

if pgrep -f deploy-prod > /dev/null; then LOG "a deploy is running: not now"; exit 4; fi

# The branch's code, detached, beside the deploy checkout (which stays as it is).
git -C ~/lgr fetch -q origin "$BRANCH"
SHA=$(git -C ~/lgr rev-parse FETCH_HEAD)
[ -d "$WT" ] || git -C ~/lgr worktree add -q --detach "$WT" "$SHA"
git -C "$WT" checkout -q --detach "$SHA"
LOG "branch code: $(git -C "$WT" log --oneline -1)"
(cd "$WT" && bun install --frozen-lockfile > /dev/null 2>&1)
LOG "deployed code: $(git -C ~/lgr log --oneline -1)"
(cd ~/lgr && bun install --frozen-lockfile > /dev/null 2>&1)
CHECK="$WT/scripts/cash-register-field-check.ts"
[ -f "$CHECK" ] || { LOG "$BRANCH has no scripts/cash-register-field-check.ts"; exit 2; }

cleanup() {
  kill "${PF:-0}" 2>/dev/null || true
  docker rm -f cash-register-rehearsal > /dev/null 2>&1 || true
  rm -f /tmp/cash-register-rehearsal-*.archive.gz 2>/dev/null || true
  git -C ~/lgr worktree remove --force "$WT" 2>/dev/null || true
}
trap cleanup EXIT

# The throwaway.
docker rm -f cash-register-rehearsal > /dev/null 2>&1 || true
docker run -d --name cash-register-rehearsal -p 127.0.0.1:27299:27017 mongo:7 mongod --replSet rs0 --bind_ip_all > /dev/null
for i in $(seq 1 30); do docker exec cash-register-rehearsal mongosh --quiet --eval 'db.runCommand({ping:1}).ok' > /dev/null 2>&1 && break; sleep 1; done
docker exec cash-register-rehearsal mongosh --quiet --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}).ok" > /dev/null
sleep 5

# Prod → archive → throwaway.
kubectl -n lgr port-forward svc/mongodb 27199:27017 > /tmp/cash-register-rehearsal-pf.log 2>&1 &
PF=$!
for i in $(seq 1 20); do (echo > /dev/tcp/127.0.0.1/27199) 2>/dev/null && break; sleep 1; done
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
ARCH=/tmp/cash-register-rehearsal-$(date -u +%Y%m%dT%H%M%SZ).archive.gz
LOG "dump prod lgr (read-only)"
SECONDS=0
docker run --rm --user "$ME" --network host -v /tmp:/tmp mongo:7 mongodump --quiet \
  --uri "mongodb://$U:$P@127.0.0.1:27199/lgr?authSource=admin&directConnection=true" --archive="$ARCH" --gzip
LOG "dumped in ${SECONDS}s ($(du -h "$ARCH" | cut -f1))"
kill $PF 2>/dev/null || true
SECONDS=0
docker run --rm --user "$ME" --network host -v /tmp:/tmp mongo:7 mongorestore --quiet \
  --uri "mongodb://127.0.0.1:27299/?directConnection=true" --archive="$ARCH" --gzip
rm -f "$ARCH"
LOG "restored in ${SECONDS}s"

export MONGODB_URI="mongodb://127.0.0.1:27299/lgr?replicaSet=rs0&directConnection=true"

LOG "1. field check, deployed code, before"
(cd ~/lgr/packages/portal-api && bun -e "$(cat "$CHECK")" > "$OUT/before-deployed.json")

LOG "2. preflight ($BRANCH)"
(cd "$WT" && bun scripts/cash-register-preflight.ts) > "$OUT/preflight.txt" 2>&1 || LOG "preflight exited $?"
LOG "migrate, first run"
SECONDS=0
(cd "$WT/packages/migrations" && bun run src/cli.ts) > "$OUT/migrate-1.txt" 2>&1 || LOG "migrate 1 exited $?"
LOG "first run took ${SECONDS}s"
SECONDS=0
(cd "$WT/packages/migrations" && bun run src/cli.ts) > "$OUT/migrate-2.txt" 2>&1 || LOG "migrate 2 exited $?"
LOG "second run took ${SECONDS}s"
(cd "$WT/packages/migrations" && bun run src/cli.ts --status) > "$OUT/migrate-status.txt" 2>&1 || true
(cd "$WT" && bun scripts/cash-register-preflight.ts --parity) > "$OUT/parity.txt" 2>&1 || LOG "parity exited $?"

LOG "3. field check, branch code, after"
(cd "$WT/packages/portal-api" && bun -e "$(cat "$CHECK")" > "$OUT/after-branch.json")
LOG "   field check, deployed code, after (the rollback reads the migrated data)"
(cd ~/lgr/packages/portal-api && bun -e "$(cat "$CHECK")" > "$OUT/after-deployed.json")

LOG "done: $(ls "$OUT") — compare with: diff $OUT/before-deployed.json $OUT/after-branch.json"
echo "REHEARSAL_DONE"
