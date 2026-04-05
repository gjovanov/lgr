import type { DalConfig } from 'dal'
import type { RepositoryRegistry } from 'dal'
import { connectDB, mongoose } from 'db/connection'
import {
  Org, User, Invite, Code, EmailLog, AuditLog, File, Notification, BackgroundTask, OrgApp, Tag, PermissionSet,
  Journal, PaymentTerm, FiscalPosition,
  Account, FiscalYear, FiscalPeriod, JournalEntry, FixedAsset, BankAccount, BankReconciliation, TaxReturn, ExchangeRate,
  Contact, Invoice, PaymentOrder, CashOrder,
  Product, Warehouse, StockLevel, StockMovement, InventoryCount, PriceList, CostLayer, ProductCategory,
  StockLocation, OperationType, StockLot,
  Employee, PayrollRun, Payslip, Timesheet,
  POSPaymentMethod, POSSession, POSTransaction,
  FiscalDevice, Workstation,
} from 'db/models'
import { MongoRepository } from './base.repository.js'

export { MongoRepository } from './base.repository.js'
export { toEntity, toDocument } from './entity-mapper.js'
export { translateFilter } from './filter-translator.js'

/**
 * Create a complete RepositoryRegistry backed by MongoDB/Mongoose.
 */
export async function createMongoRepositories(config: DalConfig): Promise<RepositoryRegistry> {
  // Skip connection if mongoose is already connected (e.g., in tests with memory server)
  if (mongoose.connection.readyState !== 1) {
    if (config.mongoUri) {
      process.env.MONGODB_URI = config.mongoUri
    }
    await connectDB()
  }

  return {
    // Core
    orgs: new MongoRepository(Org),
    users: new MongoRepository(User),
    invites: new MongoRepository(Invite),
    codes: new MongoRepository(Code),
    emailLogs: new MongoRepository(EmailLog),
    auditLogs: new MongoRepository(AuditLog),
    files: new MongoRepository(File),
    notifications: new MongoRepository(Notification),
    backgroundTasks: new MongoRepository(BackgroundTask),
    orgApps: new MongoRepository(OrgApp),
    tags: new MongoRepository(Tag),
    permissionSets: new MongoRepository(PermissionSet),

    // Accounting
    journals: new MongoRepository(Journal),
    paymentTerms: new MongoRepository(PaymentTerm),
    fiscalPositions: new MongoRepository(FiscalPosition),
    accounts: new MongoRepository(Account),
    fiscalYears: new MongoRepository(FiscalYear),
    fiscalPeriods: new MongoRepository(FiscalPeriod),
    journalEntries: new MongoRepository(JournalEntry),
    fixedAssets: new MongoRepository(FixedAsset),
    bankAccounts: new MongoRepository(BankAccount),
    bankReconciliations: new MongoRepository(BankReconciliation),
    taxReturns: new MongoRepository(TaxReturn),
    exchangeRates: new MongoRepository(ExchangeRate),

    // Invoicing
    contacts: new MongoRepository(Contact),
    invoices: new MongoRepository(Invoice),
    paymentOrders: new MongoRepository(PaymentOrder),
    cashOrders: new MongoRepository(CashOrder),

    // Warehouse
    products: new MongoRepository(Product),
    warehouses: new MongoRepository(Warehouse),
    stockLevels: new MongoRepository(StockLevel),
    stockMovements: new MongoRepository(StockMovement),
    inventoryCounts: new MongoRepository(InventoryCount),
    priceLists: new MongoRepository(PriceList),
    costLayers: new MongoRepository(CostLayer),
    productCategories: new MongoRepository(ProductCategory),
    stockLocations: new MongoRepository(StockLocation),
    operationTypes: new MongoRepository(OperationType),
    stockLots: new MongoRepository(StockLot),

    // Payroll
    employees: new MongoRepository(Employee),
    payrollRuns: new MongoRepository(PayrollRun),
    payslips: new MongoRepository(Payslip),
    timesheets: new MongoRepository(Timesheet),

    // POS
    posPaymentMethods: new MongoRepository(POSPaymentMethod),
    posSessions: new MongoRepository(POSSession),
    posTransactions: new MongoRepository(POSTransaction),

    // Fiscal / SUPTO
    fiscalDevices: new MongoRepository(FiscalDevice),
    workstations: new MongoRepository(Workstation),
  }
}
