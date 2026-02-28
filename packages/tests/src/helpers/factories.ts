import {
  Org, type IOrg,
  User, type IUser,
  Account, type IAccount,
  Contact, type IContact,
  Invoice, type IInvoice,
  Product, type IProduct,
  Warehouse, type IWarehouse,
  Employee, type IEmployee,
  Department, type IDepartment,
  Lead, type ILead,
  Deal, type IDeal,
  Pipeline, type IPipeline,
  FiscalYear, type IFiscalYear,
  FiscalPeriod, type IFiscalPeriod,
  PayrollRun, type IPayrollRun,
  Payslip, type IPayslip,
  Activity, type IActivity,
  StockLevel, type IStockLevel,
  JournalEntry, type IJournalEntry,
  LeaveType, type ILeaveType,
  LeaveBalance, type ILeaveBalance,
  LeaveRequest, type ILeaveRequest,
  ConstructionProject, type IConstructionProject,
  BillOfMaterials, type IBillOfMaterials,
  ProductionOrder, type IProductionOrder,
  POSSession, type IPOSSession,
  StockMovement, type IStockMovement,
  FixedAsset, type IFixedAsset,
  BankAccount, type IBankAccount,
  BusinessTrip, type IBusinessTrip,
  Timesheet, type ITimesheet,
  POSTransaction, type IPOSTransaction,
  ExchangeRate, type IExchangeRate,
  BankReconciliation, type IBankReconciliation,
  TaxReturn, type ITaxReturn,
  PaymentOrder, type IPaymentOrder,
  CashOrder, type ICashOrder,
  InventoryCount, type IInventoryCount,
  PriceList, type IPriceList,
  EmployeeDocument, type IEmployeeDocument,
  Notification, type INotification,
  Invite, type IInvite,
} from 'db/models'
import { mongoose } from 'db/connection'
const { Types } = mongoose
import { DEFAULT_ROLE_PERMISSIONS, MODULES } from 'config/constants'

const objectId = () => new Types.ObjectId()
let warehouseCounter = 0
let bankAccountCounter = 0

export async function createTestOrg(overrides: Partial<IOrg> = {}): Promise<IOrg> {
  const defaults = {
    name: 'Test Org',
    slug: `test-org-${Date.now()}`,
    ownerId: objectId(),
    settings: {
      baseCurrency: 'EUR',
      fiscalYearStart: 1,
      dateFormat: 'DD.MM.YYYY',
      timezone: 'Europe/Berlin',
      locale: 'en',
      taxConfig: {
        vatEnabled: true,
        defaultVatRate: 18,
        vatRates: [
          { name: 'Standard', rate: 18 },
          { name: 'Reduced', rate: 5 },
          { name: 'Zero', rate: 0 },
        ],
        taxIdLabel: 'VAT ID',
      },
      payroll: {
        payFrequency: 'monthly',
        socialSecurityRate: 18,
        healthInsuranceRate: 7.5,
        pensionRate: 18,
      },
      modules: [...MODULES],
    },
    subscription: { plan: 'professional', maxUsers: 50 },
  }
  return Org.create({ ...defaults, ...overrides }) as Promise<IOrg>
}

export async function createTestUser(orgId: Types.ObjectId, overrides: Partial<IUser> = {}): Promise<IUser> {
  const ts = Date.now()
  const role = overrides.role || 'admin'
  const defaults = {
    email: `user-${ts}@test.com`,
    username: `user-${ts}`,
    password: await Bun.password.hash('test123'),
    firstName: 'Test',
    lastName: 'User',
    role,
    orgId,
    isActive: true,
    permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || [],
  }
  return User.create({ ...defaults, ...overrides }) as Promise<IUser>
}

export async function createTestAccount(orgId: Types.ObjectId, overrides: Partial<IAccount> = {}): Promise<IAccount> {
  const ts = Date.now()
  const defaults = {
    orgId,
    code: `${1000 + Math.floor(Math.random() * 9000)}`,
    name: `Test Account ${ts}`,
    type: 'asset',
    subType: 'current_asset',
    isSystem: false,
    isActive: true,
    balance: 0,
  }
  return Account.create({ ...defaults, ...overrides }) as Promise<IAccount>
}

export async function createTestContact(orgId: Types.ObjectId, overrides: Partial<IContact> = {}): Promise<IContact> {
  const ts = Date.now()
  const defaults = {
    orgId,
    type: 'customer',
    companyName: `Test Company ${ts}`,
    firstName: 'John',
    lastName: 'Doe',
    email: `contact-${ts}@test.com`,
    phone: '+1234567890',
    addresses: [
      {
        type: 'billing',
        street: '123 Main St',
        city: 'Berlin',
        postalCode: '10115',
        country: 'DE',
        isDefault: true,
      },
    ],
    bankDetails: [],
    paymentTermsDays: 30,
    isActive: true,
  }
  return Contact.create({ ...defaults, ...overrides }) as Promise<IContact>
}

export async function createTestInvoice(
  orgId: Types.ObjectId,
  contactId: Types.ObjectId,
  overrides: Partial<IInvoice> = {},
): Promise<IInvoice> {
  const ts = Date.now()
  const now = new Date()
  const dueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const defaults = {
    orgId,
    invoiceNumber: `INV-${ts}`,
    type: 'invoice',
    direction: 'outgoing',
    status: 'draft',
    contactId,
    issueDate: now,
    dueDate,
    currency: 'EUR',
    exchangeRate: 1,
    lines: [
      {
        description: 'Test Service',
        quantity: 1,
        unit: 'pcs',
        unitPrice: 1000,
        discount: 0,
        taxRate: 18,
        taxAmount: 180,
        lineTotal: 1180,
      },
    ],
    subtotal: 1000,
    discountTotal: 0,
    taxTotal: 180,
    total: 1180,
    totalBase: 1180,
    amountPaid: 0,
    amountDue: 1180,
    payments: [],
    billingAddress: {
      street: '123 Main St',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    },
    attachments: [],
    createdBy: objectId(),
  }
  return Invoice.create({ ...defaults, ...overrides }) as Promise<IInvoice>
}

export async function createTestProduct(orgId: Types.ObjectId, overrides: Partial<IProduct> = {}): Promise<IProduct> {
  const ts = Date.now()
  const defaults = {
    orgId,
    sku: `SKU-${ts}`,
    name: `Test Product ${ts}`,
    category: 'General',
    type: 'goods',
    unit: 'pcs',
    purchasePrice: 50,
    sellingPrice: 100,
    currency: 'EUR',
    taxRate: 18,
    trackInventory: true,
    minStockLevel: 10,
    customPrices: [],
    isActive: true,
  }
  return Product.create({ ...defaults, ...overrides }) as Promise<IProduct>
}

export async function createTestWarehouse(orgId: Types.ObjectId, overrides: Partial<IWarehouse> = {}): Promise<IWarehouse> {
  const ts = Date.now()
  const uniqueId = `${ts}-${++warehouseCounter}`
  const defaults = {
    orgId,
    name: `Warehouse ${uniqueId}`,
    code: `WH-${uniqueId}`,
    type: 'warehouse',
    address: {
      street: '1 Industrial Blvd',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    },
    isDefault: false,
    isActive: true,
  }
  return Warehouse.create({ ...defaults, ...overrides }) as Promise<IWarehouse>
}

export async function createTestEmployee(orgId: Types.ObjectId, overrides: Partial<IEmployee> = {}): Promise<IEmployee> {
  const ts = Date.now()
  const defaults = {
    orgId,
    employeeNumber: `EMP-${ts}`,
    firstName: 'Jane',
    lastName: 'Smith',
    email: `emp-${ts}@test.com`,
    department: 'Engineering',
    position: 'Developer',
    employmentType: 'full_time',
    contractStartDate: new Date('2024-01-01'),
    status: 'active',
    salary: {
      baseSalary: 5000,
      currency: 'EUR',
      frequency: 'monthly',
    },
    deductions: [
      { type: 'tax', name: 'Income Tax', percentage: 10 },
      { type: 'social', name: 'Social Security', percentage: 18 },
    ],
    benefits: [],
    documents: [],
  }
  return Employee.create({ ...defaults, ...overrides }) as Promise<IEmployee>
}

export async function createTestDepartment(orgId: Types.ObjectId, overrides: Partial<IDepartment> = {}): Promise<IDepartment> {
  const ts = Date.now()
  const defaults = {
    orgId,
    name: `Department ${ts}`,
    code: `DEPT-${ts}`,
    isActive: true,
  }
  return Department.create({ ...defaults, ...overrides }) as Promise<IDepartment>
}

export async function createTestLead(orgId: Types.ObjectId, overrides: Partial<ILead> = {}): Promise<ILead> {
  const ts = Date.now()
  const defaults = {
    orgId,
    source: 'website',
    status: 'new',
    companyName: `Lead Company ${ts}`,
    contactName: `Lead Contact ${ts}`,
    email: `lead-${ts}@test.com`,
    estimatedValue: 10000,
    currency: 'EUR',
    assignedTo: objectId(),
  }
  return Lead.create({ ...defaults, ...overrides }) as Promise<ILead>
}

export async function createTestPipeline(orgId: Types.ObjectId, overrides: Partial<IPipeline> = {}): Promise<IPipeline> {
  const ts = Date.now()
  const defaults = {
    orgId,
    name: `Sales Pipeline ${ts}`,
    stages: [
      { name: 'Prospecting', order: 1, probability: 10, color: '#E3F2FD' },
      { name: 'Qualification', order: 2, probability: 25, color: '#BBDEFB' },
      { name: 'Proposal', order: 3, probability: 50, color: '#90CAF9' },
      { name: 'Negotiation', order: 4, probability: 75, color: '#64B5F6' },
      { name: 'Closed Won', order: 5, probability: 100, color: '#42A5F5' },
    ],
    isDefault: true,
    isActive: true,
  }
  return Pipeline.create({ ...defaults, ...overrides }) as Promise<IPipeline>
}

export async function createTestDeal(
  orgId: Types.ObjectId,
  contactId: Types.ObjectId,
  pipelineId: Types.ObjectId,
  overrides: Partial<IDeal> = {},
): Promise<IDeal> {
  const ts = Date.now()
  const defaults = {
    orgId,
    name: `Deal ${ts}`,
    contactId,
    stage: 'Prospecting',
    pipelineId,
    value: 25000,
    currency: 'EUR',
    probability: 10,
    expectedCloseDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    status: 'open',
    assignedTo: objectId(),
  }
  return Deal.create({ ...defaults, ...overrides }) as Promise<IDeal>
}

export async function createTestFiscalYear(orgId: Types.ObjectId, overrides: Partial<IFiscalYear> = {}): Promise<IFiscalYear> {
  const year = new Date().getFullYear()
  const defaults = {
    orgId,
    name: `FY ${year}`,
    startDate: new Date(`${year}-01-01`),
    endDate: new Date(`${year}-12-31`),
    status: 'open',
  }
  return FiscalYear.create({ ...defaults, ...overrides }) as Promise<IFiscalYear>
}

export async function createTestFiscalPeriod(
  orgId: Types.ObjectId,
  fiscalYearId: Types.ObjectId,
  overrides: Partial<IFiscalPeriod> = {},
): Promise<IFiscalPeriod> {
  const defaults = {
    orgId,
    fiscalYearId,
    name: 'January',
    number: 1,
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31'),
    status: 'open',
  }
  return FiscalPeriod.create({ ...defaults, ...overrides }) as Promise<IFiscalPeriod>
}

export async function createTestJournalEntry(
  orgId: Types.ObjectId,
  fiscalPeriodId: Types.ObjectId,
  createdBy: Types.ObjectId,
  overrides: Partial<IJournalEntry> = {},
): Promise<IJournalEntry> {
  const ts = Date.now()
  const defaults = {
    orgId,
    entryNumber: `JE-${ts}`,
    date: new Date(),
    fiscalPeriodId,
    description: 'Test journal entry',
    type: 'standard',
    status: 'draft',
    lines: [
      {
        accountId: objectId(),
        debit: 1000,
        credit: 0,
        currency: 'EUR',
        exchangeRate: 1,
        baseDebit: 1000,
        baseCredit: 0,
      },
      {
        accountId: objectId(),
        debit: 0,
        credit: 1000,
        currency: 'EUR',
        exchangeRate: 1,
        baseDebit: 0,
        baseCredit: 1000,
      },
    ],
    totalDebit: 1000,
    totalCredit: 1000,
    attachments: [],
    createdBy,
  }
  return JournalEntry.create({ ...defaults, ...overrides }) as Promise<IJournalEntry>
}

export async function createTestStockLevel(
  orgId: Types.ObjectId,
  productId: Types.ObjectId,
  warehouseId: Types.ObjectId,
  overrides: Partial<IStockLevel> = {},
): Promise<IStockLevel> {
  const defaults = {
    orgId,
    productId,
    warehouseId,
    quantity: 100,
    reservedQuantity: 0,
    availableQuantity: 100,
    avgCost: 50,
  }
  return StockLevel.create({ ...defaults, ...overrides }) as Promise<IStockLevel>
}

export async function createTestPayrollRun(
  orgId: Types.ObjectId,
  createdBy: Types.ObjectId,
  overrides: Partial<IPayrollRun> = {},
): Promise<IPayrollRun> {
  const now = new Date()
  const defaults = {
    orgId,
    name: `Payroll ${now.toISOString().slice(0, 7)}`,
    period: {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 0),
    },
    status: 'draft',
    currency: 'EUR',
    items: [],
    totals: {
      grossPay: 0,
      totalDeductions: 0,
      netPay: 0,
      totalEmployerCost: 0,
      employeeCount: 0,
    },
    createdBy,
  }
  return PayrollRun.create({ ...defaults, ...overrides }) as Promise<IPayrollRun>
}

export async function createTestActivity(
  orgId: Types.ObjectId,
  assignedTo: Types.ObjectId,
  overrides: Partial<IActivity> = {},
): Promise<IActivity> {
  const defaults = {
    orgId,
    type: 'call',
    subject: 'Follow-up call',
    assignedTo,
    status: 'pending',
    priority: 'medium',
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }
  return Activity.create({ ...defaults, ...overrides }) as Promise<IActivity>
}

export async function createTestLeaveType(orgId: Types.ObjectId, overrides: Partial<ILeaveType> = {}): Promise<ILeaveType> {
  const ts = Date.now()
  const defaults = {
    orgId,
    name: `Annual Leave ${ts}`,
    code: `AL-${ts}`,
    defaultDays: 20,
    isPaid: true,
    requiresApproval: true,
    color: '#4CAF50',
    isActive: true,
  }
  return LeaveType.create({ ...defaults, ...overrides }) as Promise<ILeaveType>
}

export async function createTestLeaveBalance(
  orgId: Types.ObjectId,
  employeeId: Types.ObjectId,
  leaveTypeId: Types.ObjectId,
  overrides: Partial<ILeaveBalance> = {},
): Promise<ILeaveBalance> {
  const defaults = {
    orgId,
    employeeId,
    leaveTypeId,
    year: new Date().getFullYear(),
    entitled: 20,
    taken: 0,
    pending: 0,
    remaining: 20,
    carriedOver: 0,
  }
  return LeaveBalance.create({ ...defaults, ...overrides }) as Promise<ILeaveBalance>
}

export async function createTestLeaveRequest(
  orgId: Types.ObjectId,
  employeeId: Types.ObjectId,
  leaveTypeId: Types.ObjectId,
  overrides: Partial<ILeaveRequest> = {},
): Promise<ILeaveRequest> {
  const now = new Date()
  const start = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000)
  const defaults = {
    orgId,
    employeeId,
    leaveTypeId,
    startDate: start,
    endDate: end,
    days: 5,
    halfDay: false,
    reason: 'Vacation',
    status: 'pending',
    attachments: [],
  }
  return LeaveRequest.create({ ...defaults, ...overrides }) as Promise<ILeaveRequest>
}

export async function createTestConstructionProject(
  orgId: Types.ObjectId,
  overrides: Partial<IConstructionProject> = {},
): Promise<IConstructionProject> {
  const ts = Date.now()
  const now = new Date()
  const endDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000)
  const defaults = {
    orgId,
    projectNumber: `CP-${ts}`,
    name: `Construction Project ${ts}`,
    clientId: objectId(),
    address: {
      street: '10 Building Ave',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    },
    status: 'planning',
    startDate: now,
    expectedEndDate: endDate,
    budget: {
      estimated: 500000,
      currency: 'EUR',
      approved: 500000,
      spent: 0,
      remaining: 500000,
    },
    phases: [],
    team: [],
    materials: [],
    totalInvoiced: 0,
    totalPaid: 0,
    margin: 0,
    documents: [],
    createdBy: objectId(),
  }
  return ConstructionProject.create({ ...defaults, ...overrides }) as Promise<IConstructionProject>
}

export async function createTestBOM(
  orgId: Types.ObjectId,
  productId: Types.ObjectId,
  overrides: Partial<IBillOfMaterials> = {},
): Promise<IBillOfMaterials> {
  const ts = Date.now()
  const defaults = {
    orgId,
    productId,
    name: `BOM ${ts}`,
    version: '1.0',
    status: 'draft',
    materials: [],
    laborHours: 8,
    laborCostPerHour: 25,
    overheadCost: 50,
    totalMaterialCost: 0,
    totalCost: 250,
  }
  return BillOfMaterials.create({ ...defaults, ...overrides }) as Promise<IBillOfMaterials>
}

export async function createTestProductionOrder(
  orgId: Types.ObjectId,
  bomId: Types.ObjectId,
  productId: Types.ObjectId,
  warehouseId: Types.ObjectId,
  overrides: Partial<IProductionOrder> = {},
): Promise<IProductionOrder> {
  const ts = Date.now()
  const now = new Date()
  const defaults = {
    orgId,
    orderNumber: `PO-${ts}`,
    bomId,
    productId,
    quantity: 100,
    warehouseId,
    outputWarehouseId: overrides.outputWarehouseId || warehouseId,
    status: 'planned',
    priority: 'normal',
    plannedStartDate: now,
    plannedEndDate: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    stages: [],
    materialsConsumed: [],
    quantityProduced: 0,
    quantityDefective: 0,
    totalCost: 0,
    costPerUnit: 0,
    createdBy: objectId(),
  }
  return ProductionOrder.create({ ...defaults, ...overrides }) as Promise<IProductionOrder>
}

export async function createTestPOSSession(
  orgId: Types.ObjectId,
  warehouseId: Types.ObjectId,
  cashierId: Types.ObjectId,
  overrides: Partial<IPOSSession> = {},
): Promise<IPOSSession> {
  const ts = Date.now()
  const defaults = {
    orgId,
    warehouseId,
    cashierId,
    sessionNumber: `POS-${ts}`,
    openedAt: new Date(),
    status: 'open',
    openingBalance: 500,
    currency: 'EUR',
    totalSales: 0,
    totalReturns: 0,
    totalCash: 0,
    totalCard: 0,
    transactionCount: 0,
  }
  return POSSession.create({ ...defaults, ...overrides }) as Promise<IPOSSession>
}

export async function createTestStockMovement(
  orgId: Types.ObjectId,
  overrides: Partial<IStockMovement> = {},
): Promise<IStockMovement> {
  const ts = Date.now()
  const defaults = {
    orgId,
    movementNumber: `SM-${ts}`,
    type: 'receipt',
    status: 'draft',
    date: new Date(),
    lines: [],
    totalAmount: 0,
    createdBy: objectId(),
  }
  return StockMovement.create({ ...defaults, ...overrides }) as Promise<IStockMovement>
}

export async function createTestFixedAsset(
  orgId: Types.ObjectId,
  overrides: Partial<IFixedAsset> = {},
): Promise<IFixedAsset> {
  const ts = Date.now()
  const defaults = {
    orgId,
    code: `FA-${ts}`,
    name: `Fixed Asset ${ts}`,
    category: 'Equipment',
    accountId: objectId(),
    depreciationAccountId: objectId(),
    accumulatedDepAccountId: objectId(),
    purchaseDate: new Date(),
    purchasePrice: 10000,
    currency: 'EUR',
    salvageValue: 1000,
    usefulLifeMonths: 60,
    depreciationMethod: 'straight_line',
    currentValue: 10000,
    status: 'active',
    depreciationSchedule: [],
  }
  return FixedAsset.create({ ...defaults, ...overrides }) as Promise<IFixedAsset>
}

export async function createTestBankAccount(
  orgId: Types.ObjectId,
  overrides: Partial<IBankAccount> = {},
): Promise<IBankAccount> {
  const ts = Date.now()
  const seq = ++bankAccountCounter
  const defaults = {
    orgId,
    name: `Business Account ${ts}-${seq}`,
    bankName: 'Deutsche Bank',
    accountNumber: `DE${ts}${seq}`,
    iban: `DE89370400440532013${seq}${ts % 1000}`,
    currency: 'EUR',
    accountId: objectId(),
    balance: 0,
    isDefault: false,
    isActive: true,
  }
  return BankAccount.create({ ...defaults, ...overrides }) as Promise<IBankAccount>
}

export async function createTestBusinessTrip(
  orgId: Types.ObjectId,
  employeeId: Types.ObjectId,
  overrides: Partial<IBusinessTrip> = {},
): Promise<IBusinessTrip> {
  const now = new Date()
  const defaults = {
    orgId,
    employeeId,
    destination: 'Munich',
    purpose: 'Client meeting',
    startDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
    status: 'requested',
    expenses: [],
    totalExpenses: 0,
  }
  return BusinessTrip.create({ ...defaults, ...overrides }) as Promise<IBusinessTrip>
}

export async function createTestTimesheet(
  orgId: Types.ObjectId,
  employeeId: Types.ObjectId,
  overrides: Partial<ITimesheet> = {},
): Promise<ITimesheet> {
  const defaults = {
    orgId,
    employeeId,
    date: new Date(),
    hoursWorked: 8,
    overtimeHours: 0,
    type: 'regular',
    status: 'submitted',
  }
  return Timesheet.create({ ...defaults, ...overrides }) as Promise<ITimesheet>
}

export async function createTestPOSTransaction(
  orgId: Types.ObjectId,
  sessionId: Types.ObjectId,
  createdBy: Types.ObjectId,
  overrides: Partial<IPOSTransaction> = {},
): Promise<IPOSTransaction> {
  const ts = Date.now()
  const defaults = {
    orgId,
    sessionId,
    transactionNumber: `TXN-${ts}`,
    type: 'sale',
    lines: [],
    subtotal: 100,
    discountTotal: 0,
    taxTotal: 18,
    total: 118,
    payments: [{ method: 'cash', amount: 118 }],
    changeDue: 0,
    createdBy,
  }
  return POSTransaction.create({ ...defaults, ...overrides }) as Promise<IPOSTransaction>
}

export async function createTestExchangeRate(orgId: Types.ObjectId, overrides: Partial<IExchangeRate> = {}): Promise<IExchangeRate> {
  const defaults = {
    orgId,
    fromCurrency: 'USD',
    toCurrency: 'EUR',
    rate: 0.92,
    source: 'manual',
    date: new Date(),
  }
  return ExchangeRate.create({ ...defaults, ...overrides }) as Promise<IExchangeRate>
}

export async function createTestBankReconciliation(
  orgId: Types.ObjectId,
  bankAccountId: Types.ObjectId,
  overrides: Partial<IBankReconciliation> = {},
): Promise<IBankReconciliation> {
  const defaults = {
    orgId,
    bankAccountId,
    statementDate: new Date(),
    statementBalance: 10000,
    bookBalance: 10000,
    difference: 0,
    status: 'draft',
    items: [],
  }
  return BankReconciliation.create({ ...defaults, ...overrides }) as Promise<IBankReconciliation>
}

export async function createTestTaxReturn(orgId: Types.ObjectId, overrides: Partial<ITaxReturn> = {}): Promise<ITaxReturn> {
  const now = new Date()
  const defaults = {
    orgId,
    type: 'vat',
    period: { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 0) },
    status: 'draft',
    totalTax: 0,
    totalInput: 0,
    totalOutput: 0,
    netPayable: 0,
    lines: [],
  }
  return TaxReturn.create({ ...defaults, ...overrides }) as Promise<ITaxReturn>
}

export async function createTestPaymentOrder(
  orgId: Types.ObjectId,
  contactId: Types.ObjectId,
  bankAccountId: Types.ObjectId,
  overrides: Partial<IPaymentOrder> = {},
): Promise<IPaymentOrder> {
  const ts = Date.now()
  const defaults = {
    orgId,
    orderNumber: `PO-${ts}`,
    type: 'payment',
    contactId,
    bankAccountId,
    amount: 1000,
    currency: 'EUR',
    exchangeRate: 1,
    status: 'draft',
    createdBy: objectId(),
  }
  return PaymentOrder.create({ ...defaults, ...overrides }) as Promise<IPaymentOrder>
}

export async function createTestCashOrder(orgId: Types.ObjectId, overrides: Partial<ICashOrder> = {}): Promise<ICashOrder> {
  const ts = Date.now()
  const defaults = {
    orgId,
    orderNumber: `CO-${ts}`,
    type: 'receipt',
    amount: 500,
    currency: 'EUR',
    description: 'Test cash order',
    accountId: objectId(),
    counterAccountId: objectId(),
    createdBy: objectId(),
  }
  return CashOrder.create({ ...defaults, ...overrides }) as Promise<ICashOrder>
}

export async function createTestInventoryCount(
  orgId: Types.ObjectId,
  warehouseId: Types.ObjectId,
  createdBy: Types.ObjectId,
  overrides: Partial<IInventoryCount> = {},
): Promise<IInventoryCount> {
  const ts = Date.now()
  const defaults = {
    orgId,
    countNumber: `IC-${ts}`,
    warehouseId,
    date: new Date(),
    status: 'in_progress',
    type: 'full',
    lines: [],
    createdBy,
  }
  return InventoryCount.create({ ...defaults, ...overrides }) as Promise<IInventoryCount>
}

export async function createTestPriceList(orgId: Types.ObjectId, overrides: Partial<IPriceList> = {}): Promise<IPriceList> {
  const ts = Date.now()
  const defaults = {
    orgId,
    name: `Price List ${ts}`,
    currency: 'EUR',
    isDefault: false,
    isActive: true,
    items: [],
  }
  return PriceList.create({ ...defaults, ...overrides }) as Promise<IPriceList>
}

export async function createTestPayslip(
  orgId: Types.ObjectId,
  payrollRunId: Types.ObjectId,
  employeeId: Types.ObjectId,
  overrides: Partial<IPayslip> = {},
): Promise<IPayslip> {
  const now = new Date()
  const defaults = {
    orgId,
    payrollRunId,
    employeeId,
    period: { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 0) },
    grossPay: 5000,
    totalDeductions: 1500,
    netPay: 3500,
    paymentMethod: 'bank_transfer',
    status: 'generated',
    earnings: [],
    deductions: [],
  }
  return Payslip.create({ ...defaults, ...overrides }) as Promise<IPayslip>
}

export async function createTestEmployeeDocument(
  orgId: Types.ObjectId,
  employeeId: Types.ObjectId,
  overrides: Partial<IEmployeeDocument> = {},
): Promise<IEmployeeDocument> {
  const ts = Date.now()
  const defaults = {
    orgId,
    employeeId,
    type: 'contract',
    title: `Document ${ts}`,
    fileId: objectId(),
    createdBy: objectId(),
  }
  return EmployeeDocument.create({ ...defaults, ...overrides }) as Promise<IEmployeeDocument>
}

export async function createTestNotification(
  orgId: Types.ObjectId,
  userId: Types.ObjectId,
  overrides: Partial<INotification> = {},
): Promise<INotification> {
  const ts = Date.now()
  const defaults = {
    orgId,
    userId,
    type: 'info',
    title: `Notification ${ts}`,
    message: 'Test notification message',
    module: 'system',
    read: false,
  }
  return Notification.create({ ...defaults, ...overrides }) as Promise<INotification>
}

export async function createTestInvite(
  orgId: Types.ObjectId,
  inviterId: Types.ObjectId,
  overrides: Partial<IInvite> = {},
): Promise<IInvite> {
  const ts = Date.now()
  const defaults = {
    orgId,
    inviterId,
    code: `INV-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    useCount: 0,
    status: 'active',
    assignRole: 'member',
  }
  return Invite.create({ ...defaults, ...overrides }) as Promise<IInvite>
}
