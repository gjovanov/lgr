# The stages are ordered by how often their inputs change, slowest first, so a deploy rebuilds,
# pushes and pulls only what its commit touched:
#
#   base     the pinned Bun image + the OS libraries Chrome needs     the base digest, the list, or the month
#   deps     node_modules + puppeteer's Chrome (1.15 GB)              a package.json or bun.lock
#   web      the built SPA (8 MB)                                     a UI package or `config`
#   runtime  the repository (25 MB), last                             every commit
#
# ⚠ Until 2026-11 the whole repository was copied BEFORE `bun install`, and the OS libraries were
# installed after it. So every commit, a one-line fix included, re-ran the install (~35 s), the
# apt step (~75–110 s) and the SPA build (~32 s), made 1.5 GB of layers whose content had not
# changed, pushed them (~100 s) and had the node pull them: 2 min of build and 1.8 min of push in
# a 4.9 min deploy on 2026-11-10, and the 176 deploy logs the build host keeps show the same shape
# back to 2026-09-26. `scripts/deploy-prod.sh` prints where a deploy's time went (`DEPLOY_TIMING`),
# and unit/image-layers.test.ts keeps this order.
#
# The cache keys are content, not time: BuildKit hashes what a COPY selects (mode, owner, size and
# bytes; not mtime), so `src` below can be rebuilt on every commit and the stages that copy a part
# of it are still reused when that part did not change.

# ── Base: the runtime's OS ──
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS base
# Puppeteer's Chrome goes where the non-root runtime user can read it. Its default, ~/.cache, is
# /root/.cache here: mode 700, so the app could not start a browser once it stopped being root.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Puppeteer/Chromium system libs — required by md-to-pdf for PDF export.
# The bun:slim image omits these, which causes libglib-2.0.so.0 not found.
# ⚠ This layer is reused until the base digest, this list or OS_REFRESH changes. The packages are
# not pinned, so the deploy script passes the month: the first deploy of a month reinstalls them
# (and everything above them, one slow deploy), and every other deploy of that month ships the
# same bytes. Without the argument the layer simply stays as it was first built.
ARG OS_REFRESH=unset
RUN echo "OS packages as of ${OS_REFRESH}" \
  && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libc6 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 wget xdg-utils \
    tini \
  && rm -rf /var/lib/apt/lists/*

# ── The repository, cut into the two parts the cached stages read ──
# This stage runs on every commit and is cheap (a copy and two `cp`). Nothing ships from it.
#   /manifests  every package.json and the lockfile: all `bun install` reads
#   /ui         what the SPA is built from. The module graph of `packages/web` is `web`, `config`,
#               `ui-shared`, `ui-shell` and the `*-ui` packages (measured 2026-11-10: 665 modules,
#               none anywhere else), and unit/image-layers.test.ts fails when a UI file starts
#               importing from outside them. Such a build would fail here, loudly, never go stale:
#               the other packages exist in the `web` stage as a package.json and nothing else.
FROM base AS src
COPY . /src
RUN cd /src \
  && mkdir -p /manifests /ui/scripts \
  && cp --parents package.json bun.lock packages/*/package.json /manifests/ \
  && cp -a --parents packages/web packages/config packages/ui-* packages/*-ui /ui/ \
  && cp -a scripts/check-web-bundle.ts /ui/scripts/

# ── Dependencies ──
FROM base AS deps
WORKDIR /app
COPY --from=src /manifests/ /app/
RUN bun install --frozen-lockfile

# ── Build the web app (FR-24.21: one SPA; FR-24.15 keeps it within its budget) ──
# ⚠ Reused whole when no UI input changed, and its build id with it (`<meta name="lgr-build">`,
# which the server sends back as `x-lgr-build`): a deploy that changed no UI file tells no open
# tab that there is a new version to load (FR-24.14), because there is none.
FROM deps AS web
COPY --from=src /ui/ /app/
RUN cd /app/packages/web && bun run build && cd /app && bun scripts/check-web-bundle.ts

# ── Runtime: single unified process ──
FROM deps AS runtime
COPY --from=web /app/packages/web/dist /app/packages/web/dist
# Last, because it changes with every commit: nothing below this line is more than metadata.
COPY . /app

ENV HOST=0.0.0.0
EXPOSE 4001

WORKDIR /app/packages/portal-api
# Not root (S-10). The app runs as the base image's own `bun` user (uid 1000), which owns nothing
# under /app, so the code cannot be rewritten by the process that serves it (what made S-27 a
# write into the whole container). It writes to /app/uploads (the volume, owned by uid 1000), /tmp
# and its home, and the Deployment mounts the root filesystem read-only.
USER bun
# tini is PID 1 to REAP. Every PDF launches a Chrome whose helpers (zygote, renderer, crashpad)
# are orphaned to PID 1 when the browser exits, and `bun run` as PID 1 never waits for them: on
# 2026-10-23 the pod held 54 zombies after nine renders, six per render, cleared only by the next
# restart (same image on mars: 30 after five renders without tini, 0 with it).
# ⚠ No `-g`: tini forwards SIGTERM to `bun run`, which already forwards it to the server once
# (measured). Signalling the whole group would deliver it to the server twice, and its shutdown
# hook (unified.ts, fiscal devices) is async.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "start"]
