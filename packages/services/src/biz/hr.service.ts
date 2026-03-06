import type { RepositoryRegistry } from 'dal'
import type { ILeaveRequest } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

export async function approveLeaveRequest(requestId: string, userId: string, repos?: RepositoryRegistry): Promise<ILeaveRequest> {
  const r = repos ?? getRepos()
  const request = await r.leaveRequests.findById(requestId)
  if (!request) throw new Error('Leave request not found')
  if (request.status !== 'pending') throw new Error('Only pending requests can be approved')

  const updated = await r.leaveRequests.update(requestId, {
    status: 'approved',
    approvedBy: userId,
    approvedAt: new Date(),
  } as any)
  if (!updated) throw new Error('Failed to update leave request')

  // Update leave balance
  const year = request.startDate.getFullYear()
  const balance = await r.leaveBalances.findOne({
    orgId: request.orgId,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    year,
  })

  if (balance) {
    const newPending = balance.pending - request.days
    const newTaken = balance.taken + request.days
    const newRemaining = balance.entitled - newTaken - newPending + balance.carriedOver
    await r.leaveBalances.update(balance.id, {
      pending: newPending,
      taken: newTaken,
      remaining: newRemaining,
    } as any)
  }

  logger.info({ requestId, employeeId: request.employeeId }, 'Leave request approved')
  return updated
}

export async function rejectLeaveRequest(
  requestId: string,
  userId: string,
  reason: string,
  repos?: RepositoryRegistry,
): Promise<ILeaveRequest> {
  const r = repos ?? getRepos()
  const request = await r.leaveRequests.findById(requestId)
  if (!request) throw new Error('Leave request not found')
  if (request.status !== 'pending') throw new Error('Only pending requests can be rejected')

  const updated = await r.leaveRequests.update(requestId, {
    status: 'rejected',
    approvedBy: userId,
    rejectionReason: reason,
  } as any)
  if (!updated) throw new Error('Failed to update leave request')

  // Restore pending balance
  const year = request.startDate.getFullYear()
  const balance = await r.leaveBalances.findOne({
    orgId: request.orgId,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    year,
  })

  if (balance) {
    const newPending = balance.pending - request.days
    const newRemaining = balance.entitled - balance.taken - newPending + balance.carriedOver
    await r.leaveBalances.update(balance.id, {
      pending: newPending,
      remaining: newRemaining,
    } as any)
  }

  logger.info({ requestId, reason }, 'Leave request rejected')
  return updated
}

export async function submitLeaveRequest(
  orgId: string,
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  days: number,
  halfDay: boolean,
  reason?: string,
  repos?: RepositoryRegistry,
): Promise<ILeaveRequest> {
  const r = repos ?? getRepos()

  // Check balance
  const year = startDate.getFullYear()
  const balance = await r.leaveBalances.findOne({ orgId, employeeId, leaveTypeId, year })

  if (balance && balance.remaining < days) {
    throw new Error('Insufficient leave balance')
  }

  const request = await r.leaveRequests.create({
    orgId,
    employeeId,
    leaveTypeId,
    startDate,
    endDate,
    days,
    halfDay,
    reason,
    status: 'pending',
  } as any)

  // Update pending in balance
  if (balance) {
    const newPending = balance.pending + days
    const newRemaining = balance.entitled - balance.taken - newPending + balance.carriedOver
    await r.leaveBalances.update(balance.id, {
      pending: newPending,
      remaining: newRemaining,
    } as any)
  }

  return request
}
