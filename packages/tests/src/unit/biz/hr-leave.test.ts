import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { submitLeaveRequest, approveLeaveRequest, rejectLeaveRequest } from 'services/biz/hr.service'
import { LeaveBalance, LeaveRequest } from 'db/models'
import {
  createTestOrg,
  createTestEmployee,
  createTestLeaveType,
  createTestLeaveBalance,
  createTestLeaveRequest,
  createTestUser,
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

describe('submitLeaveRequest', () => {
  it('should create a leave request with pending status', async () => {
    const org = await createTestOrg({ slug: 'leave-submit-org' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 0,
      pending: 0,
      remaining: 20,
      carriedOver: 0,
    })

    const startDate = new Date('2026-03-10')
    const endDate = new Date('2026-03-14')
    const request = await submitLeaveRequest(
      String(org._id),
      String(employee._id),
      String(leaveType._id),
      startDate,
      endDate,
      5,
      false,
      'Family vacation',
    )

    expect(request).toBeDefined()
    expect(request.status).toBe('pending')
    expect(request.days).toBe(5)
    expect(request.halfDay).toBe(false)
    expect(request.reason).toBe('Family vacation')
    expect(String(request.orgId)).toBe(String(org._id))
    expect(String(request.employeeId)).toBe(String(employee._id))
    expect(String(request.leaveTypeId)).toBe(String(leaveType._id))
  })

  it('should increment balance.pending by the requested days', async () => {
    const org = await createTestOrg({ slug: 'leave-pending-inc' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 0,
      pending: 0,
      remaining: 20,
      carriedOver: 0,
    })

    const startDate = new Date('2026-04-01')
    const endDate = new Date('2026-04-03')
    await submitLeaveRequest(
      String(org._id),
      String(employee._id),
      String(leaveType._id),
      startDate,
      endDate,
      3,
      false,
    )

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
      year: 2026,
    })

    expect(balance).toBeDefined()
    expect(balance!.pending).toBe(3)
  })

  it('should recalculate balance.remaining after submission', async () => {
    const org = await createTestOrg({ slug: 'leave-remaining-calc' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 5,
      pending: 2,
      remaining: 16, // 20 - 5 - 2 + 3 = 16
      carriedOver: 3,
    })

    const startDate = new Date('2026-05-05')
    const endDate = new Date('2026-05-09')
    await submitLeaveRequest(
      String(org._id),
      String(employee._id),
      String(leaveType._id),
      startDate,
      endDate,
      4,
      false,
    )

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
      year: 2026,
    })

    expect(balance).toBeDefined()
    // remaining = entitled - taken - pending + carriedOver = 20 - 5 - 6 + 3 = 12
    expect(balance!.pending).toBe(6)
    expect(balance!.remaining).toBe(12)
  })

  it('should reject when balance.remaining is less than requested days', async () => {
    const org = await createTestOrg({ slug: 'leave-insufficient' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 18,
      pending: 0,
      remaining: 2,
      carriedOver: 0,
    })

    const startDate = new Date('2026-06-01')
    const endDate = new Date('2026-06-05')

    expect(
      submitLeaveRequest(
        String(org._id),
        String(employee._id),
        String(leaveType._id),
        startDate,
        endDate,
        5,
        false,
      ),
    ).rejects.toThrow('Insufficient leave balance')
  })
})

describe('approveLeaveRequest', () => {
  it('should change status from pending to approved', async () => {
    const org = await createTestOrg({ slug: 'leave-approve-status' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-07-01'),
      endDate: new Date('2026-07-03'),
      days: 3,
      status: 'pending',
    })

    const approved = await approveLeaveRequest(String(request._id), String(user._id))

    expect(approved.status).toBe('approved')
  })

  it('should set approvedBy and approvedAt', async () => {
    const org = await createTestOrg({ slug: 'leave-approve-meta' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-07-07'),
      endDate: new Date('2026-07-08'),
      days: 2,
      status: 'pending',
    })

    const approved = await approveLeaveRequest(String(request._id), String(user._id))

    expect(String(approved.approvedBy)).toBe(String(user._id))
    expect(approved.approvedAt).toBeDefined()
    expect(approved.approvedAt).toBeInstanceOf(Date)
  })

  it('should decrement balance.pending and increment balance.taken', async () => {
    const org = await createTestOrg({ slug: 'leave-approve-balance' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 2,
      pending: 5,
      remaining: 13,
      carriedOver: 0,
    })
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-08-01'),
      endDate: new Date('2026-08-05'),
      days: 5,
      status: 'pending',
    })

    await approveLeaveRequest(String(request._id), String(user._id))

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
      year: 2026,
    })

    expect(balance).toBeDefined()
    expect(balance!.pending).toBe(0)
    expect(balance!.taken).toBe(7)
  })

  it('should recalculate balance.remaining after approval', async () => {
    const org = await createTestOrg({ slug: 'leave-approve-remaining' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 0,
      pending: 3,
      remaining: 19, // 20 - 0 - 3 + 2 = 19
      carriedOver: 2,
    })
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-09-01'),
      endDate: new Date('2026-09-03'),
      days: 3,
      status: 'pending',
    })

    await approveLeaveRequest(String(request._id), String(user._id))

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
      year: 2026,
    })

    expect(balance).toBeDefined()
    // remaining = entitled - taken - pending + carriedOver = 20 - 3 - 0 + 2 = 19
    expect(balance!.pending).toBe(0)
    expect(balance!.taken).toBe(3)
    expect(balance!.remaining).toBe(19)
  })

  it('should reject approval of a non-pending request', async () => {
    const org = await createTestOrg({ slug: 'leave-approve-reject-non-pending' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-10-01'),
      endDate: new Date('2026-10-02'),
      days: 2,
      status: 'approved',
    })

    expect(
      approveLeaveRequest(String(request._id), String(user._id)),
    ).rejects.toThrow('Only pending requests can be approved')
  })
})

describe('rejectLeaveRequest', () => {
  it('should change status from pending to rejected and set rejectionReason', async () => {
    const org = await createTestOrg({ slug: 'leave-reject-status' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-11-01'),
      endDate: new Date('2026-11-03'),
      days: 3,
      status: 'pending',
    })

    const rejected = await rejectLeaveRequest(
      String(request._id),
      String(user._id),
      'Project deadline conflict',
    )

    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectionReason).toBe('Project deadline conflict')
  })

  it('should decrement balance.pending after rejection', async () => {
    const org = await createTestOrg({ slug: 'leave-reject-pending' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 0,
      pending: 4,
      remaining: 16,
      carriedOver: 0,
    })
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-11-10'),
      endDate: new Date('2026-11-13'),
      days: 4,
      status: 'pending',
    })

    await rejectLeaveRequest(String(request._id), String(user._id), 'Not enough coverage')

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
      year: 2026,
    })

    expect(balance).toBeDefined()
    expect(balance!.pending).toBe(0)
  })

  it('should recalculate balance.remaining after rejection', async () => {
    const org = await createTestOrg({ slug: 'leave-reject-remaining' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    await createTestLeaveBalance(org._id, employee._id, leaveType._id, {
      entitled: 20,
      taken: 5,
      pending: 3,
      remaining: 15, // 20 - 5 - 3 + 3 = 15
      carriedOver: 3,
    })
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-12-01'),
      endDate: new Date('2026-12-03'),
      days: 3,
      status: 'pending',
    })

    await rejectLeaveRequest(String(request._id), String(user._id), 'Coverage issue')

    const balance = await LeaveBalance.findOne({
      orgId: org._id,
      employeeId: employee._id,
      leaveTypeId: leaveType._id,
      year: 2026,
    })

    expect(balance).toBeDefined()
    // remaining = entitled - taken - pending + carriedOver = 20 - 5 - 0 + 3 = 18
    expect(balance!.pending).toBe(0)
    expect(balance!.taken).toBe(5)
    expect(balance!.remaining).toBe(18)
  })

  it('should reject rejection of a non-pending request', async () => {
    const org = await createTestOrg({ slug: 'leave-reject-non-pending' })
    const employee = await createTestEmployee(org._id)
    const leaveType = await createTestLeaveType(org._id)
    const user = await createTestUser(org._id)
    const request = await createTestLeaveRequest(org._id, employee._id, leaveType._id, {
      startDate: new Date('2026-12-10'),
      endDate: new Date('2026-12-11'),
      days: 2,
      status: 'rejected',
    })

    expect(
      rejectLeaveRequest(String(request._id), String(user._id), 'Already handled'),
    ).rejects.toThrow('Only pending requests can be rejected')
  })
})
