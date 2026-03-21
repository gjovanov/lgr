import type { DalConfig } from 'dal'
import type { RepositoryRegistry } from 'dal'
import { connectDB, mongoose } from 'db/connection'
import {
  Org, User, Invite, Code, EmailLog, AuditLog, File, Notification, BackgroundTask, OrgApp, Tag,
  Account, FiscalYear, FiscalPeriod, JournalEntry, FixedAsset, BankAccount, BankReconciliation, TaxReturn, ExchangeRate,
  Contact, Invoice, PaymentOrder, CashOrder,
  Product, Warehouse, StockLevel, StockMovement, InventoryCount, PriceList, CostLayer, ProductCategory,
  Employee, PayrollRun, Payslip, Timesheet,
  Department, LeaveType, LeaveRequest, LeaveBalance, BusinessTrip, EmployeeDocument,
  Lead, Deal, Pipeline, Activity,
  BillOfMaterials, ProductionOrder, ConstructionProject, POSSession, POSTransaction,
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

    // Accounting
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

    // Payroll
    employees: new MongoRepository(Employee),
    payrollRuns: new MongoRepository(PayrollRun),
    payslips: new MongoRepository(Payslip),
    timesheets: new MongoRepository(Timesheet),

    // HR
    departments: new MongoRepository(Department),
    leaveTypes: new MongoRepository(LeaveType),
    leaveRequests: new MongoRepository(LeaveRequest),
    leaveBalances: new MongoRepository(LeaveBalance),
    businessTrips: new MongoRepository(BusinessTrip),
    employeeDocuments: new MongoRepository(EmployeeDocument),

    // CRM
    leads: new MongoRepository(Lead),
    deals: new MongoRepository(Deal),
    pipelines: new MongoRepository(Pipeline),
    activities: new MongoRepository(Activity),

    // ERP
    billOfMaterials: new MongoRepository(BillOfMaterials),
    productionOrders: new MongoRepository(ProductionOrder),
    constructionProjects: new MongoRepository(ConstructionProject),
    posSessions: new MongoRepository(POSSession),
    posTransactions: new MongoRepository(POSTransaction),

    // Fiscal / SUPTO
    fiscalDevices: new MongoRepository(FiscalDevice),
    workstations: new MongoRepository(Workstation),
  }
}
