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

// Accounting
export type {
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
} from './warehouse.js'

// Payroll
export type {
  IEmployee, IEmployeeAddress, IEmployeeSalary, IEmployeeDeduction, IEmployeeBenefit, IEmergencyContact,
  IPayrollRun, IPayrollRunItem, IPayrollRunDeduction, IPayrollRunEmployerContribution, IPayrollRunTotals,
  IPayslip, IPayslipEarning, IPayslipDeduction, IPayslipYearToDate,
  ITimesheet,
} from './payroll.js'

// HR
export type {
  IDepartment,
  ILeaveType,
  ILeaveRequest,
  ILeaveBalance,
  IBusinessTrip, IBusinessTripExpense,
  IEmployeeDocument,
} from './hr.js'

// CRM
export type {
  ILead,
  IDeal, IDealProduct,
  IPipeline, IPipelineStage,
  IActivity,
} from './crm.js'

// ERP
export type {
  IBillOfMaterials, IBOMMaterial,
  IProductionOrder, IProductionStage, IMaterialConsumed, IQualityCheck,
  IConstructionProject, IProjectAddress, IProjectBudget, IProjectPhase, IProjectTask, IProjectTeamMember, IProjectMaterial,
  IFiscalDevice, IFiscalDeviceConnectionParams,
  IWorkstation,
  IPOSSession,
  IPOSTransaction, IPOSTransactionLine, IPOSTransactionPayment,
} from './erp.js'
