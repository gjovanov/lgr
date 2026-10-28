---
name: deploy-prod
description: Ship LGR to the production Kubernetes cluster — build the Docker image on the master-node build host, push it to registry.roomler.ai, bump the image tag in the separate lgr-deploy GitOps repo, and let ArgoCD roll it out. Use when the user wants to deploy/ship/release master to prod, rebuild the OCR sidecar, roll back to a previous image tag, or diagnose a rollout that is stuck or serving old code.
allowed-tools: Bash(ssh:*), Bash(scp:*), Bash(git:*), Bash(kubectl:*), Bash(docker:*)
---

# Deploy LGR to production

## Topology (verified 2026-08-05)

```
Windows dev box            master-node  (ssh alias `mars`)                cluster
──────────────────         ─────────────────────────────────────          ────────────────────
git push master  ─────►  ~/lgr            (source; docker build here)
                              │ docker push
                              ▼
                         registry.roomler.ai/lgr:<tag>        (self-hosted registry v2)
                         registry.roomler.ai/lgr-ocr:<tag>    (OCR sidecar, own Deployment)
                              │
                         ~/lgr-deploy     (GitOps: k8s/overlays/prod/kustomization.yaml)
                              │ git push origin master
                              ▼
                         ArgoCD app `lgr` ──auto-sync──►  ns lgr: deploy/lgr, deploy/lgr-ocr,
                         (automated, prune, selfHeal,                    sts/mongodb
                          60s reconcile, ServerSideApply)
```

- **Everything runs on one host.** `mars`, `zeus`, `jupiter`, `lgr`, `lgr-deploy`, `deploy` are
  tmux *session names* that all terminate on **master-node** — not distinct hosts. Docker,
  kubectl, and both checkouts live there. (tmux is often not running; plain SSH is fine.)
- **Non-interactive SSH**: the `mars` entry in `~/.ssh/config` uses a passphrase-protected
  putty key → headless ssh hangs. Always:
  `ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 mars`
- **Two images, two tags.** `kustomization.yaml` has an `images:` list with `- name: lgr`
  (app) and `- name: registry.roomler.ai/lgr-ocr` (sidecar). They are bumped independently.
- **The GitOps repo is the only deploy path.** ArgoCD runs with `selfHeal: true` — a
  `kubectl set image` / `kubectl edit deploy` is reverted within ~60s. Bump the tag in git.
- Service is NodePort `30040`; there is no Ingress. Smoke test hits `http://<nodeIP>:30040/`.

## Preflight gates

| Change | Gate | Where |
|---|---|---|
| Backend (models/services/controllers) | `bun run test` — ~780 tests, ~12 min | **on the host**, not Windows |
| Frontend (views/stores/composables) | `bun run build` | either box |
| Full flow | `bun run test:e2e` | either box |

Run the test suite on master-node — the Windows box hits the Bun async-matcher deadlock
(see Known Issues in CLAUDE.md), so red runs there are usually not real:

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 mars \
  'cd ~/lgr && PATH=$HOME/.bun/bin:$PATH bun run test'
```

The Docker build compiles all 6 UIs, so a broken UI build fails the deploy — but ~20 minutes
in. Run `bun run build` locally first.

## Deploy (happy path)

`scripts/deploy-prod.sh` does the whole pipeline: pull → prune → build → tag → push →
targeted kustomization bump → commit/push → ArgoCD nudge → rollout wait → smoke check.
It prints `DEPLOY_DONE <sha> <tag>` or `DEPLOY_FAILED <sha>`.

A cold build is **15–30 min** (over the Bash tool's 10-min cap), so background it and poll a
per-run log file — never the tmux scrollback, where a stale marker from an earlier build
reads as a false success.

```bash
# 0. push the code first — the host deploys what's on origin/master
git push origin master
SHA=$(git rev-parse --short HEAD)

# 1. launch, detached
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 mars \
  "nohup bash -c 'cd ~/lgr && git pull --ff-only origin master && ./scripts/deploy-prod.sh' \
   > /tmp/deploy-$SHA.log 2>&1 < /dev/null &"

# 2. poll in ≤9-min chunks (repeat until the marker appears)
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 mars \
  "timeout 500 bash -c 'until grep -qE \"DEPLOY_(DONE|FAILED) $SHA\" /tmp/deploy-$SHA.log; \
   do sleep 20; done'; tail -30 /tmp/deploy-$SHA.log"
```

Interactive equivalent (when you're already on the host): `cd ~/lgr && ./scripts/deploy-prod.sh`.

### Flags

```
./scripts/deploy-prod.sh                       # app image (the common case)
./scripts/deploy-prod.sh --ocr                 # app + OCR sidecar
./scripts/deploy-prod.sh --ocr-only            # sidecar only
./scripts/deploy-prod.sh --tag v20260727-...   # no build: redeploy / roll back to an existing tag
./scripts/deploy-prod.sh --ocr-tag v20260726-...
./scripts/deploy-prod.sh --build-only          # build+push, no gitops bump
./scripts/deploy-prod.sh --no-pull             # deploy the host checkout as-is
./scripts/deploy-prod.sh --dry-run             # print every mutating step, run none
```

Rebuild the sidecar (`--ocr`) only when `packages/ocr-server/` or `Dockerfile.ocr` changed;
it is otherwise stable across app deploys.

## Manual pipeline (if the script is unavailable or a step failed)

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 mars
cd ~/lgr && git pull --ff-only origin master

./scripts/prune-docker-tags.sh --apply                     # BEFORE building (disk safety)
docker build -t registry.roomler.ai/lgr:build-tmp .
TAG="v$(date +%Y%m%d)-$(docker images -q registry.roomler.ai/lgr:build-tmp | head -c 12)"
docker tag registry.roomler.ai/lgr:build-tmp registry.roomler.ai/lgr:$TAG
docker tag registry.roomler.ai/lgr:build-tmp registry.roomler.ai/lgr:latest
docker rmi registry.roomler.ai/lgr:build-tmp
docker push registry.roomler.ai/lgr:$TAG && docker push registry.roomler.ai/lgr:latest

cd ~/lgr-deploy && git pull --ff-only origin master
# TARGETED sed on the literal OLD app tag — see the clobber gotcha below
sed -i "s|newTag: <oldAppTagLiteral>|newTag: $TAG|" k8s/overlays/prod/kustomization.yaml
grep -E 'newTag: v[0-9]{8}-[0-9a-f]{12}$' k8s/overlays/prod/kustomization.yaml   # must print BOTH lines
git commit -am "chore(k8s): bump lgr to $TAG" && git push origin master

kubectl -n argocd patch application lgr --type merge --patch '{"operation":{"sync":{}}}'
until kubectl -n lgr get deploy lgr -o jsonpath='{..image}' | grep -q "$TAG"; do sleep 5; done
kubectl -n lgr rollout status deploy/lgr
```

## Roll back

```bash
git -C ~/lgr-deploy log --oneline -8 -- k8s/overlays/prod/kustomization.yaml   # previous tags
./scripts/deploy-prod.sh --tag v20260727-5a653b935392
```

⚠ **An old tag in that history is usually gone from the registry.** A weekly cron on the build
host (`~/.local/bin/registry-retention.sh 1`, Sundays 04:00) keeps only `latest`, the single
newest tag per repo, and whatever the cluster is currently running — so after a Sunday the
previous release is deleted. `--tag` does not check, and rolling back to a deleted tag leaves
the new pod in `ImagePullBackOff` (the old pod keeps serving, so it reads as a stuck rollout).
Check first — `200` means redeployable:

```bash
PW=$(sudo cat /gjovanov/registry/auth/.password.gjovanov)
curl -s -o /dev/null -w '%{http_code}\n' -I -u "gjovanov:$PW" \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  http://127.0.0.1:5000/v2/lgr/manifests/v20260727-5a653b935392
```

A deleted tag's layers stay on disk until the script's garbage-collect runs; while they do, the
exact image can be restored by re-pushing its manifest from a node that still has it cached
(`sudo ctr -n k8s.io content get <manifest digest>` on the worker → `PUT /v2/lgr/manifests/<tag>`;
how `lgr-qa` was restored on 2026-09-25). Otherwise rebuild. Reverting the commit in
`lgr-deploy` works as well as `--tag` — auto-sync picks it up either way — with the same caveat.

## Verify

```bash
kubectl -n lgr get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image
kubectl -n lgr get pods -o wide
kubectl -n argocd get application lgr -o jsonpath='{.status.sync.status}/{.status.health.status}{"\n"}'   # want Synced/Healthy
NODE=$(kubectl -n lgr get pod -l app=lgr -o jsonpath='{.items[0].status.hostIP}')
curl -s -o /dev/null -w '%{http_code}\n' http://$NODE:30040/
```

First request after a pod restart pays ~6s cold start (Bun JIT + Mongoose compile); ~70ms after.

## Gotchas

- **Blanket `sed s|newTag:.*|...|` breaks the OCR sidecar** — it rewrites BOTH image entries
  → `lgr-ocr` ImagePullBackOff. Worse, computing the old tag with `grep -A1 "name: lgr$"`
  returns empty (the block is 3 lines), and sed with an empty search string *prepends* the new
  tag to both lines → concatenated garbage tags and a rollout that times out (hit 2026-07-26).
  `deploy-prod.sh` edits the `newTag` inside the matching `- name:` block only, refuses unless
  exactly one line matched, and reverts + aborts if any `newTag` fails the `v<8 digits>-<12 hex>`
  shape before anything is pushed.
- **ArgoCD selfHeal reverts manual cluster edits** within ~60s. Git is the only deploy path.
- **Never re-push an existing tag with new content** — `imagePullPolicy: IfNotPresent` means
  nodes keep the cached layer and you deploy stale code. Every build gets a fresh tag.
- **The argocd CLI token on the host is expired** (`invalid session: Token is expired`), so
  `argocd app sync lgr` fails. Use the `kubectl -n argocd patch application` form, or re-login.
  Auto-sync reconciles within 60s anyway — the patch only skips the wait.
- **Prune before building, always.** The image is ~7.5 GB; builds once filled the disk mid-push
  and left a partial image in the registry. `prune-docker-tags.sh --apply` keeps the 2 newest
  local tags and clears the builder cache — which also means most builds are effectively cold.
  As of 2026-08-05 the host has **no local lgr images at all** (65% of 437 G used), so the next
  build has zero cache.
- **Uncommitted tracked changes in `~/lgr` abort the script** (untracked files are ignored) —
  the host checkout picks up leftovers like `invoice-lines-backup-*.json` harmlessly.
- **CLAUDE.md's "Sync policy is Manual" is outdated** — the live app is `automated` with
  `prune` + `selfHeal` on branch `master`, path `k8s/overlays/prod`.
- Cluster DNS is intermittently flaky (see Known Issues) → an ArgoCD sync can fail with
  `ComparisonError ... server misbehaving` on github.com and succeed on retry. If it stays
  stuck: `kubectl apply -k k8s/overlays/prod` from `~/lgr-deploy` converges live state with git.

## Querying the prod DB after a deploy

Env var is `MONGODB_URI`; `mongoose` resolves only from `/app/packages/db`. Pipe a JS file via
stdin to dodge `$`-escaping:

```bash
cat /tmp/q.js | kubectl -n lgr exec -i deploy/lgr -- sh -c 'cd /app/packages/db && bun -'
```

For scripts in `~/lgr` (seed/import/compare skills), port-forward instead:

```bash
kubectl -n lgr port-forward svc/mongodb 27017:27017 &
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
export MONGODB_URI="mongodb://$U:$P@localhost:27017/lgr?authSource=admin&directConnection=true"
```
