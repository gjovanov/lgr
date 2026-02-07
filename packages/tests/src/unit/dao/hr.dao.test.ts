import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { leaveTypeDao } from 'services/dao/hr/leave-type.dao'
import { leaveRequestDao } from 'services/dao/hr/leave-request.dao'
import { leaveBalanceDao } from 'services/dao/hr/leave-balance.dao'
import { businessTripDao } from 'services/dao/hr/business-trip.dao'
import {
  createTestOrg,
  createTestEmployee,
  createTestLeaveType,
  createTestLeaveRequest,
  createTestLeaveBalance,
  createTestBusinessTrip,
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

describe('LeaveTypeDao', () => {
  it('should find leave type by code', async () => {
    const org = await createTestOrg({ slug: 'lt-code-org' })
    await createTestLeaveType(org._id, { code: 'ANNUAL', name: 'Annual Leave' })
    await createTestLeaveType(org._id, { code: 'SICK', name: 'Sick Leave' })

    const found = await leaveTypeDao.findByCode(String(org._id), 'ANNUAL')
    expect(found).toBeDefined()
    expect(found!.code).toBe('ANNUAL')
    expect(found!.name).toBe('Annual Leave')
  })

  it('should find only active leave types', async () => {
    const org = await createTestOrg({ slug: 'lt-active-org' })
    await createTestLeaveType(org._id, { code: 'ACTIVE1', isActive: true })
    await createTestLeaveType(org._id, { code: 'ACTIVE2', isActive: true })
    await createTestLeaveType(org._id, { code: 'INACTIVE', isActive: false })

    const active = await leaveTypeDao.findActive(String(org._id))
    expect(active).toHaveLength(2)
    const codes = active.map((lt) => lt.code)
    expect(codes).toContain('ACTIVE1')
    expect(codes).toContain('ACTIVE2')
    expect(codes).not.toContain('INACTIVE')
  })
})

describe('LeaveRequestDao', () => {
  it('should find leave requests by employee', async () => {
    const org = await createTestOrg({ slug: 'lr-emp-org' })
    const emp1 = await createTestEmployee(org._id, { employeeNumber: 'EMP-LR1' })
    const emp2 = await createTestEmployee(org._id, { employeeNumber: 'EMP-LR2' })
    const lt = await createTestLeaveType(org._id, { code: 'LR-AL' })

    await createTestLeaveRequest(org._id, emp1._id, lt._id, { reason: 'Holiday' })
    await createTestLeaveRequest(org._id, emp1._id, lt._id, { reason: 'Family event' })
    await createTestLeaveRequest(org._id, emp2._id, lt._id, { reason: 'Other' })

    const requests = await leaveRequestDao.findByEmployee(String(org._id), String(emp1._id))
    expect(requests).toHaveLength(2)
    requests.forEach((r) => {
      expect(String(r.employeeId)).toBe(String(emp1._id))
    })
  })

  it('should find leave requests by status', async () => {
    const org = await createTestOrg({ slug: 'lr-status-org' })
    const emp = await createTestEmployee(org._id, { employeeNumber: 'EMP-LRS' })
    const lt = await createTestLeaveType(org._id, { code: 'LRS-AL' })

    await createTestLeaveRequest(org._id, emp._id, lt._id, { status: 'pending' })
    await createTestLeaveRequest(org._id, emp._id, lt._id, { status: 'approved' })
    await createTestLeaveRequest(org._id, emp._id, lt._id, { status: 'approved' })

    const approved = await leaveRequestDao.findByStatus(String(org._id), 'approved')
    expect(approved).toHaveLength(2)
    approved.forEach((r) => {
      expect(r.status).toBe('approved')
    })
  })

  it('should find pending leave requests', async () => {
    const org = await createTestOrg({ slug: 'lr-pending-org' })
    const emp = await createTestEmployee(org._id, { employeeNumber: 'EMP-LRP' })
    const lt = await createTestLeaveType(org._id, { code: 'LRP-AL' })

    await createTestLeaveRequest(org._id, emp._id, lt._id, { status: 'pending' })
    await createTestLeaveRequest(org._id, emp._id, lt._id, { status: 'pending' })
    await createTestLeaveRequest(org._id, emp._id, lt._id, { status: 'approved' })
    await createTestLeaveRequest(org._id, emp._id, lt._id, { status: 'rejected' })

    const pending = await leaveRequestDao.findPending(String(org._id))
    expect(pending).toHaveLength(2)
    pending.forEach((r) => {
      expect(r.status).toBe('pending')
    })
  })
})

describe('LeaveBalanceDao', () => {
  it('should find leave balances by employee and year', async () => {
    const org = await createTestOrg({ slug: 'lb-emp-org' })
    const emp = await createTestEmployee(org._id, { employeeNumber: 'EMP-LB1' })
    const lt1 = await createTestLeaveType(org._id, { code: 'LB-AL' })
    const lt2 = await createTestLeaveType(org._id, { code: 'LB-SL' })
    const year = new Date().getFullYear()

    await createTestLeaveBalance(org._id, emp._id, lt1._id, { year, entitled: 20 })
    await createTestLeaveBalance(org._id, emp._id, lt2._id, { year, entitled: 10 })
    await createTestLeaveBalance(org._id, emp._id, lt1._id, { year: year - 1, entitled: 18 })

    const balances = await leaveBalanceDao.findByEmployee(String(org._id), String(emp._id), year)
    expect(balances).toHaveLength(2)
    balances.forEach((b) => {
      expect(b.year).toBe(year)
      expect(String(b.employeeId)).toBe(String(emp._id))
    })
  })

  it('should find leave balances by leave type and year', async () => {
    const org = await createTestOrg({ slug: 'lb-type-org' })
    const emp1 = await createTestEmployee(org._id, { employeeNumber: 'EMP-LBT1' })
    const emp2 = await createTestEmployee(org._id, { employeeNumber: 'EMP-LBT2' })
    const lt = await createTestLeaveType(org._id, { code: 'LBT-AL' })
    const ltOther = await createTestLeaveType(org._id, { code: 'LBT-SL' })
    const year = new Date().getFullYear()

    await createTestLeaveBalance(org._id, emp1._id, lt._id, { year })
    await createTestLeaveBalance(org._id, emp2._id, lt._id, { year })
    await createTestLeaveBalance(org._id, emp1._id, ltOther._id, { year })

    const balances = await leaveBalanceDao.findByLeaveType(String(org._id), String(lt._id), year)
    expect(balances).toHaveLength(2)
    balances.forEach((b) => {
      expect(String(b.leaveTypeId)).toBe(String(lt._id))
      expect(b.year).toBe(year)
    })
  })
})

describe('BusinessTripDao', () => {
  it('should find business trips by employee', async () => {
    const org = await createTestOrg({ slug: 'bt-emp-org' })
    const emp1 = await createTestEmployee(org._id, { employeeNumber: 'EMP-BT1' })
    const emp2 = await createTestEmployee(org._id, { employeeNumber: 'EMP-BT2' })

    await createTestBusinessTrip(org._id, emp1._id, { destination: 'Munich' })
    await createTestBusinessTrip(org._id, emp1._id, { destination: 'Hamburg' })
    await createTestBusinessTrip(org._id, emp2._id, { destination: 'Frankfurt' })

    const trips = await businessTripDao.findByEmployee(String(org._id), String(emp1._id))
    expect(trips).toHaveLength(2)
    trips.forEach((t) => {
      expect(String(t.employeeId)).toBe(String(emp1._id))
    })
  })

  it('should find business trips by status', async () => {
    const org = await createTestOrg({ slug: 'bt-status-org' })
    const emp = await createTestEmployee(org._id, { employeeNumber: 'EMP-BTS' })

    await createTestBusinessTrip(org._id, emp._id, { status: 'requested' })
    await createTestBusinessTrip(org._id, emp._id, { status: 'approved' })
    await createTestBusinessTrip(org._id, emp._id, { status: 'approved' })

    const approved = await businessTripDao.findByStatus(String(org._id), 'approved')
    expect(approved).toHaveLength(2)
    approved.forEach((t) => {
      expect(t.status).toBe('approved')
    })
  })
})

describe('HR Multi-tenancy', () => {
  it('should isolate leave types between orgs', async () => {
    const org1 = await createTestOrg({ slug: 'hr-iso-org1' })
    const org2 = await createTestOrg({ slug: 'hr-iso-org2' })

    await createTestLeaveType(org1._id, { code: 'ISO-AL', name: 'Annual Leave Org1' })
    await createTestLeaveType(org2._id, { code: 'ISO-AL', name: 'Annual Leave Org2' })

    const org1Types = await leaveTypeDao.findActive(String(org1._id))
    const org2Types = await leaveTypeDao.findActive(String(org2._id))

    expect(org1Types).toHaveLength(1)
    expect(org2Types).toHaveLength(1)
    expect(org1Types[0].name).toBe('Annual Leave Org1')
    expect(org2Types[0].name).toBe('Annual Leave Org2')

    // Leave type from org1 should not be found by code in org2
    const crossCheck = await leaveTypeDao.findByCode(String(org2._id), 'ISO-AL')
    expect(crossCheck).toBeDefined()
    expect(crossCheck!.name).toBe('Annual Leave Org2')
    expect(crossCheck!.name).not.toBe('Annual Leave Org1')
  })
})
