#!/usr/bin/env bash
# Keep only the 2 most-recent versioned tags of registry.roomler.ai/lgr (the current
# deployed tag + one prior for rollback) and delete every other build/version tag.
# Also untags `latest` if older than the most-recent versioned tag (it'll be re-tagged
# on next push).
#
# Run before each `docker push` to prevent the build host from filling its disk —
# images are ~7.5GB each and accumulate quickly during rapid iteration.
#
# Usage:
#   ./scripts/prune-docker-tags.sh           # dry-run
#   ./scripts/prune-docker-tags.sh --apply   # actually untag

set -euo pipefail

REPO="registry.roomler.ai/lgr"
KEEP=2
APPLY="${1:-}"

# List versioned tags (v20260428-..., build-..., p2-p3, final, etc.) sorted by created-at desc.
# The CLI returns "<tag>\t<created>"; we sort by the timestamp column reverse-numerically.
mapfile -t TAGS < <(
  docker images "$REPO" --format '{{.Tag}}\t{{.CreatedAt}}' \
    | grep -v -E '^latest\b' \
    | sort -k2 -r -t$'\t' \
    | cut -f1
)

if [[ ${#TAGS[@]} -le $KEEP ]]; then
  echo "[prune-docker-tags] ${#TAGS[@]} tag(s) — nothing to prune (keep=$KEEP)"
  exit 0
fi

KEEP_LIST=("${TAGS[@]:0:$KEEP}")
DROP_LIST=("${TAGS[@]:$KEEP}")

echo "[prune-docker-tags] Keeping (${#KEEP_LIST[@]}):"
for t in "${KEEP_LIST[@]}"; do echo "  - $REPO:$t"; done
echo "[prune-docker-tags] Dropping (${#DROP_LIST[@]}):"
for t in "${DROP_LIST[@]}"; do echo "  - $REPO:$t"; done

if [[ "$APPLY" != "--apply" ]]; then
  echo
  echo "DRY-RUN — re-run with --apply to untag."
  exit 0
fi

for t in "${DROP_LIST[@]}"; do
  docker rmi "$REPO:$t" 2>&1 | tail -1
done

# Final cleanup: dangling layers + build cache.
docker image prune -f >/dev/null
docker builder prune -af >/dev/null

echo "[prune-docker-tags] Done."
docker images "$REPO" --format 'table {{.Tag}}\t{{.CreatedAt}}\t{{.Size}}'
