# Deploying the OCR document-import feature

Two images to build/push (app + ocr) and one new service (`lgr-ocr`) with a secret.

## What the sidecar exposes

| Route | Body | Notes |
|---|---|---|
| `GET /health` | — | readiness/liveness probe |
| `POST /extract` | multipart `file` [, `forceOcr`] | `pdftotext -layout -enc UTF-8`, falling back to `tesseract -l bul` at 300 dpi. `forceOcr` skips the native layer — the escape hatch for a scanned PDF whose text layer is junk. |
| `POST /draft` | `{ text[, profile] }` | `profile` ∈ `invoice` \| `goods_receipt` \| `stock_note`; auto-detected from the document header when omitted, and echoed back in the response. |
| `POST /match-lines` | `{ lines, candidates }` | constrained product matching (DIN↔ISO aware) |

**The extraction instructions are skill files baked into the image**
(`packages/ocr-server/.claude/skills/`): `draft-purchase-invoice`, `draft-goods-receipt`
(стокова разписка, incl. the `2000 КОРЕКЦИЯ` signed variant), `draft-stock-note` (складова
разписка + искане). **Editing or adding one requires an image rebuild** —
`./scripts/deploy-prod.sh --ocr` does it, or follow step 2 below.

Timeouts are enforced app-side (`OCR_EXTRACT_TIMEOUT_MS`, default 180s;
`OCR_DRAFT_TIMEOUT_MS`, default 300s), so a wedged sidecar surfaces as a per-file error
instead of a hung request.

## 0. Merge to master
The deploy pipeline builds from `master`. Merge `feat/ocr-bills` first:
```bash
git checkout master && git merge --ff-only feat/ocr-bills && git push origin master
```

## 1. Generate the Max token (once)
On a machine logged into the Claude **Max** plan:
```bash
claude setup-token          # prints a long-lived CLAUDE_CODE_OAUTH_TOKEN
```
(The interactive-login access token in `~/.claude/.credentials.json` works for a
few hours only — fine for local testing, not for the cluster.)

## 2. Build + push both images (on mars)
```bash
cd /home/gjovanov/lgr && git pull
./scripts/prune-docker-tags.sh --apply     # disk hygiene

# app (new backend controller + UI)
TAG="v$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
docker build -t registry.roomler.ai/lgr:$TAG -t registry.roomler.ai/lgr:latest .
docker push registry.roomler.ai/lgr:$TAG && docker push registry.roomler.ai/lgr:latest

# ocr-server
docker build -f Dockerfile.ocr -t registry.roomler.ai/lgr-ocr:$TAG -t registry.roomler.ai/lgr-ocr:latest .
docker push registry.roomler.ai/lgr-ocr:$TAG && docker push registry.roomler.ai/lgr-ocr:latest
```

## 3. Add manifests + secret to lgr-deploy (on mars)
```bash
cd /home/gjovanov/lgr-deploy
cp /home/gjovanov/lgr/deploy/ocr/ocr-deployment.yaml k8s/base/
cp /home/gjovanov/lgr/deploy/ocr/ocr-service.yaml    k8s/base/

# seal the secret (never commit the plain one)
kubectl create secret generic ocr-secret -n lgr \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN="<token from step 1>" \
  --dry-run=client -o yaml \
  | kubeseal --format yaml > k8s/base/sealed/ocr-secret.yaml

# register in kustomization
#   k8s/base/kustomization.yaml  → resources: + ocr-deployment.yaml, ocr-service.yaml, sealed/ocr-secret.yaml
#   k8s/overlays/prod/kustomization.yaml → bump both newTag: $TAG (lgr and lgr-ocr images)
```

## 4. Point the app at the OCR service
Add to the `lgr` app Deployment/ConfigMap env in `lgr-deploy`:
```yaml
- name: OCR_SERVER_URL
  value: "http://lgr-ocr:8100"
```

## 5. Commit + sync
```bash
git add -A && git commit -m "feat(ocr): lgr-ocr deployment + secret + app OCR_SERVER_URL" && git push
kubectl -n argocd patch application lgr --type merge --patch '{"operation":{"sync":{}}}'
# or: argocd app sync lgr --grpc-web
```

## 6. Verify
```bash
kubectl -n lgr rollout status deploy/lgr-ocr
kubectl -n lgr exec deploy/lgr-ocr -- sh -c 'tesseract --list-langs | grep bul; claude --version'
# app UI: /invoicing/bills/import — upload a PDF, extract, draft, convert.
```

Notes:
- `lgr-ocr` runs as non-root `bun` (Claude Code refuses `--dangerously-skip-permissions` as root).
- Rotate `CLAUDE_CODE_OAUTH_TOKEN` by re-running `claude setup-token` + re-sealing.
- Max-as-server-backend is a gray area in Anthropic's usage policy; the `ANTHROPIC_API_KEY`
  fallback is the officially supported path if you'd rather meter it.
