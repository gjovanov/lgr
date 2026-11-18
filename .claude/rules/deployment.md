---
paths:
  - "Dockerfile*"
  - "deploy/**"
  - "scripts/deploy-prod.sh"
  - "scripts/prune-docker-tags.sh"
  - "scripts/install-manifests.ts"
  - ".github/workflows/**"
  - ".claude/skills/deploy-prod/**"
---

# Rules and traps: Deployment and the cluster

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/deployment.md`](../../docs/history/deployment.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## How long a deploy takes, and why (2026-11-11)

- ⚠ **The `web` stage is given only the packages the SPA is built from** (`web`, `config`, `ui-shared`, `ui-shell`, `*-ui`), so a backend commit reuses the built SPA *and its build id*: no open tab is told to reload for a deploy that changed no UI file (FR-24.14). A UI file importing from another package fails that build; `unit/image-layers.test.ts` says so in CI first.

- ⚠ **The `deps` layer is keyed on each `package.json` without its `exports`** (`scripts/install-manifests.ts`, which the Dockerfile's `src` stage runs on the copies the install is given; the image's own files are the repository's, whole). The install never reads that key, and a new module in `config` or a UI package is a new line in it. Copied whole, such a line made the 1.15 GB layer again: 15 of the 24 merges that changed a manifest from 2026-10-28 to 2026-11-11, and 256 s instead of ~40 s for two such lines on 2026-11-11. A key goes on that script's list only with proof that the install does not read it (`unit/install-manifests.test.ts`).

- **Every deploy log ends with `DEPLOY_TIMING`** (per phase, and `layers: os=… deps=… web=…`). ⚠ A `deps=rebuilt` or `os=rebuilt` that no lockfile change or new month explains means the build cache was lost: every deploy is back to five minutes until someone reads that line.
