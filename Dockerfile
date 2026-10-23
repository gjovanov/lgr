# ── Base: install dependencies ──
FROM oven/bun:1.3.10-slim AS base
COPY . /app
WORKDIR /app
RUN bun install

# ── Build all UIs ──
FROM base AS ui-builder
RUN cd /app/packages/portal-ui && bun run build
RUN cd /app/packages/accounting-ui && bun run build
RUN cd /app/packages/inventory-ui && bun run build
RUN cd /app/packages/invoicing-ui && bun run build
RUN cd /app/packages/pos-ui && bun run build
RUN cd /app/packages/payroll-ui && bun run build
RUN cd /app/packages/reports-ui && bun run build
RUN cd /app/packages/files-ui && bun run build

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
COPY --from=ui-builder /app/packages/pos-ui/dist /app/packages/pos-ui/dist
COPY --from=ui-builder /app/packages/payroll-ui/dist /app/packages/payroll-ui/dist
COPY --from=ui-builder /app/packages/reports-ui/dist /app/packages/reports-ui/dist
COPY --from=ui-builder /app/packages/files-ui/dist /app/packages/files-ui/dist

ENV HOST=0.0.0.0
EXPOSE 4001

WORKDIR /app/packages/portal-api
# tini is PID 1 to REAP. Every PDF launches a Chrome whose helpers (zygote, renderer, crashpad)
# are orphaned to PID 1 when the browser exits, and `bun run` as PID 1 never waits for them: on
# 2026-10-23 the pod held 54 zombies after nine renders, six per render, cleared only by the next
# restart (same image on mars: 30 after five renders without tini, 0 with it).
# ⚠ No `-g`: tini forwards SIGTERM to `bun run`, which already forwards it to the server once
# (measured). Signalling the whole group would deliver it to the server twice, and its shutdown
# hook (unified.ts, fiscal devices) is async.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "start"]
