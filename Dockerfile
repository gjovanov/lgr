# ── Base: install dependencies ──
FROM oven/bun:canary-slim AS base
COPY . /app
WORKDIR /app
RUN bun install

# ── Build all 8 UIs ──
FROM base AS ui-builder
RUN cd /app/packages/portal-ui && bun run build
RUN cd /app/packages/accounting-ui && bun run build
RUN cd /app/packages/invoicing-ui && bun run build
RUN cd /app/packages/warehouse-ui && bun run build
RUN cd /app/packages/payroll-ui && bun run build
RUN cd /app/packages/hr-ui && bun run build
RUN cd /app/packages/crm-ui && bun run build
RUN cd /app/packages/erp-ui && bun run build

# ── Runtime: same image for all services, different CMD ──
FROM base AS runtime

COPY --from=ui-builder /app/packages/portal-ui/dist /app/packages/portal-ui/dist
COPY --from=ui-builder /app/packages/accounting-ui/dist /app/packages/accounting-ui/dist
COPY --from=ui-builder /app/packages/invoicing-ui/dist /app/packages/invoicing-ui/dist
COPY --from=ui-builder /app/packages/warehouse-ui/dist /app/packages/warehouse-ui/dist
COPY --from=ui-builder /app/packages/payroll-ui/dist /app/packages/payroll-ui/dist
COPY --from=ui-builder /app/packages/hr-ui/dist /app/packages/hr-ui/dist
COPY --from=ui-builder /app/packages/crm-ui/dist /app/packages/crm-ui/dist
COPY --from=ui-builder /app/packages/erp-ui/dist /app/packages/erp-ui/dist

ENV HOST=0.0.0.0
EXPOSE 4001 4010 4020 4030 4040 4050 4060 4070

# Default to portal — override CMD per service in docker-compose
WORKDIR /app/packages/portal-api
CMD ["bun", "run", "start"]
