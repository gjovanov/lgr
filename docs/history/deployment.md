# History: Deployment and the cluster

What was built in this area, release by release: how long a deploy takes and why, the image layers, K8s placement.

Moved here whole from `CLAUDE.md` by FR-32.13 (#797), section by section and word for word, so "below" and
"above" in it speak of the file it came from. The traps and the never/always rules of these sections are also in
the rule file [`.claude/rules/deployment.md`](../../.claude/rules/deployment.md), which a session loads when it touches
this area's files. A new trap goes there (or in `CLAUDE.md` if it is not one area's); what was built goes here.

## How long a deploy takes, and why (2026-11-11)

About **a minute** for a commit that changes no dependency, ~30 s more when it changes the UI. The first deploy of a month, a changed dependency (`bun.lock`, or a dependency in a `package.json`) or a new base image rebuilds everything: ~5 min, which is what **every** deploy took until 2026-11-10 (176 deploy logs, 2026-09-26 → 11-10: build ~2 min, push ~1.8 min, rollout ~1 min).

- **The image's layers are ordered by how often they change** (`Dockerfile`: `base` OS packages → `deps` node_modules + Chrome → `web` the built SPA → the repository, last). A deploy rebuilds, pushes and pulls only what its commit touched. Until 2026-11 the repository was copied *before* `bun install` and the OS packages were installed after it, so a one-line fix remade and re-pushed 1.5 GB.
- ⚠ **The `web` stage is given only the packages the SPA is built from** (`web`, `config`, `ui-shared`, `ui-shell`, `*-ui`), so a backend commit reuses the built SPA *and its build id*: no open tab is told to reload for a deploy that changed no UI file (FR-24.14). A UI file importing from another package fails that build; `unit/image-layers.test.ts` says so in CI first.
- ⚠ **The `deps` layer is keyed on each `package.json` without its `exports`** (`scripts/install-manifests.ts`, which the Dockerfile's `src` stage runs on the copies the install is given; the image's own files are the repository's, whole). The install never reads that key, and a new module in `config` or a UI package is a new line in it. Copied whole, such a line made the 1.15 GB layer again: 15 of the 24 merges that changed a manifest from 2026-10-28 to 2026-11-11, and 256 s instead of ~40 s for two such lines on 2026-11-11. A key goes on that script's list only with proof that the install does not read it (`unit/install-manifests.test.ts`).
- **Every deploy log ends with `DEPLOY_TIMING`** (per phase, and `layers: os=… deps=… web=…`). ⚠ A `deps=rebuilt` or `os=rebuilt` that no lockfile change or new month explains means the build cache was lost: every deploy is back to five minutes until someone reads that line.
- The OS packages are not pinned, so `deploy-prod.sh` passes the month (`OS_REFRESH`) and they are reinstalled once a month.

## K8s deployment placement

Cluster has three zones via `topology.kubernetes.io/zone`: `mars`,
`zeus`, `jupiter` (one master + one worker VM per bare-metal host).
Apps are split by tier (added 2026-05-01 after a mars-host overload
incident):

  - `tier=high-performance` (zeus + jupiter workers): this app, plus
    roomler / roomler-ai / oxmux / lgr / purestat / tickytack / clawui
    (when migrated to K8s).
  - `tier=utility` (mars worker): bauleiter, regal, monitoring stack,
    docker registry, image builds.

Enforced via a Kustomize patch in `lgr-deploy/k8s/overlays/prod/
kustomization.yaml` that puts a required `nodeAffinity` on every
Deployment + StatefulSet. Hostname pins in `base/` are retained where
the StatefulSet PVC uses node-local storage; the tier requirement is
an *additional* constraint — both must match.
