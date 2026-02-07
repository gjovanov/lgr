import { LeaveRequest, LeaveBalance, type ILeaveRequest } from 'db/models'
import { logger } from '../logger/logger.js'

export async function approveLeaveRequest(requestId: string, userId: string): Promise<ILeaveRequest> {
  const request = await LeaveRequest.findById(requestId)
  if (!request) throw new Error('Leave request not found')
  if (request.status !== 'pending') throw new Error('Only pending requests can be approved')

  request.status = 'approved'
  request.approvedBy = userId as any
  request.approvedAt = new Date()
  await request.save()

  // Update leave balance
  const year = request.startDate.getFullYear()
  const balance = await LeaveBalance.findOne({
    orgId: request.orgId,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    year,
  })

  if (balance) {
    balance.pending -= request.days
    balance.taken += request.days
    balance.remaining = balance.entitled - balance.taken - balance.pending + balance.carriedOver
    await balance.save()
  }

  logger.info({ requestId, employeeId: request.employeeId }, 'Leave request approved')
  return request
}

export async function rejectLeaveRequest(
  requestId: string,
  userId: string,
  reason: string,
): Promise<ILeaveRequest> {
  const request = await LeaveRequest.findById(requestId)
  if (!request) throw new Error('Leave request not found')
  if (request.status !== 'pending') throw new Error('Only pending requests can be rejected')

  request.status = 'rejected'
  request.approvedBy = userId as any
  request.rejectionReason = reason
  await request.save()

  // Restore pending balance
  const year = request.startDate.getFullYear()
  const balance = await LeaveBalance.findOne({
    orgId: request.orgId,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    year,
  })

  if (balance) {
    balance.pending -= request.days
    balance.remaining = balance.entitled - balance.taken - balance.pending + balance.carriedOver
    await balance.save()
  }

  logger.info({ requestId, reason }, 'Leave request rejected')
  return request
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
): Promise<ILeaveRequest> {
  // Check balance
  const year = startDate.getFullYear()
  let balance = await LeaveBalance.findOne({ orgId, employeeId, leaveTypeId, year })

  if (balance && balance.remaining < days) {
    throw new Error('Insufficient leave balance')
  }

  const request = await LeaveRequest.create({
    orgId,
    employeeId,
    leaveTypeId,
    startDate,
    endDate,
    days,
    halfDay,
    reason,
    status: 'pending',
  })

  // Update pending in balance
  if (balance) {
    balance.pending += days
    balance.remaining = balance.entitled - balance.taken - balance.pending + balance.carriedOver
    await balance.save()
  }

  return request
}
