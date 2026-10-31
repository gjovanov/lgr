# ── Base: install dependencies ──
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS base
# Puppeteer's Chrome goes where the non-root runtime user can read it. Its default, ~/.cache, is
# /root/.cache here: mode 700, so the app could not start a browser once it stopped being root.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
COPY . /app
WORKDIR /app
RUN bun install --frozen-lockfile

# ── Build all UIs ──
FROM base AS ui-builder
RUN cd /app/packages/portal-ui && bun run build
RUN cd /app/packages/accounting-ui && bun run build
RUN cd /app/packages/inventory-ui && bun run build
RUN cd /app/packages/invoicing-ui && bun run build
RUN cd /app/packages/payroll-ui && bun run build
RUN cd /app/packages/reports-ui && bun run build
RUN cd /app/packages/files-ui && bun run build
# FR-24.13: the one SPA, beside the eight until Phase 3; FR-24.15 keeps it within its budget.
RUN cd /app/packages/web && bun run build && cd /app && bun scripts/check-web-bundle.ts

# ── Runtime: single unified process ──
FROM base AS runtime

# Puppeteer/Chromium system libs — required by md-to-pdf for PDF export.
# The bun:slim image omits these, which causes libglib-2.0.so.0 not found.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libc6 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 wget xdg-utils \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ui-builder /app/packages/portal-ui/dist /app/packages/portal-ui/dist
COPY --from=ui-builder /app/packages/accounting-ui/dist /app/packages/accounting-ui/dist
COPY --from=ui-builder /app/packages/inventory-ui/dist /app/packages/inventory-ui/dist
COPY --from=ui-builder /app/packages/invoicing-ui/dist /app/packages/invoicing-ui/dist
COPY --from=ui-builder /app/packages/payroll-ui/dist /app/packages/payroll-ui/dist
COPY --from=ui-builder /app/packages/reports-ui/dist /app/packages/reports-ui/dist
COPY --from=ui-builder /app/packages/files-ui/dist /app/packages/files-ui/dist
COPY --from=ui-builder /app/packages/web/dist /app/packages/web/dist

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
