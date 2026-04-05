import type { IRepository, IBatchRepository } from './repository.js'
import type {
  IOrg, IUser, IInvite, ICode, IEmailLog, IAuditLog, IFile, INotification, IBackgroundTask, IOrgApp, ITag,
  IPermissionSet,
  IJournal, IPaymentTerm, IFiscalPosition,
  IAccount, IFiscalYear, IFiscalPeriod, IJournalEntry, IFixedAsset, IBankAccount, IBankReconciliation, ITaxReturn, IExchangeRate,
  IContact, IInvoice, IPaymentOrder, ICashOrder,
  IProduct, IWarehouse, IStockLevel, IStockMovement, IInventoryCount, IPriceList, ICostLayer, IProductCategory,
  IStockLocation, IOperationType, IStockLot,
  IEmployee, IPayrollRun, IPayslip, ITimesheet,
  IFiscalDevice, IWorkstation, IPOSPaymentMethod, IPOSSession, IPOSTransaction,
} from './entities/index.js'

/**
 * Registry of all repositories, keyed by entity name.
 * This is the single entry point for all data access in business logic.
 */
export interface RepositoryRegistry {
  // Core
  orgs: IBatchRepository<IOrg>
  users: IBatchRepository<IUser>
  invites: IBatchRepository<IInvite>
  codes: IBatchRepository<ICode>
  emailLogs: IBatchRepository<IEmailLog>
  auditLogs: IBatchRepository<IAuditLog>
  files: IBatchRepository<IFile>
  notifications: IBatchRepository<INotification>
  backgroundTasks: IBatchRepository<IBackgroundTask>
  orgApps: IBatchRepository<IOrgApp>
  tags: IBatchRepository<ITag>
  permissionSets: IBatchRepository<IPermissionSet>

  // Accounting
  journals: IBatchRepository<IJournal>
  paymentTerms: IBatchRepository<IPaymentTerm>
  fiscalPositions: IBatchRepository<IFiscalPosition>
  accounts: IBatchRepository<IAccount>
  fiscalYears: IBatchRepository<IFiscalYear>
  fiscalPeriods: IBatchRepository<IFiscalPeriod>
  journalEntries: IBatchRepository<IJournalEntry>
  fixedAssets: IBatchRepository<IFixedAsset>
  bankAccounts: IBatchRepository<IBankAccount>
  bankReconciliations: IBatchRepository<IBankReconciliation>
  taxReturns: IBatchRepository<ITaxReturn>
  exchangeRates: IBatchRepository<IExchangeRate>

  // Invoicing
  contacts: IBatchRepository<IContact>
  invoices: IBatchRepository<IInvoice>
  paymentOrders: IBatchRepository<IPaymentOrder>
  cashOrders: IBatchRepository<ICashOrder>

  // Warehouse
  products: IBatchRepository<IProduct>
  warehouses: IBatchRepository<IWarehouse>
  stockLevels: IBatchRepository<IStockLevel>
  stockMovements: IBatchRepository<IStockMovement>
  inventoryCounts: IBatchRepository<IInventoryCount>
  priceLists: IBatchRepository<IPriceList>
  costLayers: IBatchRepository<ICostLayer>
  productCategories: IBatchRepository<IProductCategory>
  stockLocations: IBatchRepository<IStockLocation>
  operationTypes: IBatchRepository<IOperationType>
  stockLots: IBatchRepository<IStockLot>

  // Payroll
  employees: IBatchRepository<IEmployee>
  payrollRuns: IBatchRepository<IPayrollRun>
  payslips: IBatchRepository<IPayslip>
  timesheets: IBatchRepository<ITimesheet>

  // POS
  posPaymentMethods: IBatchRepository<IPOSPaymentMethod>
  posSessions: IBatchRepository<IPOSSession>
  posTransactions: IBatchRepository<IPOSTransaction>

  // Fiscal / SUPTO
  fiscalDevices: IBatchRepository<IFiscalDevice>
  workstations: IBatchRepository<IWorkstation>
}

/** All repository keys */
export type RepositoryKey = keyof RepositoryRegistry
