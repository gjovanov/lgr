import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { ApprovalType, ApprovalRequest } from 'db/models'
import {
  createApprovalRequest,
  approveStep,
  rejectStep,
  cancelApprovalRequest,
} from 'services/biz/approval.service'
import { mongoose } from 'db/connection'
const { Types } = mongoose

let userSeq = 0
function uniqueUserOverrides() {
  const s = ++userSeq
  const ts = Date.now()
  return { email: `user-${ts}-${s}@test.com`, username: `user-${ts}-${s}`, operatorCode: `${String(s).padStart(4, '0')}` }
}

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
})

async function createTestApprovalType(orgId: any, overrides: any = {}) {
  const defaults = {
    orgId,
    name: `Approval Type ${Date.now()}`,
    entityType: 'purchase_order',
    description: 'Test approval type',
    steps: [
      { order: 1, name: 'Manager Approval', approverType: 'user', approverId: new Types.ObjectId(), required: true },
      { order: 2, name: 'Director Approval', approverType: 'user', approverId: new Types.ObjectId(), required: true },
    ],
    isActive: true,
  }
  return ApprovalType.create({ ...defaults, ...overrides })
}

describe('Approval Flow', () => {
  it('should create an approval type with steps', async () => {
    const org = await createTestOrg()

    const type = await createTestApprovalType(org._id)

    expect(type.name).toBeDefined()
    expect(type.entityType).toBe('purchase_order')
    expect(type.steps).toHaveLength(2)
    expect(type.steps[0].order).toBe(1)
    expect(type.steps[1].order).toBe(2)
    expect(type.isActive).toBe(true)
  })

  it('should create an approval request from type', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const type = await createTestApprovalType(org._id)

    const entityId = new Types.ObjectId().toHexString()
    const request = await createApprovalRequest(
      String(org._id),
      'purchase_order',
      entityId,
      String(user._id),
    )

    expect(request.state).toBe('pending')
    expect(request.currentStep).toBe(1)
    expect(request.steps).toHaveLength(2)
    expect(request.entityType).toBe('purchase_order')
    expect(request.entityId).toBe(entityId)
    expect(request.typeId).toBe(type.id || String(type._id))
  })

  it('should approve first step and advance to next', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const approver = await createTestUser(org._id, uniqueUserOverrides())

    await createTestApprovalType(org._id)

    const entityId = new Types.ObjectId().toHexString()
    const request = await createApprovalRequest(
      String(org._id),
      'purchase_order',
      entityId,
      String(user._id),
    )

    const afterApprove = await approveStep(
      request.id,
      String(org._id),
      String(approver._id),
      'Looks good',
    )

    expect(afterApprove.state).toBe('pending') // still pending, 2nd step remains
    expect(afterApprove.currentStep).toBe(2)
    expect(afterApprove.steps[0].decision).toBe('approved')
    expect(afterApprove.steps[0].comment).toBe('Looks good')
    expect(afterApprove.steps[1].decision).toBe('pending')
  })

  it('should approve all steps and complete the request', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const approver1 = await createTestUser(org._id, uniqueUserOverrides())
    const approver2 = await createTestUser(org._id, uniqueUserOverrides())

    await createTestApprovalType(org._id)

    const entityId = new Types.ObjectId().toHexString()
    const request = await createApprovalRequest(
      String(org._id),
      'purchase_order',
      entityId,
      String(user._id),
    )

    // Approve step 1
    await approveStep(request.id, String(org._id), String(approver1._id))

    // Approve step 2
    const final = await approveStep(request.id, String(org._id), String(approver2._id))

    expect(final.state).toBe('approved')
    expect(final.decidedDate).toBeDefined()
    expect(final.steps[0].decision).toBe('approved')
    expect(final.steps[1].decision).toBe('approved')
  })

  it('should reject step and reject entire request', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const approver = await createTestUser(org._id, uniqueUserOverrides())

    await createTestApprovalType(org._id)

    const entityId = new Types.ObjectId().toHexString()
    const request = await createApprovalRequest(
      String(org._id),
      'purchase_order',
      entityId,
      String(user._id),
    )

    const rejected = await rejectStep(
      request.id,
      String(org._id),
      String(approver._id),
      'Budget too high',
    )

    expect(rejected.state).toBe('rejected')
    expect(rejected.decidedDate).toBeDefined()
    expect(rejected.steps[0].decision).toBe('rejected')
    expect(rejected.steps[0].comment).toBe('Budget too high')
  })

  it('should cancel a pending request', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)

    await createTestApprovalType(org._id)

    const entityId = new Types.ObjectId().toHexString()
    const request = await createApprovalRequest(
      String(org._id),
      'purchase_order',
      entityId,
      String(user._id),
    )

    const cancelled = await cancelApprovalRequest(request.id, String(org._id))

    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.decidedDate).toBeDefined()
  })

  it('should not cancel an already approved request', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const approver = await createTestUser(org._id, uniqueUserOverrides())

    // Single-step approval type
    await createTestApprovalType(org._id, {
      steps: [{ order: 1, name: 'Quick Approve', approverType: 'user', approverId: new Types.ObjectId(), required: true }],
    })

    const entityId = new Types.ObjectId().toHexString()
    const request = await createApprovalRequest(
      String(org._id),
      'purchase_order',
      entityId,
      String(user._id),
    )

    await approveStep(request.id, String(org._id), String(approver._id))

    await expect(
      cancelApprovalRequest(request.id, String(org._id)),
    ).rejects.toThrow('Only pending requests can be cancelled')
  })

  it('should error on non-existent request', async () => {
    const org = await createTestOrg()

    await expect(
      approveStep('000000000000000000000000', String(org._id), '000000000000000000000000'),
    ).rejects.toThrow('Approval request not found')
  })
})
