# Cloud API Reference

All cloud APIs require JWT authentication. Token is issued by the Portal and verified by domain apps.

## Portal API (port 4001)

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with orgSlug, username, password |
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/logout` | Clear auth cookie |
| GET | `/api/auth/me` | Get current user profile |
| GET | `/api/oauth/:provider` | Initiate OAuth flow |
| GET | `/api/oauth/callback/:provider` | OAuth callback |

### Organizations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/org/:orgId/org` | Get organization details |
| PUT | `/api/org/:orgId/org` | Update organization |
| GET | `/api/org/:orgId/org/users` | List org users |
| POST | `/api/org/:orgId/org/users` | Create user |

## Domain APIs

All domain endpoints follow the pattern: `/api/org/:orgId/<module>/<resource>`

### Accounting API (port 4010)

| Resource | List | Create | Get | Update | Delete |
|----------|------|--------|-----|--------|--------|
| `/accounting/accounts` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/journal-entries` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/fiscal-years` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/fiscal-periods` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/fixed-assets` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/bank-accounts` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/reconciliations` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/tax-returns` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/exchange-rates` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/accounting/reports/*` | GET | - | - | - | - |

### Invoicing API (port 4020)

| Resource | List | Create | Get | Update | Delete |
|----------|------|--------|-----|--------|--------|
| `/invoicing/contacts` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/invoicing/invoices` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/invoicing/payment-orders` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/invoicing/cash-orders` | GET | POST | GET /:id | PUT /:id | DELETE /:id |

### Warehouse API (port 4030)

| Resource | List | Create | Get | Update | Delete |
|----------|------|--------|-----|--------|--------|
| `/warehouse/products` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/warehouse/warehouses` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/warehouse/movements` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/warehouse/stock-levels` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/warehouse/inventory-counts` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/warehouse/price-lists` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/warehouse/product-ledger` | GET | - | - | - | - |

### Payroll API (port 4040)

| Resource | List | Create | Get | Update | Delete |
|----------|------|--------|-----|--------|--------|
| `/payroll/employees` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/payroll/runs` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/payroll/payslips` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/payroll/timesheets` | GET | POST | GET /:id | PUT /:id | DELETE /:id |

### HR API (port 4050)

| Resource | List | Create | Get | Update | Delete |
|----------|------|--------|-----|--------|--------|
| `/hr/departments` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/hr/leave-types` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/hr/leaves` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/hr/leave-balances` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/hr/business-trips` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/hr/employee-documents` | GET | POST | GET /:id | PUT /:id | DELETE /:id |

### CRM API (port 4060)

| Resource | List | Create | Get | Update | Delete |
|----------|------|--------|-----|--------|--------|
| `/crm/leads` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/crm/deals` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/crm/pipelines` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/crm/activities` | GET | POST | GET /:id | PUT /:id | DELETE /:id |

### ERP API (port 4070)

| Resource | List | Create | Get | Update | Delete |
|----------|------|--------|-----|--------|--------|
| `/erp/bom` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/erp/production-orders` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/erp/construction` | GET | POST | GET /:id | PUT /:id | DELETE /:id |
| `/erp/pos/*` | GET | POST | GET /:id | PUT /:id | DELETE /:id |

## List Response Format

```json
{
  "<resourceName>": [...],
  "total": 42,
  "page": 0,
  "pageSize": 20
}
```

## Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `page` | Page number (0-indexed) | `?page=0` |
| `pageSize` | Items per page | `?pageSize=50` |
| `sort` | Sort field | `?sort=createdAt` |
| `order` | Sort direction | `?order=desc` |
| `search` | Text search | `?search=widget` |
| `status` | Filter by status | `?status=draft` |
