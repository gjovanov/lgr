# Entity Model Reference

LGR has 48 entity types across 8 modules. Each entity has a TypeScript interface (`packages/dal/src/entities/`), a MongoDB schema (`packages/db/src/models/`), and a SQLite schema (`packages/dal-sqlite/src/schema/`).

## Core (11 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [Org](core/org.md) | `IOrg` | `orgs` | Organization/tenant |
| [User](core/user.md) | `IUser` | `users` | User account |
| [Invite](core/invite.md) | `IInvite` | `invites` | Invitation code |
| [Code](core/code.md) | `ICode` | `codes` | Activation/reset code |
| [EmailLog](core/email-log.md) | `IEmailLog` | `email_logs` | Sent email record |
| [AuditLog](core/audit-log.md) | `IAuditLog` | `audit_logs` | Action audit trail |
| [File](core/file.md) | `IFile` | `files` | Uploaded file metadata |
| [Notification](core/notification.md) | `INotification` | `notifications` | User notification |
| [BackgroundTask](core/background-task.md) | `IBackgroundTask` | `background_tasks` | Async job |
| [OrgApp](core/org-app.md) | `IOrgApp` | `org_apps` | App activation per org |
| [Tag](core/tag.md) | `ITag` | `tags` | Categorization tag |

## Accounting (9 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [Account](accounting/account.md) | `IAccount` | `accounts` | Chart of accounts entry |
| [FiscalYear](accounting/fiscal-year.md) | `IFiscalYear` | `fiscal_years` | Financial year |
| [FiscalPeriod](accounting/fiscal-period.md) | `IFiscalPeriod` | `fiscal_periods` | Month/quarter within fiscal year |
| [JournalEntry](accounting/journal-entry.md) | `IJournalEntry` | `journal_entries` | Double-entry ledger posting |
| [FixedAsset](accounting/fixed-asset.md) | `IFixedAsset` | `fixed_assets` | Depreciable asset |
| [BankAccount](accounting/bank-account.md) | `IBankAccount` | `bank_accounts` | Bank account |
| [BankReconciliation](accounting/bank-reconciliation.md) | `IBankReconciliation` | `bank_reconciliations` | Statement reconciliation |
| [TaxReturn](accounting/tax-return.md) | `ITaxReturn` | `tax_returns` | Tax filing |
| [ExchangeRate](accounting/exchange-rate.md) | `IExchangeRate` | `exchange_rates` | Currency rate |

## Invoicing (4 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [Contact](invoicing/contact.md) | `IContact` | `contacts` | Customer/supplier |
| [Invoice](invoicing/invoice.md) | `IInvoice` | `invoices` | Invoice/credit note |
| [PaymentOrder](invoicing/payment-order.md) | `IPaymentOrder` | `payment_orders` | Bank payment/receipt |
| [CashOrder](invoicing/cash-order.md) | `ICashOrder` | `cash_orders` | Cash receipt/disbursement |

## Warehouse (6 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [Product](warehouse/product.md) | `IProduct` | `products` | Product/service item |
| [Warehouse](warehouse/warehouse.md) | `IWarehouse` | `warehouses` | Storage location |
| [StockLevel](warehouse/stock-level.md) | `IStockLevel` | `stock_levels` | Current inventory per product+warehouse |
| [StockMovement](warehouse/stock-movement.md) | `IStockMovement` | `stock_movements` | Inventory transaction |
| [InventoryCount](warehouse/inventory-count.md) | `IInventoryCount` | `inventory_counts` | Physical stock count |
| [PriceList](warehouse/price-list.md) | `IPriceList` | `price_lists` | Product pricing tier |

## Payroll (4 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [Employee](payroll/employee.md) | `IEmployee` | `employees` | Employee record |
| [PayrollRun](payroll/payroll-run.md) | `IPayrollRun` | `payroll_runs` | Payroll batch |
| [Payslip](payroll/payslip.md) | `IPayslip` | `payslips` | Individual pay statement |
| [Timesheet](payroll/timesheet.md) | `ITimesheet` | `timesheets` | Hours worked entry |

## HR (6 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [Department](hr/department.md) | `IDepartment` | `departments` | Organizational unit |
| [LeaveType](hr/leave-type.md) | `ILeaveType` | `leave_types` | Leave category |
| [LeaveRequest](hr/leave-request.md) | `ILeaveRequest` | `leave_requests` | Time-off request |
| [LeaveBalance](hr/leave-balance.md) | `ILeaveBalance` | `leave_balances` | Annual leave quota |
| [BusinessTrip](hr/business-trip.md) | `IBusinessTrip` | `business_trips` | Travel request |
| [EmployeeDocument](hr/employee-document.md) | `IEmployeeDocument` | `employee_documents` | HR document |

## CRM (4 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [Lead](crm/lead.md) | `ILead` | `leads` | Sales lead |
| [Deal](crm/deal.md) | `IDeal` | `deals` | Sales opportunity |
| [Pipeline](crm/pipeline.md) | `IPipeline` | `pipelines` | Deal stage workflow |
| [Activity](crm/activity.md) | `IActivity` | `activities` | CRM activity/task |

## ERP (5 entities)

| Entity | Interface | SQLite Table | Description |
|--------|-----------|-------------|-------------|
| [BillOfMaterials](erp/bill-of-materials.md) | `IBillOfMaterials` | `bill_of_materials` | Product recipe |
| [ProductionOrder](erp/production-order.md) | `IProductionOrder` | `production_orders` | Manufacturing order |
| [ConstructionProject](erp/construction-project.md) | `IConstructionProject` | `construction_projects` | Construction project |
| [POSSession](erp/pos-session.md) | `IPOSSession` | `pos_sessions` | Point of sale session |
| [POSTransaction](erp/pos-transaction.md) | `IPOSTransaction` | `pos_transactions` | POS sale/return |
