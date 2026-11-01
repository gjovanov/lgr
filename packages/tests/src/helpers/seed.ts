import { connectDB, disconnectDB } from 'db/connection'
import { mongoose } from 'db/connection'
import {
  Org, User, Account, FiscalYear, FiscalPeriod, JournalEntry,
  Contact, Invoice, Product, Warehouse, StockLevel,
  Employee, PayrollRun, Payslip, OrgApp, Identity,
} from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, MODULES, APP_IDS } from 'config/constants'
import ExcelJS from 'exceljs'
import path from 'path'
import { existsSync } from 'node:fs'

/**
 * One person per seeded address (multi-org sign-in): an identity linked to every user that carries
 * the address. They chose the seed's password themselves (`passwordSetBy: 'self'`) and their address
 * is verified, so a seeded person can join or found another org without a reset first.
 */
async function seedIdentities(password: string): Promise<number> {
  const users = await User.find({}, { email: 1, firstName: 1, lastName: 1 }).lean()
  const byEmail = new Map<string, typeof users>()
  for (const u of users) {
    const address = u.email.trim().toLowerCase()
    byEmail.set(address, [...(byEmail.get(address) ?? []), u])
  }
  for (const [email, members] of byEmail) {
    const identity = await Identity.create({
      email,
      password,
      passwordSetBy: 'self',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      isActive: true,
      firstName: members[0].firstName,
      lastName: members[0].lastName,
    })
    await User.updateMany({ _id: { $in: members.map(m => m._id) } }, { $set: { identityId: identity._id } })
  }
  return byEmail.size
}

async function readRegalProducts(filePath: string) {
  // The storeAvailability export is gitignored business data — skip gracefully if absent.
  if (!existsSync(filePath)) {
    console.warn(`[seed] Excel not found at ${filePath} — skipping Regal product import.`)
    return []
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.getWorksheet(1)!
  const items: Array<{ name: string; quantity: number; price1: number; price2: number }> = []

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 5) return
    const name = String(row.getCell(1).value || '').trim()
    if (!name || name === 'ОБЩО:' || name === 'Опаковка' || name === 'Всичко') return
    items.push({
      name,
      quantity: Number(row.getCell(3).value) || 0,
      price1: Number(row.getCell(4).value) || 0,
      price2: Number(row.getCell(5).value) || 0,
    })
  })

  return items
}

export async function seed() {
  await connectDB()

  // Cleanup
  const models = [
    Org, User, Account, FiscalYear, FiscalPeriod, JournalEntry,
    Contact, Invoice, Product, Warehouse, StockLevel,
    Employee, PayrollRun, Payslip, OrgApp, Identity,
  ]
  await Promise.all(models.map(m => m.deleteMany({})))

  // ===================================================================
  // ORG 1: Acme Corp
  // ===================================================================
  const org1 = await Org.create({
    name: 'Acme Corp',
    slug: 'acme-corp',
    settings: {
      baseCurrency: 'EUR',
      fiscalYearStart: 1,
      dateFormat: 'DD.MM.YYYY',
      timezone: 'Europe/Berlin',
      locale: 'en',
      taxConfig: {
        vatEnabled: true,
        defaultVatRate: 18,
        vatRates: [{ name: 'Standard', rate: 18 }, { name: 'Reduced', rate: 5 }, { name: 'Zero', rate: 0 }],
        taxIdLabel: 'VAT ID',
      },
      payroll: { payFrequency: 'monthly', socialSecurityRate: 18, healthInsuranceRate: 7.5, pensionRate: 18 },
      modules: [...MODULES],
      // The demo org has no fiscal device: its till sells with nothing to print on.
      cashRegister: { requireConnectedDevice: false },
    },
    subscription: { plan: 'professional', maxUsers: 50 },
  })

  // ── Users (5) ──
  const password = await Bun.password.hash('test123')
  const users1 = await Promise.all([
    User.create({ email: 'admin@acme.com', username: 'admin', password, firstName: 'Admin', lastName: 'User', role: 'admin', orgId: org1._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.admin }),
    User.create({ email: 'accountant@acme.com', username: 'accountant', password, firstName: 'Anna', lastName: 'Smith', role: 'accountant', orgId: org1._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.accountant }),
    User.create({ email: 'hr@acme.com', username: 'hrmanager', password, firstName: 'Helen', lastName: 'Brown', role: 'hr_manager', orgId: org1._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.hr_manager }),
    User.create({ email: 'warehouse@acme.com', username: 'warehouse', password, firstName: 'Walter', lastName: 'Green', role: 'warehouse_manager', orgId: org1._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.warehouse_manager }),
    User.create({ email: 'sales@acme.com', username: 'sales', password, firstName: 'Sarah', lastName: 'Wilson', role: 'sales', orgId: org1._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.sales }),
  ])

  org1.ownerId = users1[0]._id
  await org1.save()

  // ── App Activation (Acme Corp: all 6 apps on professional plan) ──
  const appIds = [...APP_IDS]  // All 13 apps
  await Promise.all(
    appIds.map(appId =>
      OrgApp.create({
        orgId: org1._id,
        appId,
        enabled: true,
        activatedAt: new Date(),
        activatedBy: users1[0]._id,
      }),
    ),
  )

  // ── Chart of Accounts (35 accounts) ──
  const accounts = await Promise.all([
    // Assets
    Account.create({ orgId: org1._id, code: '1000', name: 'Cash', type: 'asset', subType: 'current_asset', isSystem: true, balance: 50000 }),
    Account.create({ orgId: org1._id, code: '1010', name: 'Bank Account - EUR', type: 'asset', subType: 'current_asset', balance: 250000 }),
    Account.create({ orgId: org1._id, code: '1020', name: 'Bank Account - USD', type: 'asset', subType: 'current_asset', balance: 75000 }),
    Account.create({ orgId: org1._id, code: '1100', name: 'Accounts Receivable', type: 'asset', subType: 'current_asset', isSystem: true, balance: 85000 }),
    Account.create({ orgId: org1._id, code: '1200', name: 'Inventory', type: 'asset', subType: 'current_asset', isSystem: true, balance: 120000 }),
    Account.create({ orgId: org1._id, code: '1300', name: 'Prepaid Expenses', type: 'asset', subType: 'current_asset', balance: 15000 }),
    Account.create({ orgId: org1._id, code: '1500', name: 'Equipment', type: 'asset', subType: 'fixed_asset', balance: 200000 }),
    Account.create({ orgId: org1._id, code: '1510', name: 'Vehicles', type: 'asset', subType: 'fixed_asset', balance: 80000 }),
    Account.create({ orgId: org1._id, code: '1520', name: 'Furniture', type: 'asset', subType: 'fixed_asset', balance: 30000 }),
    Account.create({ orgId: org1._id, code: '1550', name: 'Accumulated Depreciation', type: 'asset', subType: 'fixed_asset', balance: -45000 }),
    Account.create({ orgId: org1._id, code: '1600', name: 'Intangible Assets', type: 'asset', subType: 'other_asset', balance: 25000 }),
    // Liabilities
    Account.create({ orgId: org1._id, code: '2000', name: 'Accounts Payable', type: 'liability', subType: 'current_liability', isSystem: true, balance: 45000 }),
    Account.create({ orgId: org1._id, code: '2100', name: 'VAT Payable', type: 'liability', subType: 'current_liability', balance: 12000 }),
    Account.create({ orgId: org1._id, code: '2200', name: 'Salaries Payable', type: 'liability', subType: 'current_liability', balance: 35000 }),
    Account.create({ orgId: org1._id, code: '2300', name: 'Social Security Payable', type: 'liability', subType: 'current_liability', balance: 8000 }),
    Account.create({ orgId: org1._id, code: '2400', name: 'Income Tax Payable', type: 'liability', subType: 'current_liability', balance: 15000 }),
    Account.create({ orgId: org1._id, code: '2500', name: 'Short-Term Loan', type: 'liability', subType: 'current_liability', balance: 50000 }),
    Account.create({ orgId: org1._id, code: '2700', name: 'Long-Term Loan', type: 'liability', subType: 'long_term_liability', balance: 300000 }),
    // Equity
    Account.create({ orgId: org1._id, code: '3000', name: 'Owner Equity', type: 'equity', subType: 'owner_equity', isSystem: true, balance: 200000 }),
    Account.create({ orgId: org1._id, code: '3100', name: 'Retained Earnings', type: 'equity', subType: 'retained_earnings', balance: 150000 }),
    // Revenue
    Account.create({ orgId: org1._id, code: '4000', name: 'Sales Revenue', type: 'revenue', subType: 'operating_revenue', isSystem: true }),
    Account.create({ orgId: org1._id, code: '4100', name: 'Service Revenue', type: 'revenue', subType: 'operating_revenue' }),
    Account.create({ orgId: org1._id, code: '4200', name: 'Interest Income', type: 'revenue', subType: 'other_revenue' }),
    Account.create({ orgId: org1._id, code: '4300', name: 'Foreign Exchange Gains', type: 'revenue', subType: 'other_revenue' }),
    // Expenses
    Account.create({ orgId: org1._id, code: '5000', name: 'Cost of Goods Sold', type: 'expense', subType: 'cost_of_goods_sold', isSystem: true }),
    Account.create({ orgId: org1._id, code: '5100', name: 'Salaries Expense', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5200', name: 'Rent Expense', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5300', name: 'Utilities Expense', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5400', name: 'Office Supplies', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5500', name: 'Depreciation Expense', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5600', name: 'Insurance Expense', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5700', name: 'Marketing Expense', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5800', name: 'Travel Expense', type: 'expense', subType: 'operating_expense' }),
    Account.create({ orgId: org1._id, code: '5900', name: 'Bank Charges', type: 'expense', subType: 'other_expense' }),
    Account.create({ orgId: org1._id, code: '5950', name: 'Foreign Exchange Losses', type: 'expense', subType: 'other_expense' }),
  ])

  // ── Fiscal Years (3) ──
  const fiscalYears = await Promise.all([
    FiscalYear.create({ orgId: org1._id, name: 'FY 2024', startDate: new Date('2024-01-01'), endDate: new Date('2024-12-31'), status: 'closed' }),
    FiscalYear.create({ orgId: org1._id, name: 'FY 2025', startDate: new Date('2025-01-01'), endDate: new Date('2025-12-31'), status: 'open' }),
    FiscalYear.create({ orgId: org1._id, name: 'FY 2026', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), status: 'open' }),
  ])

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const periods: any[] = []
  for (const fy of fiscalYears) {
    const year = fy.startDate.getFullYear()
    for (let i = 0; i < 12; i++) {
      const fp = await FiscalPeriod.create({
        orgId: org1._id,
        fiscalYearId: fy._id,
        name: `${monthNames[i]} ${year}`,
        number: i + 1,
        startDate: new Date(year, i, 1),
        endDate: new Date(year, i + 1, 0),
        status: year < 2025 ? 'closed' : 'open',
      })
      periods.push(fp)
    }
  }

  // ── Contacts (20) ──
  const contactNames = [
    'Alpha Manufacturing', 'Bright Solutions', 'CityTech GmbH', 'Delta Services',
    'EuroTrade AG', 'FastParts Ltd', 'Global Logistics', 'Harbor Supplies',
    'InnoTech Corp', 'Jupiter Electronics', 'Klein & Sons', 'Luxor Imports',
    'Metro Distribution', 'Nordic Wholesale', 'Olympus Engineering',
    'Pacific Trading Co', 'Quality Materials', 'Rhine Industries',
    'Stellar Components', 'TechVision Solutions',
  ]
  const contactTypes = ['customer', 'supplier', 'customer', 'customer', 'both'] as const

  const contacts = await Promise.all(
    contactNames.map((name, i) =>
      Contact.create({
        orgId: org1._id,
        type: contactTypes[i % contactTypes.length],
        companyName: name,
        firstName: 'Contact',
        lastName: `${i + 1}`,
        email: `contact${i + 1}@${name.toLowerCase().replace(/[\s&]/g, '')}.com`,
        phone: `+49-30-${1000000 + i}`,
        addresses: [{
          type: 'billing',
          street: `${100 + i} Business Ave`,
          city: 'Berlin',
          postalCode: `${10115 + i}`,
          country: 'DE',
          isDefault: true,
        }],
        bankDetails: [{
          bankName: 'Deutsche Bank',
          accountNumber: `DE${89370400 + i}`,
          iban: `DE89 3704 0044 0532 0130 ${String(i).padStart(2, '0')}`,
          swift: 'COBADEFFXXX',
          currency: 'EUR',
          isDefault: true,
        }],
        paymentTermsDays: [15, 30, 45, 60][i % 4],
        isActive: true,
      }),
    ),
  )

  // ── Products (50) ──
  const categories = ['Electronics', 'Hardware', 'Office Supplies', 'Raw Materials', 'Finished Goods']
  const products = await Promise.all(
    Array.from({ length: 50 }, (_, i) => {
      const cat = categories[i % categories.length]
      const pType = i < 10 ? 'raw_material' : i < 30 ? 'goods' : i < 40 ? 'finished_product' : 'service'
      return Product.create({
        orgId: org1._id,
        sku: `PRD-${String(i + 1).padStart(4, '0')}`,
        barcode: `978020113${String(i).padStart(4, '0')}`,
        name: `Product ${i + 1} - ${cat}`,
        description: `Description for product ${i + 1}`,
        category: cat,
        type: pType,
        unit: pType === 'service' ? 'hr' : 'pcs',
        purchasePrice: 10 + i * 5,
        sellingPrice: 20 + i * 8,
        currency: 'EUR',
        taxRate: 18,
        trackInventory: pType !== 'service',
        minStockLevel: 10,
        maxStockLevel: 500,
        customPrices: [],
        isActive: true,
      })
    }),
  )

  // ── Warehouses (3) ──
  const warehouses = await Promise.all([
    Warehouse.create({ orgId: org1._id, name: 'Main Warehouse', code: 'WH-01', type: 'warehouse', isDefault: true, isActive: true, address: { street: '1 Industrial Way', city: 'Berlin', postalCode: '10115', country: 'DE' } }),
    Warehouse.create({ orgId: org1._id, name: 'Retail Store', code: 'ST-01', type: 'store', isDefault: false, isActive: true, address: { street: '5 Market St', city: 'Berlin', postalCode: '10117', country: 'DE' } }),
    Warehouse.create({ orgId: org1._id, name: 'Production Floor', code: 'PR-01', type: 'production', isDefault: false, isActive: true, address: { street: '10 Factory Rd', city: 'Berlin', postalCode: '10119', country: 'DE' } }),
  ])

  // ── Stock Levels ──
  const stockLevelPromises: Promise<any>[] = []
  for (let i = 0; i < 40; i++) {
    if (products[i].type === 'service') continue
    for (const wh of warehouses) {
      const qty = Math.floor(Math.random() * 200) + 20
      stockLevelPromises.push(
        StockLevel.create({
          orgId: org1._id,
          productId: products[i]._id,
          warehouseId: wh._id,
          quantity: qty,
          // Nothing is held: a hold is a Reservation, and the seed makes none. The 10 % it used to
          // invent showed on the Products list as „Резервирано" with no reservation behind it, so the
          // list never reconciled with the Reservations list (FR-22.45).
          reservedQuantity: 0,
          availableQuantity: qty,
          avgCost: products[i].purchasePrice,
        }),
      )
    }
  }
  await Promise.all(stockLevelPromises)

  // ── Invoices (20) ──
  const statuses = ['draft', 'sent', 'partially_paid', 'paid', 'overdue'] as const
  const invoices: any[] = []
  for (let i = 0; i < 20; i++) {
    const contact = contacts[i % contacts.length]
    const issueDate = new Date(2025, Math.floor(i / 3), (i % 28) + 1)
    const dueDate = new Date(issueDate.getTime() + contact.paymentTermsDays * 24 * 60 * 60 * 1000)
    const lineCount = (i % 3) + 1
    const lines = []
    let subtotal = 0
    let taxTotal = 0

    for (let j = 0; j < lineCount; j++) {
      const prod = products[(i * 3 + j) % products.length]
      const qty = (j + 1) * 2
      const unitPrice = prod.sellingPrice
      const lineSubtotal = qty * unitPrice
      const taxAmount = Math.round(lineSubtotal * 0.18 * 100) / 100
      subtotal += lineSubtotal
      taxTotal += taxAmount
      lines.push({
        productId: prod._id,
        description: prod.name,
        quantity: qty,
        unit: prod.unit,
        unitPrice,
        discount: 0,
        taxRate: 18,
        taxAmount,
        lineTotal: Math.round((lineSubtotal + taxAmount) * 100) / 100,
      })
    }

    const total = Math.round((subtotal + taxTotal) * 100) / 100
    const status = statuses[i % statuses.length]
    const amountPaid = status === 'paid' ? total : status === 'partially_paid' ? Math.round(total * 0.5 * 100) / 100 : 0

    const inv = await Invoice.create({
      orgId: org1._id,
      invoiceNumber: `INV-2025-${String(i + 1).padStart(4, '0')}`,
      type: 'invoice',
      direction: i % 5 === 0 ? 'incoming' : 'outgoing',
      status,
      contactId: contact._id,
      issueDate,
      dueDate,
      currency: 'EUR',
      exchangeRate: 1,
      lines,
      subtotal: Math.round(subtotal * 100) / 100,
      discountTotal: 0,
      taxTotal: Math.round(taxTotal * 100) / 100,
      total,
      totalBase: total,
      amountPaid,
      amountDue: Math.round((total - amountPaid) * 100) / 100,
      payments: amountPaid > 0 ? [{ date: new Date(issueDate.getTime() + 15 * 24 * 60 * 60 * 1000), amount: amountPaid, method: 'bank_transfer', reference: `PAY-${i + 1}` }] : [],
      billingAddress: {
        street: contact.addresses[0]?.street || '1 Main St',
        city: contact.addresses[0]?.city || 'Berlin',
        postalCode: contact.addresses[0]?.postalCode || '10115',
        country: contact.addresses[0]?.country || 'DE',
      },
      attachments: [],
      createdBy: users1[1]._id,
    })
    invoices.push(inv)
  }

  // ── Journal Entries (30) ──
  const fp2025Jan = periods.find((fp: any) => fp.number === 1 && fp.startDate.getFullYear() === 2025)
  for (let i = 0; i < 30; i++) {
    const date = new Date(2025, Math.floor(i / 5), (i % 28) + 1)
    const amount = 500 + i * 200
    const debitIdx = (i * 2) % accounts.length
    const creditIdx = (i * 2 + 1) % accounts.length

    await JournalEntry.create({
      orgId: org1._id,
      entryNumber: `JE-2025-${String(i + 1).padStart(4, '0')}`,
      date,
      fiscalPeriodId: fp2025Jan._id,
      description: `Journal entry ${i + 1}`,
      type: 'standard',
      status: i < 20 ? 'posted' : 'draft',
      lines: [
        { accountId: accounts[debitIdx]._id, description: `Debit: ${accounts[debitIdx].name}`, debit: amount, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: amount, baseCredit: 0 },
        { accountId: accounts[creditIdx]._id, description: `Credit: ${accounts[creditIdx].name}`, debit: 0, credit: amount, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: amount },
      ],
      totalDebit: amount,
      totalCredit: amount,
      attachments: [],
      createdBy: users1[1]._id,
      postedBy: i < 20 ? users1[1]._id : undefined,
      postedAt: i < 20 ? date : undefined,
    })
  }

  // ── Employees (10) ──
  const empDefs = [
    { firstName: 'Alice', lastName: 'Mueller', dept: 'Engineering', position: 'Senior Developer', salary: 5500 },
    { firstName: 'Bob', lastName: 'Schmidt', dept: 'Engineering', position: 'Developer', salary: 4500 },
    { firstName: 'Clara', lastName: 'Weber', dept: 'Finance', position: 'Senior Accountant', salary: 5000 },
    { firstName: 'David', lastName: 'Fischer', dept: 'Finance', position: 'Accountant', salary: 4000 },
    { firstName: 'Eva', lastName: 'Wagner', dept: 'Sales', position: 'Sales Manager', salary: 5200 },
    { firstName: 'Frank', lastName: 'Becker', dept: 'Sales', position: 'Sales Representative', salary: 3800 },
    { firstName: 'Greta', lastName: 'Hoffmann', dept: 'HR', position: 'HR Specialist', salary: 4200 },
    { firstName: 'Hans', lastName: 'Koch', dept: 'Operations', position: 'Operations Manager', salary: 5300 },
    { firstName: 'Irene', lastName: 'Richter', dept: 'Operations', position: 'Logistics Coordinator', salary: 3900 },
    { firstName: 'Jan', lastName: 'Klein', dept: 'Engineering', position: 'Junior Developer', salary: 3200 },
  ]

  const employees = await Promise.all(
    empDefs.map((def, i) =>
      Employee.create({
        orgId: org1._id,
        employeeNumber: `EMP-${String(i + 1).padStart(3, '0')}`,
        firstName: def.firstName,
        lastName: def.lastName,
        email: `${def.firstName.toLowerCase()}.${def.lastName.toLowerCase()}@acme-corp.com`,
        department: def.dept,
        position: def.position,
        employmentType: 'full_time',
        contractStartDate: new Date('2023-01-01'),
        status: 'active',
        salary: {
          baseSalary: def.salary,
          currency: 'EUR',
          frequency: 'monthly',
          bankName: 'Deutsche Bank',
          iban: `DE89 3704 0044 0532 0130 ${String(i).padStart(2, '0')}`,
        },
        deductions: [
          { type: 'tax', name: 'Income Tax', percentage: 15 + i },
          { type: 'social', name: 'Social Security', percentage: 18 },
          { type: 'health', name: 'Health Insurance', percentage: 7.5 },
        ],
        benefits: [{ type: 'meal', name: 'Meal Allowance', value: 200 }],
        documents: [],
        address: { street: `${10 + i} Employee St`, city: 'Berlin', postalCode: '10115', country: 'DE' },
      }),
    ),
  )

  // ── Payroll Runs (2) with Payslips ──
  for (let month = 0; month < 2; month++) {
    const items = employees.map((emp: any) => {
      const baseSalary = emp.salary.baseSalary
      const grossPay = baseSalary + 200
      const deductions = (emp.deductions || []).map((d: any) => ({
        type: d.type,
        name: d.name,
        amount: Math.round(grossPay * (d.percentage || 0) / 100 * 100) / 100,
      }))
      const totalDeductions = deductions.reduce((s: number, d: any) => s + d.amount, 0)
      const netPay = Math.round((grossPay - totalDeductions) * 100) / 100
      return {
        employeeId: emp._id,
        baseSalary,
        overtimeHours: 0,
        overtimePay: 0,
        bonuses: 0,
        allowances: 200,
        grossPay,
        deductions,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        netPay,
        employerContributions: [
          { type: 'social', name: 'Employer Social Security', amount: Math.round(grossPay * 0.18 * 100) / 100 },
          { type: 'health', name: 'Employer Health', amount: Math.round(grossPay * 0.075 * 100) / 100 },
        ],
        totalEmployerCost: Math.round(grossPay * 0.255 * 100) / 100,
      }
    })

    const totals = {
      grossPay: items.reduce((s, i) => s + i.grossPay, 0),
      totalDeductions: items.reduce((s, i) => s + i.totalDeductions, 0),
      netPay: items.reduce((s, i) => s + i.netPay, 0),
      totalEmployerCost: items.reduce((s, i) => s + i.totalEmployerCost, 0),
      employeeCount: items.length,
    }

    const pr = await PayrollRun.create({
      orgId: org1._id,
      name: `Payroll 2025-${String(month + 1).padStart(2, '0')}`,
      period: { from: new Date(2025, month, 1), to: new Date(2025, month + 1, 0) },
      status: month === 0 ? 'paid' : 'calculated',
      currency: 'EUR',
      items,
      totals,
      createdBy: users1[2]._id,
    })

    for (const item of items) {
      await Payslip.create({
        orgId: org1._id,
        payrollRunId: pr._id,
        employeeId: item.employeeId,
        period: { from: pr.period.from, to: pr.period.to },
        earnings: [
          { type: 'base', description: 'Base Salary', amount: item.baseSalary },
          { type: 'allowance', description: 'Meal Allowance', amount: 200 },
        ],
        deductions: item.deductions.map((d: any) => ({ type: d.type, description: d.name, amount: d.amount })),
        grossPay: item.grossPay,
        totalDeductions: item.totalDeductions,
        netPay: item.netPay,
        yearToDate: {
          grossPay: item.grossPay * (month + 1),
          totalDeductions: item.totalDeductions * (month + 1),
          netPay: item.netPay * (month + 1),
        },
        paymentMethod: 'bank_transfer',
        status: month === 0 ? 'paid' : 'generated',
      })
    }
  }

  // ===================================================================
  // ORG 2: Beta Inc (for multi-tenancy testing)
  // ===================================================================
  const org2 = await Org.create({
    name: 'Beta Inc',
    slug: 'beta-inc',
    settings: {
      baseCurrency: 'USD',
      fiscalYearStart: 1,
      dateFormat: 'MM/DD/YYYY',
      timezone: 'America/New_York',
      locale: 'en',
      taxConfig: { vatEnabled: false, defaultVatRate: 0, vatRates: [], taxIdLabel: 'EIN' },
      payroll: { payFrequency: 'biweekly', socialSecurityRate: 6.2, healthInsuranceRate: 1.45, pensionRate: 0 },
      modules: [...MODULES],
      cashRegister: { requireConnectedDevice: false },
    },
    subscription: { plan: 'starter', maxUsers: 10 },
  })

  const betaUsers = await Promise.all([
    User.create({ email: 'admin@beta.com', username: 'admin', password, firstName: 'Beta', lastName: 'Admin', role: 'admin', orgId: org2._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.admin }),
    User.create({ email: 'accountant@beta.com', username: 'accountant', password, firstName: 'Beth', lastName: 'Jones', role: 'accountant', orgId: org2._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.accountant }),
    User.create({ email: 'hr@beta.com', username: 'hrmanager', password, firstName: 'Harry', lastName: 'Lee', role: 'hr_manager', orgId: org2._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.hr_manager }),
    User.create({ email: 'warehouse@beta.com', username: 'warehouse', password, firstName: 'Wayne', lastName: 'Patel', role: 'warehouse_manager', orgId: org2._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.warehouse_manager }),
    User.create({ email: 'sales@beta.com', username: 'sales', password, firstName: 'Samantha', lastName: 'Nguyen', role: 'sales', orgId: org2._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.sales }),
  ])

  org2.ownerId = betaUsers[0]._id
  await org2.save()

  // ── App Activation (Beta Inc: all 7 apps — freemium model) ──
  await Promise.all(
    appIds.map(appId =>
      OrgApp.create({
        orgId: org2._id,
        appId,
        enabled: true,
        activatedAt: new Date(),
        activatedBy: betaUsers[0]._id,
      }),
    ),
  )

  // ===================================================================
  // ORG 3: Regal (Bulgarian org)
  // ===================================================================
  const org3 = await Org.create({
    name: 'Regal',
    slug: 'regal',
    settings: {
      baseCurrency: 'BGN',
      fiscalYearStart: 1,
      dateFormat: 'DD.MM.YYYY',
      timezone: 'Europe/Sofia',
      locale: 'bg',
      taxConfig: {
        vatEnabled: true,
        defaultVatRate: 20,
        vatRates: [{ name: 'Standard', rate: 20 }, { name: 'Reduced', rate: 9 }, { name: 'Zero', rate: 0 }],
        taxIdLabel: 'ЕИК',
      },
      payroll: { payFrequency: 'monthly', socialSecurityRate: 24.7, healthInsuranceRate: 8, pensionRate: 5 },
      modules: [...MODULES],
      cashRegister: { requireConnectedDevice: false },
    },
    subscription: { plan: 'professional', maxUsers: 50 },
  })

  // The dev seed's one password (`test123`, above), like every other seeded user. These two used
  // to carry passwords shaped like real people's, removed from the repo on 2026-10-05.
  const regalUser = await User.create({
    email: 'rdodova@gmail.com',
    username: 'rdodova',
    password,
    firstName: 'Rozalina',
    lastName: 'Dodova',
    role: 'admin',
    orgId: org3._id,
    isActive: true,
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
  })

  await User.create({
    email: 'ddodova@gmail.com',
    username: 'ddodova',
    password,
    firstName: 'Daniela',
    lastName: 'Dodova',
    role: 'admin',
    orgId: org3._id,
    isActive: true,
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
  })

  org3.ownerId = regalUser._id
  await org3.save()

  // ── App Activation (Regal: all 7 apps on professional plan) ──
  await Promise.all(
    appIds.map(appId =>
      OrgApp.create({
        orgId: org3._id,
        appId,
        enabled: true,
        activatedAt: new Date(),
        activatedBy: regalUser._id,
      }),
    ),
  )

  const regalWarehouses = await Promise.all([
    Warehouse.create({ orgId: org3._id, name: 'Sofia', code: 'sof', type: 'warehouse', isDefault: true, isActive: true, address: { street: '1 Vitosha Blvd', city: 'Sofia', postalCode: '1000', country: 'BG' } }),
    Warehouse.create({ orgId: org3._id, name: 'Pazardzhik', code: 'paz', type: 'warehouse', isDefault: false, isActive: true, address: { street: '5 Bulgaria Blvd', city: 'Pazardzhik', postalCode: '4400', country: 'BG' } }),
  ])

  // ── Import products from Excel ──
  const excelPath = path.resolve(import.meta.dir, '../../../../storeAvailability_20260720_113402.xlsx')
  const regalItems = await readRegalProducts(excelPath)

  const regalProductDocs = regalItems.map((item, i) => ({
    orgId: org3._id,
    sku: `RGL-${String(i + 1).padStart(5, '0')}`,
    name: item.name,
    category: 'General',
    type: 'goods' as const,
    unit: 'pcs',
    purchasePrice: item.price1,
    sellingPrice: item.price2,
    currency: 'BGN',
    taxRate: 20,
    trackInventory: true,
    customPrices: [],
    isActive: true,
  }))

  const regalProducts = await Product.insertMany(regalProductDocs)

  const sofiaWarehouse = regalWarehouses[0]
  const stockDocs = regalProducts.map((prod, i) => ({
    orgId: org3._id,
    productId: prod._id,
    warehouseId: sofiaWarehouse._id,
    quantity: Math.max(regalItems[i].quantity, 0),
    reservedQuantity: 0,
    availableQuantity: Math.max(regalItems[i].quantity, 0),
    avgCost: regalItems[i].price1,
  }))

  await StockLevel.insertMany(stockDocs)

  // ── People (multi-org sign-in) ──
  // One person works in BOTH demo orgs, which is what the org switcher is exercised with. Every
  // other seeded user is a person of their own.
  await User.create({ email: 'multi@lgr.test', username: 'multi', password, firstName: 'Mila', lastName: 'Multi', role: 'manager', orgId: org1._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.manager })
  await User.create({ email: 'multi@lgr.test', username: 'multi', password, firstName: 'Mila', lastName: 'Multi', role: 'accountant', orgId: org2._id, isActive: true, permissions: DEFAULT_ROLE_PERMISSIONS.accountant })
  const people = await seedIdentities(password)

  console.log('Seed completed successfully!')
  console.log(`  Acme Corp (acme-corp): admin/test123`)
  console.log(`  Beta Inc (beta-inc): admin/test123`)
  console.log(`  Regal (regal): rdodova/test123, ddodova/test123`)
  console.log(`  ${people} people; multi@lgr.test/test123 works in both acme-corp (manager) and beta-inc (accountant)`)
  console.log(`  ${accounts.length} accounts, ${contacts.length} contacts, ${products.length} Acme products`)
  console.log(`  ${regalProducts.length} Regal products (from Excel)`)
  console.log(`  ${employees.length} employees, ${invoices.length} invoices, 30 journal entries`)
}

if (import.meta.main) {
  await seed()
  await disconnectDB()
  process.exit(0)
}
