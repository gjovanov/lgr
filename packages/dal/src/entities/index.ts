// Core
export type {
  IOrg, IOrgSettings, IOrgSubscription, IVatRate, ITaxConfig, IPayrollConfig, ICloudStorageIntegration,
  IUser, IOAuthProvider, IUserPreferences, IRoleHistoryEntry,
  IInvite, InviteStatus,
  ICode, CodeType,
  IEmailLog,
  IAuditLog, IAuditLogChange,
  IFile, IAiRecognition,
  INotification,
  IBackgroundTask,
  IOrgApp,
  ITag,
} from './core.js'

// Permission Sets
export type { IPermissionSet, IOwnRecordsConfig } from './permission-set.js'

// Accounting
export type {
  IJournal,
  IPaymentTerm, IPaymentTermLine,
  IFiscalPosition, IFiscalPositionTaxMap,
  IAccount,
  IFiscalYear,
  IFiscalPeriod,
  IJournalEntry, IJournalEntryLine,
  IFixedAsset, IDepreciationEntry,
  IBankAccount,
  IBankReconciliation, IBankReconciliationItem,
  ITaxReturn, ITaxReturnLine,
  IExchangeRate,
} from './accounting.js'

// Invoicing
export type {
  IPriceStep,
  IContact, IContactAddress, IContactBankDetail,
  IInvoice, IInvoiceLine, IInvoicePayment, IInvoiceAddress, IInvoiceRecurringConfig,
  IPaymentOrder,
  ICashOrder,
} from './invoicing.js'

// Warehouse
export type {
  IProduct, IProductDimensions, IProductCustomPrice, IProductTagPrice, IProductCategoryPrice, IProductVariant,
  IProductCategory,
  IWarehouse, IWarehouseAddress,
  IStockLevel,
  IStockMovement, IStockMovementLine, ICostAllocation,
  IInventoryCount, IInventoryCountLine,
  IPriceList, IPriceListItem,
  ICostLayer,
  IStockLocation,
  IOperationType,
  IStockLot,
} from './warehouse.js'

// Payroll
export type {
  IEmployee, IEmployeeAddress, IEmployeeSalary, IEmployeeDeduction, IEmployeeBenefit, IEmergencyContact,
  IPayrollRun, IPayrollRunItem, IPayrollRunDeduction, IPayrollRunEmployerContribution, IPayrollRunTotals,
  IPayslip, IPayslipEarning, IPayslipDeduction, IPayslipYearToDate,
  ITimesheet,
} from './payroll.js'

// ERP (POS + Fiscal only)
export type {
  IFiscalDevice, IFiscalDeviceConnectionParams,
  IWorkstation,
  IPOSPaymentMethod,
  IPOSSession,
  IPOSTransaction, IPOSTransactionLine, IPOSTransactionPayment,
} from './erp.js'
