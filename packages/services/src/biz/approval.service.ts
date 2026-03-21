import type { RepositoryRegistry } from 'dal'
import type { IApprovalRequest } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

/**
 * Create an approval request for an entity.
 * Finds the matching active ApprovalType for the given entityType,
 * then creates the request with steps from the type config.
 */
export async function createApprovalRequest(
  orgId: string,
  entityType: string,
  entityId: string,
  requesterId: string,
  repos?: RepositoryRegistry,
): Promise<IApprovalRequest> {
  const r = repos ?? getRepos()

  // Find the active approval type for this entity type
  const approvalType = await r.approvalTypes.findOne({
    orgId,
    entityType,
    isActive: true,
  } as any)
  if (!approvalType) throw new Error(`No active approval type found for entity type: ${entityType}`)
  if (!approvalType.steps || approvalType.steps.length === 0) {
    throw new Error('Approval type has no steps configured')
  }

  // Create step results from type config, starting as pending
  const steps = approvalType.steps
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      order: step.order,
      approverId: step.approverId || requesterId, // fallback to requester if no specific approver
      decision: 'pending',
    }))

  const request = await r.approvalRequests.create({
    orgId,
    typeId: approvalType.id,
    entityType,
    entityId,
    requesterId,
    state: 'pending',
    currentStep: 1,
    steps,
    requestedDate: new Date(),
  } as any)

  logger.info({ requestId: request.id, entityType, entityId }, 'Approval request created')
  return request
}

/**
 * Approve the current step of an approval request.
 * If all steps are approved, the entire request is approved.
 */
export async function approveStep(
  requestId: string,
  orgId: string,
  approverId: string,
  comment?: string,
  repos?: RepositoryRegistry,
): Promise<IApprovalRequest> {
  const r = repos ?? getRepos()
  const request = await r.approvalRequests.findOne({ id: requestId, orgId } as any)
  if (!request) throw new Error('Approval request not found')
  if (request.state !== 'pending') throw new Error('Only pending requests can be approved')

  // Find the current step
  const currentStepIdx = request.steps.findIndex((s) => s.order === request.currentStep)
  if (currentStepIdx === -1) throw new Error('Current step not found')

  // Update the step
  const updatedSteps = [...request.steps]
  updatedSteps[currentStepIdx] = {
    ...updatedSteps[currentStepIdx],
    approverId,
    decision: 'approved',
    decidedDate: new Date(),
    comment,
  }

  // Check if there are more steps
  const nextStepIdx = updatedSteps.findIndex((s) => s.order > request.currentStep && s.decision === 'pending')

  let newState: string
  let newCurrentStep: number
  let decidedDate: Date | undefined

  if (nextStepIdx === -1) {
    // All steps approved — approve the entire request
    newState = 'approved'
    newCurrentStep = request.currentStep
    decidedDate = new Date()
  } else {
    // Advance to next step
    newState = 'pending'
    newCurrentStep = updatedSteps[nextStepIdx].order
    decidedDate = undefined
  }

  const updated = await r.approvalRequests.findOneAndUpdate(
    { id: requestId, orgId, state: 'pending' } as any,
    {
      steps: updatedSteps,
      currentStep: newCurrentStep,
      state: newState,
      decidedDate,
    } as any,
  )
  if (!updated) throw new Error('Concurrent modification: approval request state changed')

  logger.info({ requestId, approverId, newState }, 'Approval step approved')
  return updated
}

/**
 * Reject the current step of an approval request.
 * Rejecting any step rejects the entire request.
 */
export async function rejectStep(
  requestId: string,
  orgId: string,
  approverId: string,
  comment?: string,
  repos?: RepositoryRegistry,
): Promise<IApprovalRequest> {
  const r = repos ?? getRepos()
  const request = await r.approvalRequests.findOne({ id: requestId, orgId } as any)
  if (!request) throw new Error('Approval request not found')
  if (request.state !== 'pending') throw new Error('Only pending requests can be rejected')

  // Find the current step
  const currentStepIdx = request.steps.findIndex((s) => s.order === request.currentStep)
  if (currentStepIdx === -1) throw new Error('Current step not found')

  // Update the step
  const updatedSteps = [...request.steps]
  updatedSteps[currentStepIdx] = {
    ...updatedSteps[currentStepIdx],
    approverId,
    decision: 'rejected',
    decidedDate: new Date(),
    comment,
  }

  const updated = await r.approvalRequests.findOneAndUpdate(
    { id: requestId, orgId, state: 'pending' } as any,
    {
      steps: updatedSteps,
      state: 'rejected',
      decidedDate: new Date(),
    } as any,
  )
  if (!updated) throw new Error('Concurrent modification: approval request state changed')

  logger.info({ requestId, approverId }, 'Approval request rejected')
  return updated
}

/**
 * Cancel a pending approval request.
 */
export async function cancelApprovalRequest(
  requestId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<IApprovalRequest> {
  const r = repos ?? getRepos()
  const request = await r.approvalRequests.findOne({ id: requestId, orgId } as any)
  if (!request) throw new Error('Approval request not found')
  if (request.state !== 'pending') throw new Error('Only pending requests can be cancelled')

  const updated = await r.approvalRequests.findOneAndUpdate(
    { id: requestId, orgId, state: 'pending' } as any,
    {
      state: 'cancelled',
      decidedDate: new Date(),
    } as any,
  )
  if (!updated) throw new Error('Concurrent modification: approval request state changed')

  logger.info({ requestId }, 'Approval request cancelled')
  return updated
}
