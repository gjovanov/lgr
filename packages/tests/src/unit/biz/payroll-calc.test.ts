import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { createTestOrg, createTestEmployee, createTestPayrollRun, createTestUser } from '../../helpers/factories'
import { calculatePayroll, approvePayroll } from 'services/biz/payroll.service'
import { PayrollRun, Payslip } from 'db/models'
import type { IOrg, IPayrollRun } from 'db/models'
import { mongoose } from 'db/connection'
const { Types } = mongoose

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('calculatePayroll', () => {
  it('should calculate gross pay from employee baseSalary', async () => {
    const org = await createTestOrg({ slug: 'calc-gross' })
    const emp = await createTestEmployee(org._id, {
      salary: { baseSalary: 6000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    expect(result.items).toHaveLength(1)
    expect(result.items[0].baseSalary).toBe(6000)
    expect(result.items[0].grossPay).toBe(6000)
  })

  it('should apply percentage deductions correctly', async () => {
    const org = await createTestOrg({ slug: 'calc-pct-ded' })
    const emp = await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [
        { type: 'tax', name: 'Income Tax', percentage: 10 },
      ],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    // 10% of 5000 = 500
    expect(item.deductions).toHaveLength(1)
    expect(item.deductions[0].amount).toBe(500)
    expect(item.deductions[0].type).toBe('tax')
    expect(item.deductions[0].name).toBe('Income Tax')
  })

  it('should apply fixed amount deductions', async () => {
    const org = await createTestOrg({ slug: 'calc-fixed-ded' })
    const emp = await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [
        { type: 'other', name: 'Union Dues', amount: 150 },
      ],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    expect(item.deductions).toHaveLength(1)
    expect(item.deductions[0].amount).toBe(150)
    expect(item.deductions[0].name).toBe('Union Dues')
  })

  it('should calculate net pay as gross minus deductions', async () => {
    const org = await createTestOrg({ slug: 'calc-net' })
    const emp = await createTestEmployee(org._id, {
      salary: { baseSalary: 4000, currency: 'EUR', frequency: 'monthly' },
      deductions: [
        { type: 'tax', name: 'Income Tax', percentage: 10 },
        { type: 'other', name: 'Parking', amount: 50 },
      ],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    // gross = 4000, deductions = 400 (10%) + 50 (fixed) = 450
    expect(item.grossPay).toBe(4000)
    expect(item.totalDeductions).toBe(450)
    expect(item.netPay).toBe(3550)
  })

  it('should calculate employer contributions using org payroll rates', async () => {
    const org = await createTestOrg({
      slug: 'calc-employer',
      settings: {
        baseCurrency: 'EUR',
        fiscalYearStart: 1,
        dateFormat: 'DD.MM.YYYY',
        timezone: 'Europe/Berlin',
        locale: 'en',
        taxConfig: {
          vatEnabled: true,
          defaultVatRate: 18,
          vatRates: [{ name: 'Standard', rate: 18 }],
          taxIdLabel: 'VAT ID',
        },
        payroll: {
          payFrequency: 'monthly',
          socialSecurityRate: 20,
          healthInsuranceRate: 10,
          pensionRate: 15,
        },
        modules: [],
      },
    } as any)
    const emp = await createTestEmployee(org._id, {
      salary: { baseSalary: 10000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    const contributions = item.employerContributions

    expect(contributions).toHaveLength(3)
    const ssContrib = contributions.find((c: any) => c.type === 'social_security')
    const hiContrib = contributions.find((c: any) => c.type === 'health_insurance')
    const penContrib = contributions.find((c: any) => c.type === 'pension')

    // 20% of 10000 = 2000, 10% = 1000, 15% = 1500
    expect(ssContrib!.amount).toBe(2000)
    expect(hiContrib!.amount).toBe(1000)
    expect(penContrib!.amount).toBe(1500)
  })

  it('should calculate totalEmployerCost as grossPay plus employer contributions', async () => {
    const org = await createTestOrg({ slug: 'calc-emp-cost' })
    const emp = await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    // Default rates: socialSecurityRate=18, healthInsuranceRate=7.5, pensionRate=18 => total=43.5%
    // grossPay=5000, employerContribs = 5000*0.435 = 2175
    // totalEmployerCost = 5000 + 2175 = 7175
    const contribSum = item.employerContributions.reduce((s: number, c: any) => s + c.amount, 0)
    expect(item.totalEmployerCost).toBe(item.grossPay + contribSum)
  })

  it('should aggregate totals correctly across all employees', async () => {
    const org = await createTestOrg({ slug: 'calc-totals' })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-A',
      salary: { baseSalary: 3000, currency: 'EUR', frequency: 'monthly' },
      deductions: [{ type: 'tax', name: 'Income Tax', percentage: 10 }],
    })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-B',
      salary: { baseSalary: 7000, currency: 'EUR', frequency: 'monthly' },
      deductions: [{ type: 'tax', name: 'Income Tax', percentage: 10 }],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))

    expect(result.totals.employeeCount).toBe(2)
    expect(result.totals.grossPay).toBe(10000) // 3000 + 7000
    expect(result.totals.totalDeductions).toBe(1000) // 300 + 700
    expect(result.totals.netPay).toBe(9000) // 2700 + 6300
    // totalEmployerCost = sum of each employee's (grossPay + contributions)
    expect(result.totals.totalEmployerCost).toBeGreaterThan(result.totals.grossPay)
  })

  it('should set status to calculated', async () => {
    const org = await createTestOrg({ slug: 'calc-status' })
    await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)
    expect(run.status).toBe('draft')

    const result = await calculatePayroll(String(run._id))
    expect(result.status).toBe('calculated')

    // Verify persisted in DB
    const persisted = await PayrollRun.findById(run._id)
    expect(persisted!.status).toBe('calculated')
  })

  it('should handle multiple employees with different salaries and deductions', async () => {
    const org = await createTestOrg({ slug: 'calc-multi' })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-1',
      salary: { baseSalary: 2000, currency: 'EUR', frequency: 'monthly' },
      deductions: [{ type: 'tax', name: 'Tax', percentage: 5 }],
    })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-2',
      salary: { baseSalary: 8000, currency: 'EUR', frequency: 'monthly' },
      deductions: [
        { type: 'tax', name: 'Tax', percentage: 20 },
        { type: 'other', name: 'Loan', amount: 200 },
      ],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    expect(result.items).toHaveLength(2)

    // emp1: gross=2000, ded=100 (5%), net=1900
    // emp2: gross=8000, ded=1600(20%)+200=1800, net=6200
    expect(result.totals.grossPay).toBe(10000)
    expect(result.totals.totalDeductions).toBe(1900) // 100 + 1800
    expect(result.totals.netPay).toBe(8100) // 1900 + 6200
  })

  it('should only include active employees', async () => {
    const org = await createTestOrg({ slug: 'calc-active' })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-ACTIVE',
      status: 'active',
      salary: { baseSalary: 4000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-TERM',
      status: 'terminated',
      salary: { baseSalary: 6000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-SUSPENDED',
      status: 'suspended',
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    expect(result.items).toHaveLength(1)
    expect(result.totals.employeeCount).toBe(1)
    expect(result.totals.grossPay).toBe(4000)
  })

  it('should handle employee with no deductions', async () => {
    const org = await createTestOrg({ slug: 'calc-no-ded' })
    await createTestEmployee(org._id, {
      salary: { baseSalary: 3000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    expect(item.deductions).toHaveLength(0)
    expect(item.totalDeductions).toBe(0)
    expect(item.netPay).toBe(item.grossPay)
  })

  it('should throw when payroll run does not exist', async () => {
    const fakeId = new Types.ObjectId()
    await expect(calculatePayroll(String(fakeId))).rejects.toThrow('Payroll run not found')
  })

  it('should throw when payroll run is not in draft status', async () => {
    const org = await createTestOrg({ slug: 'calc-not-draft' })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id, { status: 'calculated' })

    await expect(calculatePayroll(String(run._id))).rejects.toThrow('Only draft payroll runs can be calculated')
  })

  it('should filter employer contributions with zero rates', async () => {
    const org = await createTestOrg({
      slug: 'calc-zero-rate',
      settings: {
        baseCurrency: 'EUR',
        fiscalYearStart: 1,
        dateFormat: 'DD.MM.YYYY',
        timezone: 'Europe/Berlin',
        locale: 'en',
        taxConfig: {
          vatEnabled: true,
          defaultVatRate: 18,
          vatRates: [{ name: 'Standard', rate: 18 }],
          taxIdLabel: 'VAT ID',
        },
        payroll: {
          payFrequency: 'monthly',
          socialSecurityRate: 10,
          healthInsuranceRate: 0,
          pensionRate: 0,
        },
        modules: [],
      },
    } as any)
    await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    // Only social_security should be present (healthInsurance=0, pension=0 are filtered)
    expect(item.employerContributions).toHaveLength(1)
    expect(item.employerContributions[0].type).toBe('social_security')
    expect(item.employerContributions[0].amount).toBe(500)
  })

  it('should prefer fixed amount over percentage when deduction has both', async () => {
    const org = await createTestOrg({ slug: 'calc-ded-prio' })
    await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [
        { type: 'other', name: 'Hybrid Ded', amount: 200, percentage: 50 },
      ],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    const result = await calculatePayroll(String(run._id))
    const item = result.items[0]
    // amount takes priority: `ded.amount || (ded.percentage ? ...)`
    expect(item.deductions[0].amount).toBe(200)
  })
})

describe('approvePayroll', () => {
  async function createCalculatedRun() {
    const org = await createTestOrg({ slug: `approve-${Date.now()}` })
    await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [{ type: 'tax', name: 'Income Tax', percentage: 10 }],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)
    const calculated = await calculatePayroll(String(run._id))
    return { org, user, run: calculated }
  }

  it('should change status from calculated to approved', async () => {
    const { run, user } = await createCalculatedRun()

    const result = await approvePayroll(String(run._id), String(user._id))
    expect(result.status).toBe('approved')
  })

  it('should set approvedBy and approvedAt', async () => {
    const { run, user } = await createCalculatedRun()
    const before = new Date()

    const result = await approvePayroll(String(run._id), String(user._id))
    expect(String(result.approvedBy)).toBe(String(user._id))
    expect(result.approvedAt).toBeDefined()
    expect(result.approvedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })

  it('should generate Payslip records for each employee', async () => {
    const org = await createTestOrg({ slug: `approve-slips-${Date.now()}` })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-S1',
      salary: { baseSalary: 4000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    await createTestEmployee(org._id, {
      employeeNumber: 'EMP-S2',
      salary: { baseSalary: 6000, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
    })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)
    const calculated = await calculatePayroll(String(run._id))

    await approvePayroll(String(calculated._id), String(user._id))

    const payslips = await Payslip.find({ payrollRunId: calculated._id })
    expect(payslips).toHaveLength(2)
    payslips.forEach((slip) => {
      expect(String(slip.orgId)).toBe(String(org._id))
      expect(slip.status).toBe('generated')
      expect(slip.paymentMethod).toBe('bank_transfer')
    })
  })

  it('should create payslip with earnings breakdown including base salary', async () => {
    const { run, user } = await createCalculatedRun()

    await approvePayroll(String(run._id), String(user._id))

    const payslips = await Payslip.find({ payrollRunId: run._id })
    expect(payslips).toHaveLength(1)
    const slip = payslips[0]
    const baseSalaryEarning = slip.earnings.find((e) => e.type === 'base_salary')
    expect(baseSalaryEarning).toBeDefined()
    expect(baseSalaryEarning!.description).toBe('Base Salary')
    expect(baseSalaryEarning!.amount).toBe(5000)
  })

  it('should create payslip with deductions breakdown', async () => {
    const { run, user } = await createCalculatedRun()

    await approvePayroll(String(run._id), String(user._id))

    const payslips = await Payslip.find({ payrollRunId: run._id })
    const slip = payslips[0]
    expect(slip.deductions).toHaveLength(1)
    expect(slip.deductions[0].type).toBe('tax')
    expect(slip.deductions[0].description).toBe('Income Tax')
    expect(slip.deductions[0].amount).toBe(500) // 10% of 5000
  })

  it('should reject approval if status is not calculated', async () => {
    const org = await createTestOrg({ slug: 'approve-draft' })
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id) // status = 'draft'

    await expect(
      approvePayroll(String(run._id), String(user._id)),
    ).rejects.toThrow('Only calculated payroll runs can be approved')
  })

  it('should reject approval of already-approved run', async () => {
    const { run, user } = await createCalculatedRun()
    await approvePayroll(String(run._id), String(user._id))

    await expect(
      approvePayroll(String(run._id), String(user._id)),
    ).rejects.toThrow('Only calculated payroll runs can be approved')
  })

  it('should set payslip grossPay, totalDeductions, and netPay correctly', async () => {
    const { run, user } = await createCalculatedRun()

    await approvePayroll(String(run._id), String(user._id))

    const payslips = await Payslip.find({ payrollRunId: run._id })
    const slip = payslips[0]
    expect(slip.grossPay).toBe(5000)
    expect(slip.totalDeductions).toBe(500) // 10% of 5000
    expect(slip.netPay).toBe(4500)
  })

  it('should set payslip yearToDate fields', async () => {
    const { run, user } = await createCalculatedRun()

    await approvePayroll(String(run._id), String(user._id))

    const payslips = await Payslip.find({ payrollRunId: run._id })
    const slip = payslips[0]
    expect(slip.yearToDate).toBeDefined()
    expect(slip.yearToDate.grossPay).toBe(5000)
    expect(slip.yearToDate.totalDeductions).toBe(500)
    expect(slip.yearToDate.netPay).toBe(4500)
  })
})
