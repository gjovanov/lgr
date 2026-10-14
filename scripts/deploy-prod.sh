#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-prod.sh — build → push → GitOps bump → ArgoCD rollout for LGR prod.
#
# MUST run on the build host (`master-node`, reachable as `mars`): docker,
# kubectl and BOTH git checkouts live there.
#
#   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 mars
#   cd ~/lgr && git pull --ff-only && ./scripts/deploy-prod.sh
#
# Pipeline:
#   ~/lgr (source)  --docker build-->  registry.roomler.ai/lgr:<tag>
#                                          |
#   ~/lgr-deploy (gitops) k8s/overlays/prod/kustomization.yaml  <-- newTag bump
#                                          |  git push origin master
#                                   ArgoCD (auto-sync, selfHeal, 60s reconcile)
#                                          |
#                                   namespace lgr: deploy/lgr, deploy/lgr-ocr
#
# Usage:
#   ./scripts/deploy-prod.sh                     # app image only (the common case)
#   ./scripts/deploy-prod.sh --ocr               # app + OCR sidecar image
#   ./scripts/deploy-prod.sh --ocr-only          # OCR sidecar only
#   ./scripts/deploy-prod.sh --tag v20260727-ba367670be89   # no build: redeploy/rollback
#   ./scripts/deploy-prod.sh --ocr-tag v20260726-a5beff4da7c0
#   ./scripts/deploy-prod.sh --build-only        # build+push, no gitops bump
#   ./scripts/deploy-prod.sh --dry-run           # print every mutating step, run none
#   ./scripts/deploy-prod.sh --no-pull           # deploy the host checkout as-is
#
# Long runs (a cold build is 15–30 min) must be backgrounded and polled by log
# file, never by tmux scrollback — see .claude/skills/deploy-prod/SKILL.md.
# Prints `DEPLOY_DONE <sha> <tag>` on success, `DEPLOY_FAILED <sha>` on error.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SRC="${LGR_SRC:-$HOME/lgr}"
DEPLOY_REPO="${LGR_DEPLOY:-$HOME/lgr-deploy}"
KUSTOMIZATION="$DEPLOY_REPO/k8s/overlays/prod/kustomization.yaml"
REGISTRY="registry.roomler.ai"
NS="lgr"
APP_IMAGE_NAME="lgr"                          # kustomize `images[].name` for the app
OCR_IMAGE_NAME="$REGISTRY/lgr-ocr"            # kustomize `images[].name` for the sidecar
TAG_RE='v[0-9]{8}-[0-9a-f]{12}'

DO_APP=1 DO_OCR=0 DO_BUILD=1 DO_BUMP=1 DO_PULL=1 DRY=0
APP_TAG="" OCR_TAG="" SHA="unknown"

log()  { printf '\n\033[1;36m[deploy]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[deploy] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [[ $DRY == 1 ]]; then printf '  DRY: %s\n' "$*"; else "$@"; fi; }

trap 'rc=$?; [[ $rc -eq 0 ]] || echo "DEPLOY_FAILED $SHA (exit $rc)"' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ocr)        DO_OCR=1 ;;
    --ocr-only)   DO_OCR=1; DO_APP=0 ;;
    --tag)        APP_TAG="${2:?--tag needs a value}"; DO_BUILD=0; shift ;;
    --ocr-tag)    OCR_TAG="${2:?--ocr-tag needs a value}"; DO_OCR=1; DO_BUILD=0; shift ;;
    --build-only) DO_BUMP=0 ;;
    --no-pull)    DO_PULL=0 ;;
    --dry-run)    DRY=1 ;;
    -h|--help)    sed -n '2,40p' "$0"; exit 0 ;;
    *)            die "unknown flag: $1" ;;
  esac
  shift
done
[[ -n "$OCR_TAG" && -z "$APP_TAG" ]] && DO_APP=0   # --ocr-tag alone = OCR redeploy

# ── preflight ────────────────────────────────────────────────────────────────
for bin in docker kubectl git awk; do command -v "$bin" >/dev/null || die "$bin not found — are you on master-node?"; done
[[ -d "$SRC/.git" ]]         || die "source checkout missing: $SRC"
[[ -f "$KUSTOMIZATION" ]]    || die "gitops checkout missing: $KUSTOMIZATION"
docker info >/dev/null 2>&1  || die "docker daemon unreachable"
kubectl -n "$NS" get deploy "$NS" >/dev/null || die "cannot reach cluster / namespace $NS"

if [[ $DO_PULL == 1 ]]; then
  git -C "$SRC" diff --quiet && git -C "$SRC" diff --cached --quiet \
    || die "$SRC has uncommitted tracked changes — commit/stash first, or pass --no-pull"
  log "Pulling $SRC"
  run git -C "$SRC" pull --ff-only origin master
fi
SHA="$(git -C "$SRC" rev-parse --short HEAD)"
log "Source at $SHA — $(git -C "$SRC" log -1 --pretty=%s)"

df -h "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)" | tail -1

# ── build + push ─────────────────────────────────────────────────────────────
# `prune-docker-tags.sh --apply` keeps only the 2 newest local tags and clears the
# builder cache — run BEFORE building so the push can never hit a full disk.
BUILT_TAG=""
build_and_push() {   # $1 = repo suffix (lgr|lgr-ocr), $2 = dockerfile; sets BUILT_TAG
  local repo="$REGISTRY/$1" dockerfile="$2" tmp="$REGISTRY/$1:build-tmp" id
  log "Building $repo (dockerfile: $dockerfile) — cold builds take 15–30 min"
  run docker build -f "$SRC/$dockerfile" -t "$tmp" "$SRC"
  if [[ $DRY == 1 ]]; then BUILT_TAG="v00000000-000000000000"; return; fi
  id="$(docker images -q "$tmp" | head -c 12)"
  [[ -n "$id" ]] || die "build produced no image id for $tmp"
  BUILT_TAG="v$(date +%Y%m%d)-$id"
  docker tag "$tmp" "$repo:$BUILT_TAG"
  docker tag "$tmp" "$repo:latest"
  docker rmi "$tmp" >/dev/null
  docker push "$repo:$BUILT_TAG"
  docker push "$repo:latest"
}

if [[ $DO_BUILD == 1 ]]; then
  log "Pruning old local image tags (keeps 2 + clears builder cache)"
  run "$SRC/scripts/prune-docker-tags.sh" --apply
  if [[ $DO_APP == 1 ]]; then build_and_push lgr Dockerfile;         APP_TAG="$BUILT_TAG"; fi
  if [[ $DO_OCR == 1 ]]; then build_and_push lgr-ocr Dockerfile.ocr; OCR_TAG="$BUILT_TAG"; fi
fi
[[ $DO_APP == 1 ]] && log "App image tag: $APP_TAG"
[[ $DO_OCR == 1 ]] && log "OCR image tag: $OCR_TAG"

if [[ $DO_BUMP == 0 ]]; then
  log "--build-only: skipping gitops bump"
  echo "DEPLOY_DONE $SHA ${APP_TAG:-$OCR_TAG}"
  exit 0
fi

# ── gitops bump ──────────────────────────────────────────────────────────────
# The overlay lists TWO images (app + OCR sidecar), each with its own newTag.
# A blanket `sed s|newTag:.*|...|` clobbers both → lgr-ocr ImagePullBackOff.
# This edit is entry-scoped: it only rewrites the newTag inside the matching
# `- name:` block and fails loudly if it doesn't hit exactly one line.
bump_image_tag() {   # $1 = kustomize image name, $2 = new tag
  local img="$1" newtag="$2" tmp
  [[ "$newtag" =~ ^$TAG_RE$ ]] || die "refusing to write malformed tag '$newtag'"
  if [[ $DRY == 1 ]]; then printf '  DRY: bump %s -> %s in %s\n' "$img" "$newtag" "$KUSTOMIZATION"; return; fi
  tmp="$(mktemp)"
  awk -v img="$img" -v newtag="$newtag" '
    BEGIN { inblk = 0; hits = 0 }
    {
      line = $0
      if (line ~ /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/) {
        nm = line
        sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", nm)
        sub(/[[:space:]]*$/, "", nm)
        inblk = (nm == img)
      } else if (inblk && line ~ /^[[:space:]]*newTag:[[:space:]]*/) {
        sub(/newTag:.*/, "newTag: " newtag, line)
        inblk = 0; hits++
      }
      print line
    }
    END { if (hits != 1) { printf("newTag lines matched for %s: %d (want 1)\n", img, hits) > "/dev/stderr"; exit 3 } }
  ' "$KUSTOMIZATION" > "$tmp" || { rm -f "$tmp"; die "bump failed for image '$img'"; }
  mv "$tmp" "$KUSTOMIZATION"
}

# FR-13.31 — the overlay also patches `LGR_IMAGE_TAG` into lgr-config, which a restored backup's
# manifest is compared against, and the overlay says it MUST equal the app's newTag. Nothing kept
# it so: it sat at v20260911-… while the image moved on to v20261014-…, so the restore check
# compared against a version that was not running. Rewrites only the `value:` line that follows
# `path: /data/LGR_IMAGE_TAG`, and fails unless exactly one matched.
bump_image_tag_env() {   # $1 = new tag
  local newtag="$1" tmp
  [[ "$newtag" =~ ^$TAG_RE$ ]] || die "refusing to write malformed tag '$newtag'"
  if [[ $DRY == 1 ]]; then printf '  DRY: LGR_IMAGE_TAG -> %s in %s\n' "$newtag" "$KUSTOMIZATION"; return; fi
  tmp="$(mktemp)"
  awk -v newtag="$newtag" '
    BEGIN { armed = 0; hits = 0 }
    {
      line = $0
      if (line ~ /path:[[:space:]]*\/data\/LGR_IMAGE_TAG[[:space:]]*$/) { armed = 1 }
      else if (armed && line ~ /^[[:space:]]*value:[[:space:]]*/) {
        sub(/value:.*/, "value: " newtag, line); armed = 0; hits++
      }
      print line
    }
    END { if (hits != 1) { printf("LGR_IMAGE_TAG value lines matched: %d (want 1)\n", hits) > "/dev/stderr"; exit 3 } }
  ' "$KUSTOMIZATION" > "$tmp" || { rm -f "$tmp"; die "LGR_IMAGE_TAG bump failed"; }
  mv "$tmp" "$KUSTOMIZATION"
}

log "Bumping $KUSTOMIZATION"
run git -C "$DEPLOY_REPO" pull --ff-only origin master
[[ $DO_APP == 1 ]] && bump_image_tag "$APP_IMAGE_NAME" "$APP_TAG"
[[ $DO_APP == 1 ]] && bump_image_tag_env "$APP_TAG"
[[ $DO_OCR == 1 && -n "$OCR_TAG" ]] && bump_image_tag "$OCR_IMAGE_NAME" "$OCR_TAG"

if [[ $DRY == 0 ]]; then
  # Every newTag in the overlay must still look like a real tag (catches the
  # historical "two tags concatenated onto one line" corruption).
  if grep -E '^[[:space:]]*newTag:' "$KUSTOMIZATION" | grep -qvE "^[[:space:]]*newTag: $TAG_RE\$"; then
    git -C "$DEPLOY_REPO" checkout -- "$KUSTOMIZATION"
    die "malformed newTag after bump — reverted, nothing pushed"
  fi
  git -C "$DEPLOY_REPO" --no-pager diff -- "$KUSTOMIZATION"
  if git -C "$DEPLOY_REPO" diff --quiet -- "$KUSTOMIZATION"; then
    warn "kustomization unchanged (already on this tag) — skipping commit"
  else
    git -C "$DEPLOY_REPO" commit -m "chore(k8s): bump lgr to ${APP_TAG:-$OCR_TAG} ($SHA)" -- "$KUSTOMIZATION"
    git -C "$DEPLOY_REPO" push origin master
  fi
fi

# ── sync + rollout ───────────────────────────────────────────────────────────
# ArgoCD auto-syncs (automated + selfHeal, 60s reconcile); the patch just skips
# the wait. The argocd CLI token on the host is expired — kubectl always works.
log "Nudging ArgoCD"
run kubectl -n argocd patch application lgr --type merge \
  --patch '{"operation":{"sync":{"revision":"master"}}}'

wait_rollout() {   # $1 = deployment, $2 = expected tag
  local dep="$1" want="$2" i
  [[ $DRY == 1 ]] && { echo "  DRY: wait for $dep -> $want"; return; }
  log "Waiting for $dep to pick up $want (ArgoCD reconcile ≤60s)"
  for i in $(seq 1 60); do
    kubectl -n "$NS" get deploy "$dep" -o jsonpath='{..image}' | grep -q "$want" && break
    [[ $i == 60 ]] && die "$dep never got tag $want — check: kubectl -n argocd get app lgr"
    sleep 5
  done
  kubectl -n "$NS" rollout status "deploy/$dep" --timeout=300s
}
[[ $DO_APP == 1 ]] && wait_rollout lgr "$APP_TAG"
[[ $DO_OCR == 1 && -n "$OCR_TAG" ]] && wait_rollout lgr-ocr "$OCR_TAG"

# ── verify ───────────────────────────────────────────────────────────────────
if [[ $DRY == 0 ]]; then
  log "Live state"
  kubectl -n "$NS" get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image
  kubectl -n "$NS" get pods -o wide
  NODE_IP="$(kubectl -n "$NS" get pod -l app=lgr -o jsonpath='{.items[0].status.hostIP}')"
  # `/` alone is not enough. From 2026-10-04 every SPA route answered its HTML with status 404
  # (NODE_ENV=production flipped @elysiajs/static's mode; portal-api/src/spa-fallback.ts). A deep
  # link must be the shell with 200, and an unknown API route a 404, never the shell, so a
  # catch-all that swallows /api fails here too.
  smoke() { # <path> <expected HTTP status>
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "http://$NODE_IP:30040$1" || echo 000)"
    log "Smoke http://$NODE_IP:30040$1 → HTTP $code (want $2)"
    [[ "$code" == "$2" ]] || die "smoke check failed: $1 answered HTTP $code, expected $2"
  }
  smoke / 200   # first hit after a restart pays ~6s cold start (Bun JIT + Mongoose compile)
  smoke /app-hub 200
  smoke /api/__smoke_unknown_route__ 404
fi

echo "DEPLOY_DONE $SHA ${APP_TAG:-$OCR_TAG}"
