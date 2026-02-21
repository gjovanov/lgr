# DEPRECATED: Monolithic UI

This package has been superseded by the multi-app architecture (Phase 5).

## Migration

All views and stores from this monolithic UI have been split into independent app UIs:

| Module | New Package | Dev Port |
|--------|------------|----------|
| Auth, Settings, Admin, Billing, App Hub, Dashboard | `portal-ui` | 4000 |
| Accounting views | `accounting-ui` | 4011 |
| Invoicing views | `invoicing-ui` | 4021 |
| Warehouse views | `warehouse-ui` | 4031 |
| Payroll views | `payroll-ui` | 4041 |
| HR views | `hr-ui` | 4051 |
| CRM views | `crm-ui` | 4061 |
| ERP views | `erp-ui` | 4071 |

Shared UI components have been extracted to:
- `ui-shell` — App shell (top bar, app switcher, org selector, sidebar)
- `ui-shared` — Composables (useHttpClient, useSnackbar, useWebSocket), Vuetify/i18n plugins

## When to remove

This package can be safely removed once:
1. All E2E tests have been migrated to per-app specs
2. No scripts reference `packages/ui` directly
3. Team has confirmed all workflows use the new app UIs

## Legacy scripts

The root `package.json` still has legacy scripts pointing here:
- `dev:ui-legacy` — runs this monolithic UI in dev mode
- `build:ui-legacy` — builds this monolithic UI
