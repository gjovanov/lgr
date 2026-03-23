# ── Base: install dependencies ──
FROM oven/bun:1.3.10-slim AS base
COPY . /app
WORKDIR /app
RUN bun install

# ── Build all 4 UIs ──
FROM base AS ui-builder
RUN cd /app/packages/portal-ui && bun run build
RUN cd /app/packages/accounting-ui && bun run build
RUN cd /app/packages/trade-ui && bun run build
RUN cd /app/packages/payroll-ui && bun run build

# ── Runtime: single unified process ──
FROM base AS runtime

COPY --from=ui-builder /app/packages/portal-ui/dist /app/packages/portal-ui/dist
COPY --from=ui-builder /app/packages/accounting-ui/dist /app/packages/accounting-ui/dist
COPY --from=ui-builder /app/packages/trade-ui/dist /app/packages/trade-ui/dist
COPY --from=ui-builder /app/packages/payroll-ui/dist /app/packages/payroll-ui/dist

ENV HOST=0.0.0.0
EXPOSE 4001

WORKDIR /app/packages/portal-api
CMD ["bun", "run", "start:unified"]
