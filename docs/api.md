# API Reference

All endpoints are prefixed with `/api`. Authentication uses JWT tokens via httpOnly cookies or `Authorization: Bearer` header. Multi-tenant endpoints are scoped under `/api/org/:orgId/`.

## Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | — | Register new organization + admin user |
| `POST` | `/auth/login` | — | Login with orgSlug, username, password |
| `GET` | `/auth/me` | any | Get current user profile and organization |
| `POST` | `/auth/logout` | any | Clear auth cookie |

### POST `/auth/register`

```json
{
  "orgName": "Acme Corp",
  "orgSlug": "acme-corp",
  "firstName": "John",
  "lastName": "Doe",
  "email": "admin@acme.com",
  "username": "admin",
  "password": "test123"
}
```

Creates the organization, a default chart of accounts, and the admin user. Returns JWT token.

### POST `/auth/login`

```json
{
  "orgSlug": "acme-corp",
  "username": "admin",
  "password": "test123"
}
```

Returns JWT token and user profile. The `orgSlug` lookup is case-insensitive.

## Organization

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/org/:orgId` | any | Get organization details |
| `PUT` | `/org/:orgId` | admin | Update organization settings |
| `GET` | `/org/:orgId/user` | any | List organization users |
| `POST` | `/org/:orgId/user` | admin | Create/invite user |

## Accounting

### Account (Chart of Accounts)

Prefix: `/api/org/:orgId/accounting/account`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List all accounts |
| `POST` | `/` | any | Create account |
| `GET` | `/:id` | any | Get account |
| `PUT` | `/:id` | any | Update account |
| `DELETE` | `/:id` | any | Delete account |

### Journal Entry

Prefix: `/api/org/:orgId/accounting/journal`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List journal entries (query: `page`, `pageSize`, `status`, `startDate`, `endDate`) |
| `POST` | `/` | any | Create journal entry |
| `GET` | `/:id` | any | Get journal entry |
| `PUT` | `/:id` | any | Update journal entry (draft only) |
| `DELETE` | `/:id` | any | Delete journal entry (draft only) |
| `POST` | `/:id/post` | any | Post entry — validates debits = credits, updates account balances |
| `POST` | `/:id/void` | any | Void posted entry — reverses account balances |

### Fiscal Year

Prefix: `/api/org/:orgId/accounting/fiscal-year`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List fiscal years |
| `POST` | `/` | any | Create fiscal year |
| `GET` | `/:id` | any | Get fiscal year |
| `PUT` | `/:id` | any | Update fiscal year |
| `DELETE` | `/:id` | any | Delete fiscal year |

### Fiscal Period

Prefix: `/api/org/:orgId/accounting/fiscal-period`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List fiscal periods |
| `POST` | `/` | any | Create fiscal period |
| `GET` | `/:id` | any | Get fiscal period |
| `PUT` | `/:id` | any | Update fiscal period |
| `DELETE` | `/:id` | any | Delete fiscal period |

### Fixed Asset

Prefix: `/api/org/:orgId/accounting/fixed-asset`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List fixed assets |
| `POST` | `/` | any | Create fixed asset |
| `GET` | `/:id` | any | Get fixed asset |
| `PUT` | `/:id` | any | Update fixed asset |
| `DELETE` | `/:id` | any | Delete fixed asset |

### Bank Account

Prefix: `/api/org/:orgId/accounting/bank-account`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List bank accounts |
| `POST` | `/` | any | Create bank account |
| `GET` | `/:id` | any | Get bank account |
| `PUT` | `/:id` | any | Update bank account |
| `DELETE` | `/:id` | any | Delete bank account |

### Bank Reconciliation

Prefix: `/api/org/:orgId/accounting/reconciliation`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List reconciliations |
| `POST` | `/` | any | Create reconciliation |
| `GET` | `/:id` | any | Get reconciliation |
| `PUT` | `/:id` | any | Update reconciliation |
| `DELETE` | `/:id` | any | Delete reconciliation |

### Tax Return

Prefix: `/api/org/:orgId/accounting/tax-return`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List tax returns |
| `POST` | `/` | any | Create tax return |
| `GET` | `/:id` | any | Get tax return |
| `PUT` | `/:id` | any | Update tax return |
| `DELETE` | `/:id` | any | Delete tax return |

### Exchange Rate

Prefix: `/api/org/:orgId/accounting/exchange-rate`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List exchange rates |
| `POST` | `/` | any | Create exchange rate |
| `GET` | `/:id` | any | Get exchange rate |
| `PUT` | `/:id` | any | Update exchange rate |
| `DELETE` | `/:id` | any | Delete exchange rate |

### Accounting Reports

Prefix: `/api/org/:orgId/accounting/report`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/trial-balance` | any | Generate trial balance (query: `fiscalPeriodId`) |
| `GET` | `/profit-loss` | any | Generate P&L statement (query: `startDate`, `endDate`) |
| `GET` | `/balance-sheet` | any | Generate balance sheet (query: `asOfDate`) |

## Invoicing

### Contact

Prefix: `/api/org/:orgId/invoicing/contact`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List contacts (query: `page`, `pageSize`, `type`) |
| `POST` | `/` | any | Create contact |
| `GET` | `/:id` | any | Get contact |
| `PUT` | `/:id` | any | Update contact |
| `DELETE` | `/:id` | any | Delete contact |

### Invoice

Prefix: `/api/org/:orgId/invoices`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List invoices (query: `page`, `pageSize`, `type`, `direction`, `status`, `contactId`, `startDate`, `endDate`) |
| `POST` | `/` | any | Create invoice — auto-generates `invoiceNumber` |
| `GET` | `/:id` | any | Get invoice (populates contact) |
| `PUT` | `/:id` | any | Update invoice (draft only) |
| `DELETE` | `/:id` | any | Delete invoice (draft only) |
| `POST` | `/:id/send` | any | Send invoice — transitions `draft` → `sent` |
| `POST` | `/:id/payments` | any | Record payment — updates `amountPaid`, status to `partially_paid` or `paid` |

### Payment Order

Prefix: `/api/org/:orgId/invoicing/payment-order`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List payment orders |
| `POST` | `/` | any | Create payment order |
| `GET` | `/:id` | any | Get payment order |
| `PUT` | `/:id` | any | Update payment order |
| `DELETE` | `/:id` | any | Delete payment order |

### Cash Order

Prefix: `/api/org/:orgId/invoicing/cash-order`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List cash orders |
| `POST` | `/` | any | Create cash order |
| `GET` | `/:id` | any | Get cash order |
| `PUT` | `/:id` | any | Update cash order |
| `DELETE` | `/:id` | any | Delete cash order |

## Warehouse

### Product

Prefix: `/api/org/:orgId/warehouse/product`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List products (query: `page`, `pageSize`, `category`, `type`, `search`) |
| `POST` | `/` | any | Create product |
| `GET` | `/:id` | any | Get product |
| `PUT` | `/:id` | any | Update product |
| `DELETE` | `/:id` | any | Deactivate product (sets `isActive: false`) |

### Warehouse

Prefix: `/api/org/:orgId/warehouse/warehouse`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List warehouses |
| `POST` | `/` | any | Create warehouse |
| `GET` | `/:id` | any | Get warehouse |
| `PUT` | `/:id` | any | Update warehouse |
| `DELETE` | `/:id` | any | Deactivate warehouse |

### Stock Movement

Prefix: `/api/org/:orgId/warehouse/movement`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List movements (query: `page`, `pageSize`, `type`, `status`, `warehouseId`) |
| `POST` | `/` | any | Create stock movement |
| `GET` | `/:id` | any | Get movement |
| `PUT` | `/:id` | any | Update movement (draft only) |
| `POST` | `/:id/confirm` | any | Confirm movement — updates stock levels |

### Stock Level

Prefix: `/api/org/:orgId/warehouse/stock-level`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List stock levels (read-only) |

### Inventory Count

Prefix: `/api/org/:orgId/warehouse/inventory-count`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List inventory counts |
| `POST` | `/` | any | Create inventory count |
| `GET` | `/:id` | any | Get inventory count |
| `PUT` | `/:id` | any | Update inventory count |
| `DELETE` | `/:id` | any | Delete inventory count |
| `POST` | `/:id/complete` | any | Complete count — sets status and timestamps |

### Price List

Prefix: `/api/org/:orgId/warehouse/price-list`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List price lists |
| `POST` | `/` | any | Create price list |
| `GET` | `/:id` | any | Get price list |
| `PUT` | `/:id` | any | Update price list |
| `DELETE` | `/:id` | any | Delete price list |

### Warehouse Reports

Prefix: `/api/org/:orgId/warehouse/report`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/stock-valuation` | any | Aggregate stock value by product |

## Payroll

### Employee

Prefix: `/api/org/:orgId/payroll/employee`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List employees (query: `page`, `pageSize`, `status`, `department`) |
| `POST` | `/` | any | Create employee |
| `GET` | `/:id` | any | Get employee |
| `PUT` | `/:id` | admin, hr_manager | Update employee |
| `DELETE` | `/:id` | admin, hr_manager | Terminate employee (sets status, terminationDate) |

### Payroll Run

Prefix: `/api/org/:orgId/payroll/run`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List payroll runs (query: `page`, `pageSize`, `status`) |
| `POST` | `/` | any | Create payroll run |
| `GET` | `/:id` | any | Get payroll run |
| `PUT` | `/:id` | any | Update payroll run (draft/calculated only) |
| `DELETE` | `/:id` | admin, hr_manager | Delete payroll run (draft only) |
| `POST` | `/:id/calculate` | any | Calculate payroll — generates items for active employees |
| `POST` | `/:id/approve` | admin, hr_manager | Approve run — must be calculated first |

### Payslip

Prefix: `/api/org/:orgId/payroll/payslip`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List payslips |
| `POST` | `/` | any | Create payslip |
| `GET` | `/:id` | any | Get payslip |
| `PUT` | `/:id` | any | Update payslip |
| `DELETE` | `/:id` | any | Delete payslip |

### Timesheet

Prefix: `/api/org/:orgId/payroll/timesheet`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List timesheets |
| `POST` | `/` | any | Create timesheet |
| `GET` | `/:id` | any | Get timesheet |
| `PUT` | `/:id` | any | Update timesheet |
| `DELETE` | `/:id` | any | Delete timesheet |

## HR

### Department

Prefix: `/api/org/:orgId/hr/department`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List departments |
| `POST` | `/` | admin, hr_manager | Create department |
| `GET` | `/:id` | any | Get department |
| `PUT` | `/:id` | admin, hr_manager | Update department |
| `DELETE` | `/:id` | admin, hr_manager | Deactivate department |

### Leave Type

Prefix: `/api/org/:orgId/hr/leave-type`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List leave types |
| `POST` | `/` | any | Create leave type |
| `GET` | `/:id` | any | Get leave type |
| `PUT` | `/:id` | any | Update leave type |
| `DELETE` | `/:id` | any | Delete leave type |

### Leave Request

Prefix: `/api/org/:orgId/hr/leave-request`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List leave requests (query: `page`, `pageSize`, `status`, `employeeId`) |
| `POST` | `/` | any | Submit leave request — updates pending balance |
| `GET` | `/:id` | any | Get leave request |
| `PUT` | `/:id` | any | Update leave request (pending only) |
| `DELETE` | `/:id` | any | Cancel leave request — restores pending balance |
| `POST` | `/:id/approve` | admin, hr_manager | Approve leave — moves pending → taken |
| `POST` | `/:id/reject` | admin, hr_manager | Reject leave — restores pending balance |

### Leave Balance

Prefix: `/api/org/:orgId/hr/leave-balance`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List leave balances (read-only) |

### Business Trip

Prefix: `/api/org/:orgId/hr/business-trip`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List business trips |
| `POST` | `/` | any | Create business trip |
| `GET` | `/:id` | any | Get business trip |
| `PUT` | `/:id` | any | Update business trip |
| `DELETE` | `/:id` | any | Delete business trip |

### Employee Document

Prefix: `/api/org/:orgId/hr/employee-document`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List employee documents |
| `POST` | `/` | any | Create employee document |
| `GET` | `/:id` | any | Get employee document |
| `PUT` | `/:id` | any | Update employee document |
| `DELETE` | `/:id` | any | Delete employee document |

## CRM

### Lead

Prefix: `/api/org/:orgId/crm/lead`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List leads (query: `page`, `pageSize`, `status`, `source`, `assignedTo`) |
| `POST` | `/` | any | Create lead |
| `GET` | `/:id` | any | Get lead |
| `PUT` | `/:id` | any | Update lead |
| `DELETE` | `/:id` | any | Delete lead |
| `POST` | `/:id/convert` | any | Convert lead to contact + optional deal |

### Deal

Prefix: `/api/org/:orgId/crm/deal`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List deals (query: `page`, `pageSize`, `status`, `pipelineId`, `assignedTo`, `stage`) |
| `POST` | `/` | any | Create deal |
| `GET` | `/:id` | any | Get deal (populates contact) |
| `PUT` | `/:id` | any | Update deal |
| `DELETE` | `/:id` | any | Delete deal |
| `PUT` | `/:id/stage` | any | Move deal to new stage (open deals only) |

### Pipeline

Prefix: `/api/org/:orgId/crm/pipeline`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List pipelines |
| `POST` | `/` | admin, manager | Create pipeline |
| `GET` | `/:id` | any | Get pipeline |
| `PUT` | `/:id` | admin, manager | Update pipeline |
| `DELETE` | `/:id` | admin, manager | Deactivate pipeline |

### Activity

Prefix: `/api/org/:orgId/crm/activity`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List activities (query: `page`, `pageSize`, `type`, `status`, `contactId`, `dealId`, `assignedTo`) |
| `POST` | `/` | any | Create activity |
| `GET` | `/:id` | any | Get activity |
| `PUT` | `/:id` | any | Update activity |
| `DELETE` | `/:id` | any | Delete activity |
| `POST` | `/:id/complete` | any | Complete activity — sets status and completedAt |

### CRM Reports

Prefix: `/api/org/:orgId/crm/report`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/pipeline-summary` | any | Pipeline summary by stage (count, value, weighted) |

## ERP

### Bill of Materials (BOM)

Prefix: `/api/org/:orgId/erp/bom`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List BOMs (query: `status`, `productId`) |
| `POST` | `/` | any | Create BOM |
| `GET` | `/:id` | any | Get BOM |
| `PUT` | `/:id` | any | Update BOM |
| `DELETE` | `/:id` | any | Delete BOM |

### Production Order

Prefix: `/api/org/:orgId/erp/production-order`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List production orders (query: `page`, `pageSize`, `status`, `productId`) |
| `POST` | `/` | any | Create production order |
| `GET` | `/:id` | any | Get production order (populates BOM + product) |
| `PUT` | `/:id` | any | Update production order (not completed/cancelled) |
| `DELETE` | `/:id` | any | Delete production order (planned only) |

### Construction Project

Prefix: `/api/org/:orgId/erp/construction-project`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List projects (query: `page`, `pageSize`, `status`, `clientId`) |
| `POST` | `/` | any | Create project |
| `GET` | `/:id` | any | Get project (populates client) |
| `PUT` | `/:id` | any | Update project |
| `DELETE` | `/:id` | admin | Delete project (planning/cancelled only) |

### POS (Point of Sale)

Prefix: `/api/org/:orgId/erp/pos`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/session` | any | Open POS session — auto-generates `sessionNumber` |
| `GET` | `/session` | any | List sessions (query: `status`, `cashierId`) |
| `GET` | `/session/:id` | any | Get session |
| `POST` | `/session/:id/close` | any | Close session — calculates balance difference |
| `POST` | `/session/:id/transaction` | any | Record transaction — auto-generates `transactionNumber`, updates session totals |
| `GET` | `/session/:id/transaction` | any | List session transactions |

## Utility Endpoints

### File Upload

Prefix: `/api/org/:orgId/file`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/upload` | any | Upload file (multipart, max 50MB) |
| `GET` | `/:id` | any | Get file metadata |
| `GET` | `/:id/download` | any | Download file |
| `DELETE` | `/:id` | any | Delete file |

### Export

Prefix: `/api/org/:orgId/export`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/accounting/:type` | any | Export accounting report (`chart-of-accounts`, `journal-entries`, `trial-balance`, `general-ledger`) as Excel |
| `GET` | `/invoicing/:type` | any | Export invoicing report as Excel or PDF |
| `GET` | `/payroll/:type` | any | Export payroll report as Excel or PDF |
| `GET` | `/crm/:type` | any | Export CRM report as Excel |
| `GET` | `/warehouse/:type` | any | Export warehouse report as Excel |

### Notification

Prefix: `/api/org/:orgId/notification`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | any | List notifications |
| `PATCH` | `/:id/read` | any | Mark notification as read |
| `PATCH` | `/read-all` | any | Mark all notifications as read |

### WebSocket

| Path | Description |
|------|-------------|
| `/ws/tasks?userId={userId}` | Real-time task and notification updates. Ping/pong keepalive every 30s. |

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Health check |

## Response Format

List endpoints return:

```json
{
  "products": [...],
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

The top-level key matches the resource name (e.g., `invoices`, `employees`, `deals`). Each Pinia store destructures this specific key.

See [Architecture](architecture.md) for the request flow and [Data Model](data-model.md) for entity schemas.
