# ── Base: install dependencies ──
FROM oven/bun:1.3.10-slim AS base
COPY . /app
WORKDIR /app
RUN bun install

# ── Build all 14 UIs ──
FROM base AS ui-builder
RUN cd /app/packages/portal-ui && bun run build
RUN cd /app/packages/accounting-ui && bun run build
RUN cd /app/packages/trade-ui && bun run build
RUN cd /app/packages/sales-ui && bun run build
RUN cd /app/packages/purchase-ui && bun run build
RUN cd /app/packages/project-ui && bun run build
RUN cd /app/packages/helpdesk-ui && bun run build
RUN cd /app/packages/documents-ui && bun run build
RUN cd /app/packages/subscriptions-ui && bun run build
RUN cd /app/packages/planning-ui && bun run build
RUN cd /app/packages/payroll-ui && bun run build
RUN cd /app/packages/hr-ui && bun run build
RUN cd /app/packages/crm-ui && bun run build
RUN cd /app/packages/erp-ui && bun run build

# ── Runtime: single unified process ──
FROM base AS runtime

COPY --from=ui-builder /app/packages/portal-ui/dist /app/packages/portal-ui/dist
COPY --from=ui-builder /app/packages/accounting-ui/dist /app/packages/accounting-ui/dist
COPY --from=ui-builder /app/packages/trade-ui/dist /app/packages/trade-ui/dist
COPY --from=ui-builder /app/packages/sales-ui/dist /app/packages/sales-ui/dist
COPY --from=ui-builder /app/packages/purchase-ui/dist /app/packages/purchase-ui/dist
COPY --from=ui-builder /app/packages/project-ui/dist /app/packages/project-ui/dist
COPY --from=ui-builder /app/packages/helpdesk-ui/dist /app/packages/helpdesk-ui/dist
COPY --from=ui-builder /app/packages/documents-ui/dist /app/packages/documents-ui/dist
COPY --from=ui-builder /app/packages/subscriptions-ui/dist /app/packages/subscriptions-ui/dist
COPY --from=ui-builder /app/packages/planning-ui/dist /app/packages/planning-ui/dist
COPY --from=ui-builder /app/packages/payroll-ui/dist /app/packages/payroll-ui/dist
COPY --from=ui-builder /app/packages/hr-ui/dist /app/packages/hr-ui/dist
COPY --from=ui-builder /app/packages/crm-ui/dist /app/packages/crm-ui/dist
COPY --from=ui-builder /app/packages/erp-ui/dist /app/packages/erp-ui/dist

ENV HOST=0.0.0.0
EXPOSE 4001

WORKDIR /app/packages/portal-api
CMD ["bun", "run", "start:unified"]
