import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestEmployee, createTestDepartment, createTestLeaveType, createTestLeaveBalance, createTestLeaveRequest, createTestBusinessTrip, createTestEmployeeDocument } from '../helpers/factories'
import { Department, LeaveType, LeaveBalance, LeaveRequest, BusinessTrip, EmployeeDocument } from 'db/models'
import { submitLeaveRequest, approveLeaveRequest, rejectLeaveRequest } from 'services/biz/hr.service'
import { paginateQuery } from 'services/utils/pagination'

const YEAR = new Date().getFullYear()

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

async function setupHR(org: any) {
  const employee = await createTestEmployee(org._id)
  const user = await createTestUser(org._id, { role: 'manager' })

  const leaveType = await LeaveType.create({
    orgId: org._id,
    name: 'Annual Leave',
    code: 'AL',
    defaultDays: 20,
    isPaid: true,
    requiresApproval: true,
    color: '#4CAF50',
    isActive: true,
  })

  const balance = await LeaveBalance.create({
    orgId: org._id,
    employeeId: employee._id,
    leaveTypeId: leaveType._id,
    year: YEAR,
    entitled: 20,
    taken: 0,
    pending: 0,
    remaining: 20,
    carriedOver: 0,
  })

  return { employee, user, leaveType, balance }
}

describe('HR Flow', () => {
  it('should create departments with hierarchy', async () => {
    const org = await createTestOrg()

    const parent = await createTestDepartment(org._id, { name: 'Engineering', code: 'ENG' })
    const child = await createTestDepartment(org._id, { name: 'Frontend', code: 'FE', parentId: parent._id })

    expect(parent.isActive).toBe(true)
    expect(String(child.parentId)).toBe(String(parent._id))

    const found = await Department.find({ orgId: org._id })
    expect(found).toHaveLength(2)
  })

  it('should submit a leave request and update pending balance', async () => {
    const org = await createTestOrg()
    const { employee, leaveType, balance } = await setupHR(org)

    const request = await submitLeaveRequest(
      String(org._id),
      String(employee._id),
      String(leaveType._id),
      new Date(`${YEAR}-06-01`),
      new Date(`${YEAR}-06-05`),
      5,
      false,
      'Summer vacation',
    )

    expect(request.status).toBe('pending')
    expect(request.days).toBe(5)

    const updatedBalance = await LeaveBalance.findById(balance._id)
    expect(updatedBalance!.pending).toBe(5)
    expect(updatedBalance!.remaining).toBe(15) // 20 - 0 - 5 + 0
  })

  it('should approve a leave request and update balance', async () => {
    const org = await createTestOrg()
    const { employee, user, leaveType } = await setupHR(org)

    const request = await submitLeaveRequest(
      String(org._id),
      String(employee._id),
      String(leaveType._id),
      new Date(`${YEAR}-07-01`),
      new Date(`${YEAR}-07-03`),
      3,
      false,
    )

    const approved = await approveLeaveRequest(String(request._id), String(user._id))
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBeDefined()
    expect(approved.approvedAt).toBeDefined()

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
    })
    expect(balance!.taken).toBe(3)
    expect(balance!.pending).toBe(0)
    expect(balance!.remaining).toBe(17) // 20 - 3 - 0 + 0
  })

  it('should reject a leave request and restore balance', async () => {
    const org = await createTestOrg()
    const { employee, user, leaveType } = await setupHR(org)

    const request = await submitLeaveRequest(
      String(org._id),
      String(employee._id),
      String(leaveType._id),
      new Date(`${YEAR}-08-01`),
      new Date(`${YEAR}-08-05`),
      5,
      false,
    )

    const rejected = await rejectLeaveRequest(String(request._id), String(user._id), 'Team capacity')
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectionReason).toBe('Team capacity')

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
    })
    expect(balance!.pending).toBe(0)
    expect(balance!.remaining).toBe(20) // fully restored
  })

  it('should reject leave request when balance is insufficient', async () => {
    const org = await createTestOrg()
    const { employee, leaveType } = await setupHR(org)

    // Update balance to have only 2 days remaining
    await LeaveBalance.findOneAndUpdate(
      { orgId: org._id, employeeId: employee._id, leaveTypeId: leaveType._id },
      { taken: 18, remaining: 2 },
    )

    await expect(
      submitLeaveRequest(
        String(org._id),
        String(employee._id),
        String(leaveType._id),
        new Date(`${YEAR}-09-01`),
        new Date(`${YEAR}-09-05`),
        5,
        false,
      ),
    ).rejects.toThrow('Insufficient leave balance')
  })

  it('should reject approving a non-pending leave request', async () => {
    const org = await createTestOrg()
    const { employee, user, leaveType } = await setupHR(org)

    const request = await submitLeaveRequest(
      String(org._id),
      String(employee._id),
      String(leaveType._id),
      new Date(`${YEAR}-10-01`),
      new Date(`${YEAR}-10-02`),
      2,
      false,
    )

    await approveLeaveRequest(String(request._id), String(user._id))

    await expect(
      approveLeaveRequest(String(request._id), String(user._id)),
    ).rejects.toThrow('Only pending requests can be approved')
  })
})

describe('HR Pagination', () => {
  it('should paginate departments', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestDepartment(org._id, { name: `Dept ${String(i).padStart(2, '0')}`, code: `D-${Date.now()}-${i}` })
    }
    const p0 = await paginateQuery(Department, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)
    expect(p0.totalPages).toBe(2)

    const p1 = await paginateQuery(Department, { orgId: org._id }, { page: '1' })
    expect(p1.items).toHaveLength(5)

    const all = await paginateQuery(Department, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate departments with sort', async () => {
    const org = await createTestOrg()
    await createTestDepartment(org._id, { name: 'Engineering', code: 'ENG' })
    await createTestDepartment(org._id, { name: 'Accounting', code: 'ACC' })
    await createTestDepartment(org._id, { name: 'Design', code: 'DSG' })

    const sorted = await paginateQuery(Department, { orgId: org._id }, { sortBy: 'name', sortOrder: 'asc' })
    expect(sorted.items[0].name).toBe('Accounting')
    expect(sorted.items[1].name).toBe('Design')
    expect(sorted.items[2].name).toBe('Engineering')
  })

  it('should paginate leave types', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestLeaveType(org._id, { name: `Leave ${String(i).padStart(2, '0')}`, code: `LT-${Date.now()}-${i}` })
    }
    const p0 = await paginateQuery(LeaveType, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(LeaveType, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate leave requests', async () => {
    const org = await createTestOrg()
    const emp = await createTestEmployee(org._id)
    const lt = await createTestLeaveType(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestLeaveRequest(org._id, emp._id, lt._id, { days: 1, reason: `Reason ${i}` })
    }
    const p0 = await paginateQuery(LeaveRequest, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(LeaveRequest, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate leave balances', async () => {
    const org = await createTestOrg()
    const lt = await createTestLeaveType(org._id)
    for (let i = 0; i < 15; i++) {
      const emp = await createTestEmployee(org._id, { employeeNumber: `LB-EMP-${Date.now()}-${i}` })
      await createTestLeaveBalance(org._id, emp._id, lt._id)
    }
    const p0 = await paginateQuery(LeaveBalance, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(LeaveBalance, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate business trips', async () => {
    const org = await createTestOrg()
    const emp = await createTestEmployee(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestBusinessTrip(org._id, emp._id, { destination: `City ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(BusinessTrip, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(BusinessTrip, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate employee documents', async () => {
    const org = await createTestOrg()
    const emp = await createTestEmployee(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestEmployeeDocument(org._id, emp._id, { title: `Doc ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(EmployeeDocument, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(EmployeeDocument, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })
})
