// Tags
export { Tag, type ITag } from './tag.model.js'

// Core
export { Org, type IOrg } from './org.model.js'
export { OrgLogo, type IOrgLogo } from './org-logo.model.js'
export { User, type IUser, type IOAuthProvider, type IRoleHistoryEntry } from './user.model.js'
export { Identity, type IIdentity, type IIdentityProvider, type PasswordSetBy } from './identity.model.js'
export { PermissionSet, type IPermissionSet, type IOwnRecordsConfig } from './permission-set.model.js'
export { Invite, type IInvite, type InviteStatus } from './invite.model.js'
export { Code, type ICode, type CodeType } from './code.model.js'
export { OAuthHandoff, type IOAuthHandoff } from './oauth-handoff.model.js'
export { LoginThrottle, type ILoginThrottle } from './login-throttle.model.js'
export {
  OAuthPendingRegistration,
  type IOAuthPendingRegistration,
} from './oauth-pending-registration.model.js'
export { EmailLog, type IEmailLog } from './email-log.model.js'
export { DigestRun, type IDigestRun, type IDigestRunRecipient } from './digest-run.model.js'
export { BackupRun, type IBackupRun, type IBackupRunCollection } from './backup-run.model.js'
export { ArchiveUnit, type IArchiveUnit } from './archive-unit.model.js'
export {
  RestoreRun,
  type IRestoreRun,
  type IRestoreCollectionResult,
  type IRestoreSequenceClamp,
} from './restore-run.model.js'
export { AuditLog, type IAuditLog } from './audit-log.model.js'
export { File, type IFile } from './file.model.js'
export { DocFile, type IDocFile, type DocType, type DocFileStatus } from './doc-file.model.js'
export { Notification, type INotification } from './notification.model.js'
export { BackgroundTask, type IBackgroundTask } from './background-task.model.js'
export { OrgApp, type IOrgApp } from './org-app.model.js'

// Accounting
export { Journal, type IJournal } from './journal.model.js'
export { Account, type IAccount } from './account.model.js'
export { FiscalYear, type IFiscalYear } from './fiscal-year.model.js'
export { FiscalPeriod, type IFiscalPeriod } from './fiscal-period.model.js'
export { JournalEntry, type IJournalEntry } from './journal-entry.model.js'
export { FixedAsset, type IFixedAsset } from './fixed-asset.model.js'
export { BankAccount, type IBankAccount } from './bank-account.model.js'
export { BankReconciliation, type IBankReconciliation } from './bank-reconciliation.model.js'
export { TaxReturn, type ITaxReturn } from './tax-return.model.js'
export { ExchangeRate, type IExchangeRate } from './exchange-rate.model.js'
export { PaymentTerm, type IPaymentTerm, type IPaymentTermLine } from './payment-term.model.js'
export { FiscalPosition, type IFiscalPosition, type IFiscalPositionTaxMap } from './fiscal-position.model.js'

// Invoicing
export { Contact, type IContact } from './contact.model.js'
export { Invoice, type IInvoice } from './invoice.model.js'
export { Order, type IOrder, type IOrderSupplierGroup, type IOrderLine, type IOrderAllocation, type IOrderReservation } from './order.model.js'
export { InternalOrder, type IInternalOrder, type IInternalOrderLine } from './internal-order.model.js'
export { Reservation, type IReservation } from './reservation.model.js'
export { SupplierProductAlias, normalizeAlias, type ISupplierProductAlias } from './supplier-product-alias.model.js'
export { PaymentOrder, type IPaymentOrder } from './payment-order.model.js'
export { CashOrder, type ICashOrder } from './cash-order.model.js'

// Warehouse
export { Product, type IProduct } from './product.model.js'
export { Warehouse, type IWarehouse } from './warehouse.model.js'
export { StockLevel, type IStockLevel } from './stock-level.model.js'
export { StockMovement, type IStockMovement } from './stock-movement.model.js'
export { InventoryCount, type IInventoryCount } from './inventory-count.model.js'
export { PriceList, type IPriceList } from './price-list.model.js'
export { CostLayer, type ICostLayer } from './cost-layer.model.js'
export { ProductCategory, type IProductCategory } from './product-category.model.js'
export { StockLocation, type IStockLocation } from './stock-location.model.js'
export { OperationType, type IOperationType } from './operation-type.model.js'
export { StockLot, type IStockLot } from './stock-lot.model.js'
export { DinCatalog, type IDinCatalog } from './din-catalog.model.js'

// Payroll
export { Employee, type IEmployee } from './employee.model.js'
export { PayrollRun, type IPayrollRun } from './payroll-run.model.js'
export { Payslip, type IPayslip } from './payslip.model.js'
export { Timesheet, type ITimesheet } from './timesheet.model.js'

// ERP (POS only)
export { POSSession, type IPOSSession } from './pos-session.model.js'
export { POSTransaction, type IPOSTransaction } from './pos-transaction.model.js'
export { POSPaymentMethod, type IPOSPaymentMethod } from './pos-payment-method.model.js'

// Fiscal / SUPTO
export { FiscalDevice, type IFiscalDevice } from './fiscal-device.model.js'
export { Workstation, type IWorkstation } from './workstation.model.js'

// Desktop clients (FR-14). Desktop, never Device: "device" means fiscal device everywhere else.
export { Desktop, type IDesktop } from './desktop.model.js'
export {
  DesktopEnrollmentCode, type IDesktopEnrollmentCode,
  DesktopEnrollmentKey, type IDesktopEnrollmentKey,
  DesktopEnrollmentKeyUse, type IDesktopEnrollmentKeyUse,
  DesktopAssertion, type IDesktopAssertion,
} from './desktop-enrollment.model.js'

// Infrastructure
export { Sequence, type ISequence } from './sequence.model.js'
