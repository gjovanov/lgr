import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { employeeDao } from 'services/dao/payroll/employee.dao'
import { payrollRunDao } from 'services/dao/payroll/payroll-run.dao'
import { payslipDao } from 'services/dao/payroll/payslip.dao'
import { timesheetDao } from 'services/dao/payroll/timesheet.dao'
import { Payslip } from 'db/models'
import { mongoose } from 'db/connection'
const { Types } = mongoose
import {
  createTestOrg,
  createTestEmployee,
  createTestPayrollRun,
  createTestTimesheet,
} from '../../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

// ---------------------------------------------------------------------------
// EmployeeDao
// ---------------------------------------------------------------------------
describe('EmployeeDao', () => {
  it('should find employees by department', async () => {
    const org = await createTestOrg({ slug: 'emp-dept-org' })
    await createTestEmployee(org._id, { department: 'Engineering', email: 'eng1@test.com', employeeNumber: 'E1' })
    await createTestEmployee(org._id, { department: 'Engineering', email: 'eng2@test.com', employeeNumber: 'E2' })
    await createTestEmployee(org._id, { department: 'Sales', email: 'sales1@test.com', employeeNumber: 'E3' })

    const engineers = await employeeDao.findByDepartment(String(org._id), 'Engineering')
    expect(engineers).toHaveLength(2)
    expect(engineers.every((e) => e.department === 'Engineering')).toBe(true)
  })

  it('should find only active employees', async () => {
    const org = await createTestOrg({ slug: 'emp-active-org' })
    await createTestEmployee(org._id, { status: 'active', email: 'a1@test.com', employeeNumber: 'A1' })
    await createTestEmployee(org._id, { status: 'active', email: 'a2@test.com', employeeNumber: 'A2' })
    await createTestEmployee(org._id, { status: 'terminated', email: 'a3@test.com', employeeNumber: 'A3' })

    const active = await employeeDao.findActive(String(org._id))
    expect(active).toHaveLength(2)
    expect(active.every((e) => e.status === 'active')).toBe(true)
  })

  it('should find employee by number', async () => {
    const org = await createTestOrg({ slug: 'emp-num-org' })
    await createTestEmployee(org._id, { employeeNumber: 'EMP-42', email: 'e42@test.com' })

    const found = await employeeDao.findByNumber(String(org._id), 'EMP-42')
    expect(found).toBeDefined()
    expect(found!.employeeNumber).toBe('EMP-42')
  })

  it('should return null for non-existent employee number', async () => {
    const org = await createTestOrg({ slug: 'emp-null-org' })

    const found = await employeeDao.findByNumber(String(org._id), 'DOES-NOT-EXIST')
    expect(found).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PayrollRunDao
// ---------------------------------------------------------------------------
describe('PayrollRunDao', () => {
  it('should find payroll runs by period', async () => {
    const org = await createTestOrg({ slug: 'pr-period-org' })
    const createdBy = new Types.ObjectId()

    await createTestPayrollRun(org._id, createdBy, {
      name: 'Jan 2025',
      period: { from: new Date('2025-01-01'), to: new Date('2025-01-31') },
    })
    await createTestPayrollRun(org._id, createdBy, {
      name: 'Feb 2025',
      period: { from: new Date('2025-02-01'), to: new Date('2025-02-28') },
    })
    await createTestPayrollRun(org._id, createdBy, {
      name: 'Mar 2025',
      period: { from: new Date('2025-03-01'), to: new Date('2025-03-31') },
    })

    const runs = await payrollRunDao.findByPeriod(
      String(org._id),
      new Date('2025-01-01'),
      new Date('2025-02-28'),
    )

    expect(runs).toHaveLength(2)
    expect(runs[0].name).toBe('Feb 2025') // sorted descending by period.from
    expect(runs[1].name).toBe('Jan 2025')
  })

  it('should find payroll runs by status', async () => {
    const org = await createTestOrg({ slug: 'pr-status-org' })
    const createdBy = new Types.ObjectId()

    await createTestPayrollRun(org._id, createdBy, { status: 'draft' })
    await createTestPayrollRun(org._id, createdBy, { status: 'approved' })
    await createTestPayrollRun(org._id, createdBy, { status: 'draft' })

    const drafts = await payrollRunDao.findByStatus(String(org._id), 'draft')
    expect(drafts).toHaveLength(2)
    expect(drafts.every((r) => r.status === 'draft')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PayslipDao
// ---------------------------------------------------------------------------
describe('PayslipDao', () => {
  const createPayslip = async (
    orgId: Types.ObjectId,
    employeeId: Types.ObjectId,
    payrollRunId: Types.ObjectId,
    overrides: Record<string, unknown> = {},
  ) => {
    const now = new Date()
    return Payslip.create({
      orgId,
      employeeId,
      payrollRunId,
      period: {
        from: new Date(now.getFullYear(), now.getMonth(), 1),
        to: new Date(now.getFullYear(), now.getMonth() + 1, 0),
      },
      earnings: [{ type: 'salary', description: 'Base salary', amount: 5000 }],
      deductions: [{ type: 'tax', description: 'Income Tax', amount: 500 }],
      grossPay: 5000,
      totalDeductions: 500,
      netPay: 4500,
      yearToDate: { grossPay: 5000, totalDeductions: 500, netPay: 4500 },
      paymentMethod: 'bank_transfer',
      status: 'generated',
      ...overrides,
    })
  }

  it('should find payslips by employee', async () => {
    const org = await createTestOrg({ slug: 'ps-emp-org' })
    const emp1 = await createTestEmployee(org._id, { email: 'pe1@test.com', employeeNumber: 'PE1' })
    const emp2 = await createTestEmployee(org._id, { email: 'pe2@test.com', employeeNumber: 'PE2' })
    const createdBy = new Types.ObjectId()
    const run = await createTestPayrollRun(org._id, createdBy)

    await createPayslip(org._id, emp1._id, run._id)
    await createPayslip(org._id, emp1._id, run._id) // second payslip for emp1
    await createPayslip(org._id, emp2._id, run._id)

    const emp1Payslips = await payslipDao.findByEmployee(String(org._id), String(emp1._id))
    expect(emp1Payslips).toHaveLength(2)
    expect(emp1Payslips.every((p) => String(p.employeeId) === String(emp1._id))).toBe(true)
  })

  it('should find payslips by payroll run', async () => {
    const org = await createTestOrg({ slug: 'ps-run-org' })
    const emp = await createTestEmployee(org._id, { email: 'pr1@test.com', employeeNumber: 'PR1' })
    const createdBy = new Types.ObjectId()
    const run1 = await createTestPayrollRun(org._id, createdBy, { name: 'Run 1' })
    const run2 = await createTestPayrollRun(org._id, createdBy, { name: 'Run 2' })

    await createPayslip(org._id, emp._id, run1._id)
    await createPayslip(org._id, emp._id, run1._id)
    await createPayslip(org._id, emp._id, run2._id)

    const run1Payslips = await payslipDao.findByPayrollRun(String(org._id), String(run1._id))
    expect(run1Payslips).toHaveLength(2)
    expect(run1Payslips.every((p) => String(p.payrollRunId) === String(run1._id))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// TimesheetDao
// ---------------------------------------------------------------------------
describe('TimesheetDao', () => {
  it('should find timesheets by employee', async () => {
    const org = await createTestOrg({ slug: 'ts-emp-org' })
    const emp1 = await createTestEmployee(org._id, { email: 'te1@test.com', employeeNumber: 'TE1' })
    const emp2 = await createTestEmployee(org._id, { email: 'te2@test.com', employeeNumber: 'TE2' })

    await createTestTimesheet(org._id, emp1._id, { date: new Date('2025-03-01') })
    await createTestTimesheet(org._id, emp1._id, { date: new Date('2025-03-02') })
    await createTestTimesheet(org._id, emp2._id, { date: new Date('2025-03-01') })

    const emp1Timesheets = await timesheetDao.findByEmployee(String(org._id), String(emp1._id))
    expect(emp1Timesheets).toHaveLength(2)
    expect(emp1Timesheets.every((t) => String(t.employeeId) === String(emp1._id))).toBe(true)
  })

  it('should find timesheets by status', async () => {
    const org = await createTestOrg({ slug: 'ts-status-org' })
    const emp = await createTestEmployee(org._id, { email: 'ts1@test.com', employeeNumber: 'TS1' })

    await createTestTimesheet(org._id, emp._id, { status: 'submitted' })
    await createTestTimesheet(org._id, emp._id, { status: 'approved' })
    await createTestTimesheet(org._id, emp._id, { status: 'submitted' })

    const submitted = await timesheetDao.findByStatus(String(org._id), 'submitted')
    expect(submitted).toHaveLength(2)
    expect(submitted.every((t) => t.status === 'submitted')).toBe(true)
  })
})
