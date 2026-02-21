# DEPRECATED: Monolithic API

This package has been superseded by the multi-app architecture (Phase 5).

## Migration

All controllers from this monolithic API have been split into independent app APIs:

| Module | New Package | Port |
|--------|------------|------|
| Auth, OAuth, Org, User, Invite, Stripe, File, Notification, WS | `portal-api` | 4001 |
| Accounting (accounts, journal entries, fiscal years, etc.) | `accounting-api` | 4010 |
| Invoicing (invoices, contacts, payment/cash orders) | `invoicing-api` | 4020 |
| Warehouse (products, stock, movements, inventory) | `warehouse-api` | 4030 |
| Payroll (employees, payroll runs, payslips, timesheets) | `payroll-api` | 4040 |
| HR (departments, leave, business trips, documents) | `hr-api` | 4050 |
| CRM (leads, deals, pipelines, activities) | `crm-api` | 4060 |
| ERP (BOM, production, construction, POS) | `erp-api` | 4070 |

## When to remove

This package can be safely removed once:
1. All E2E tests have been migrated to per-app specs
2. No scripts reference `packages/api` directly
3. Team has confirmed all workflows use the new app APIs

## Legacy scripts

The root `package.json` still has legacy scripts pointing here:
- `dev:api-legacy` — runs this monolithic API in dev mode
- `start:legacy` — starts this monolithic API in production mode
