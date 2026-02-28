import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { LeaveRequest, LeaveBalance } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const leaveController = new Elysia({ prefix: '/org/:orgId/hr/leave-request' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.employeeId) filter.employeeId = query.employeeId

    const result = await paginateQuery(LeaveRequest, filter, query)
    return { leaveRequests: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const request = await LeaveRequest.create({
        ...body,
        orgId,
        status: 'pending',
      })

      // Update leave balance pending count
      const year = new Date(body.startDate).getFullYear()
      await LeaveBalance.findOneAndUpdate(
        { orgId, employeeId: body.employeeId, leaveTypeId: body.leaveTypeId, year },
        { $inc: { pending: body.days } },
      ).exec()

      return request.toJSON()
    },
    {
      isSignIn: true,
      body: t.Object({
        employeeId: t.String(),
        leaveTypeId: t.String(),
        startDate: t.String(),
        endDate: t.String(),
        days: t.Number({ minimum: 0.5 }),
        halfDay: t.Optional(t.Boolean()),
        reason: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const request = await LeaveRequest.findOne({ _id: id, orgId }).lean().exec()
    if (!request) return status(404, { message: 'Leave request not found' })

    return request
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const existing = await LeaveRequest.findOne({ _id: id, orgId }).exec()
      if (!existing) return status(404, { message: 'Leave request not found' })
      if (existing.status !== 'pending')
        return status(400, { message: 'Can only edit pending requests' })

      const updated = await LeaveRequest.findByIdAndUpdate(id, body, { new: true }).lean().exec()
      return updated
    },
    {
      isSignIn: true,
      body: t.Object({
        startDate: t.Optional(t.String()),
        endDate: t.Optional(t.String()),
        days: t.Optional(t.Number({ minimum: 0.5 })),
        halfDay: t.Optional(t.Boolean()),
        reason: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const request = await LeaveRequest.findOne({ _id: id, orgId }).exec()
    if (!request) return status(404, { message: 'Leave request not found' })
    if (request.status !== 'pending')
      return status(400, { message: 'Can only cancel pending requests' })

    request.status = 'cancelled'
    await request.save()

    // Reverse pending balance
    const year = new Date(request.startDate).getFullYear()
    await LeaveBalance.findOneAndUpdate(
      { orgId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
      { $inc: { pending: -request.days } },
    ).exec()

    return { message: 'Leave request cancelled' }
  }, { isSignIn: true })
  .post('/:id/approve', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })

    const request = await LeaveRequest.findOne({ _id: id, orgId }).exec()
    if (!request) return status(404, { message: 'Leave request not found' })
    if (request.status !== 'pending')
      return status(400, { message: 'Can only approve pending requests' })

    request.status = 'approved'
    request.approvedBy = user.id as any
    request.approvedAt = new Date()
    await request.save()

    // Update leave balance: move from pending to taken
    const year = new Date(request.startDate).getFullYear()
    await LeaveBalance.findOneAndUpdate(
      { orgId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
      {
        $inc: { pending: -request.days, taken: request.days, remaining: -request.days },
      },
    ).exec()

    return request.toJSON()
  }, { isSignIn: true })
  .post(
    '/:id/reject',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })

      const request = await LeaveRequest.findOne({ _id: id, orgId }).exec()
      if (!request) return status(404, { message: 'Leave request not found' })
      if (request.status !== 'pending')
        return status(400, { message: 'Can only reject pending requests' })

      request.status = 'rejected'
      request.rejectionReason = body?.reason
      request.approvedBy = user.id as any
      request.approvedAt = new Date()
      await request.save()

      // Reverse pending balance
      const year = new Date(request.startDate).getFullYear()
      await LeaveBalance.findOneAndUpdate(
        { orgId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
        { $inc: { pending: -request.days } },
      ).exec()

      return request.toJSON()
    },
    {
      isSignIn: true,
      body: t.Object({
        reason: t.Optional(t.String()),
      }),
    },
  )
