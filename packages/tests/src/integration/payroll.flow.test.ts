import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestEmployee, createTestPayrollRun, createTestTimesheet, createTestPayslip } from '../helpers/factories'
import { Payslip, Employee, PayrollRun, Timesheet } from 'db/models'
import { calculatePayroll, approvePayroll } from 'services/biz/payroll.service'
import { paginateQuery } from 'services/utils/pagination'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Payroll Flow', () => {
  it('should calculate payroll for active employees', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    await createTestEmployee(org._id, { salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' } })
    await createTestEmployee(org._id, { salary: { baseSalary: 4000, currency: 'EUR', frequency: 'monthly' } })

    const run = await createTestPayrollRun(org._id, user._id)
    const calculated = await calculatePayroll(String(run._id))

    expect(calculated.status).toBe('calculated')
    expect(calculated.items).toHaveLength(2)
    expect(calculated.totals.employeeCount).toBe(2)
    expect(calculated.totals.grossPay).toBe(9000) // 5000 + 4000
    expect(calculated.totals.netPay).toBeLessThan(calculated.totals.grossPay)
    expect(calculated.totals.totalDeductions).toBeGreaterThan(0)
  })

  it('should apply employee deductions correctly', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    await createTestEmployee(org._id, {
      salary: { baseSalary: 10000, currency: 'EUR', frequency: 'monthly' },
      deductions: [
        { type: 'tax', name: 'Income Tax', percentage: 20 },
        { type: 'social', name: 'Social Security', percentage: 10 },
      ],
    })

    const run = await createTestPayrollRun(org._id, user._id)
    const calculated = await calculatePayroll(String(run._id))

    const item = calculated.items[0]
    expect(item.grossPay).toBe(10000)
    expect(item.totalDeductions).toBe(3000) // 20% + 10% of 10000
    expect(item.netPay).toBe(7000)
  })

  it('should approve payroll and generate payslips', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    const emp1 = await createTestEmployee(org._id)
    const emp2 = await createTestEmployee(org._id)

    const run = await createTestPayrollRun(org._id, user._id)
    await calculatePayroll(String(run._id))
    const approved = await approvePayroll(String(run._id), String(user._id))

    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBeDefined()
    expect(approved.approvedAt).toBeDefined()

    const payslips = await Payslip.find({ payrollRunId: run._id })
    expect(payslips).toHaveLength(2)

    const slipIds = payslips.map(s => String(s.employeeId))
    expect(slipIds).toContain(String(emp1._id))
    expect(slipIds).toContain(String(emp2._id))

    for (const slip of payslips) {
      expect(slip.grossPay).toBeGreaterThan(0)
      expect(slip.netPay).toBeGreaterThan(0)
      expect(slip.status).toBe('generated')
    }
  })

  it('should reject calculating a non-draft payroll run', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    await createTestEmployee(org._id)

    const run = await createTestPayrollRun(org._id, user._id)
    await calculatePayroll(String(run._id))

    await expect(calculatePayroll(String(run._id))).rejects.toThrow('Only draft payroll runs can be calculated')
  })

  it('should reject approving a non-calculated payroll run', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)

    await expect(approvePayroll(String(run._id), String(user._id))).rejects.toThrow(
      'Only calculated payroll runs can be approved',
    )
  })

  it('should include employer contributions from org settings', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    await createTestEmployee(org._id, {
      salary: { baseSalary: 5000, currency: 'EUR', frequency: 'monthly' },
      deductions: [{ type: 'tax', name: 'Income Tax', percentage: 10 }],
    })

    const run = await createTestPayrollRun(org._id, user._id)
    const calculated = await calculatePayroll(String(run._id))

    const item = calculated.items[0]
    // Employer contributions: social 18%, health 7.5%, pension 18% = 43.5% of 5000 = 2175
    expect(item.employerContributions.length).toBeGreaterThan(0)
    expect(item.totalEmployerCost).toBeGreaterThan(item.grossPay)
    expect(calculated.totals.totalEmployerCost).toBeGreaterThan(calculated.totals.grossPay)
  })
})

describe('Payroll Pagination', () => {
  it('should paginate employees', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestEmployee(org._id, { employeeNumber: `EMP-${String(i).padStart(3, '0')}`, firstName: `Employee`, lastName: `${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(Employee, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)
    expect(p0.totalPages).toBe(2)

    const p1 = await paginateQuery(Employee, { orgId: org._id }, { page: '1' })
    expect(p1.items).toHaveLength(5)

    const all = await paginateQuery(Employee, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate employees with sort', async () => {
    const org = await createTestOrg()
    await createTestEmployee(org._id, { employeeNumber: 'EMP-C', lastName: 'Charlie' })
    await createTestEmployee(org._id, { employeeNumber: 'EMP-A', lastName: 'Alice' })
    await createTestEmployee(org._id, { employeeNumber: 'EMP-B', lastName: 'Bob' })

    const sorted = await paginateQuery(Employee, { orgId: org._id }, { sortBy: 'lastName', sortOrder: 'asc' })
    expect(sorted.items[0].lastName).toBe('Alice')
    expect(sorted.items[1].lastName).toBe('Bob')
    expect(sorted.items[2].lastName).toBe('Charlie')
  })

  it('should paginate payroll runs', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestPayrollRun(org._id, user._id, { name: `Run ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(PayrollRun, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(PayrollRun, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate timesheets', async () => {
    const org = await createTestOrg()
    const emp = await createTestEmployee(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestTimesheet(org._id, emp._id, { date: new Date(2025, 0, i + 1), hoursWorked: 8 })
    }
    const p0 = await paginateQuery(Timesheet, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(Timesheet, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate payslips', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const run = await createTestPayrollRun(org._id, user._id)
    for (let i = 0; i < 15; i++) {
      const emp = await createTestEmployee(org._id, { employeeNumber: `PS-EMP-${Date.now()}-${i}` })
      await createTestPayslip(org._id, run._id, emp._id, { grossPay: 5000 + i * 100 })
    }
    const p0 = await paginateQuery(Payslip, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(Payslip, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })
})
