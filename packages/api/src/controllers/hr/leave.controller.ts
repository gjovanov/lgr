import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { LeaveRequest, LeaveBalance } from 'db/models'

export const leaveController = new Elysia({ prefix: '/org/:orgId/hr/leave-request' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.employeeId) filter.employeeId = query.employeeId

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      LeaveRequest.find(filter).sort({ startDate: -1 }).skip(skip).limit(pageSize).exec(),
      LeaveRequest.countDocuments(filter).exec(),
    ])

    return { leaveRequests: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })

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

      return request
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
  .get('/:id', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const request = await LeaveRequest.findOne({ _id: id, orgId }).exec()
    if (!request) return error(404, { message: 'Leave request not found' })

    return request
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })

      const existing = await LeaveRequest.findOne({ _id: id, orgId }).exec()
      if (!existing) return error(404, { message: 'Leave request not found' })
      if (existing.status !== 'pending')
        return error(400, { message: 'Can only edit pending requests' })

      const updated = await LeaveRequest.findByIdAndUpdate(id, body, { new: true }).exec()
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
  .delete('/:id', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const request = await LeaveRequest.findOne({ _id: id, orgId }).exec()
    if (!request) return error(404, { message: 'Leave request not found' })
    if (request.status !== 'pending')
      return error(400, { message: 'Can only cancel pending requests' })

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
  .post('/:id/approve', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return error(403, { message: 'Admin or HR manager only' })

    const request = await LeaveRequest.findOne({ _id: id, orgId }).exec()
    if (!request) return error(404, { message: 'Leave request not found' })
    if (request.status !== 'pending')
      return error(400, { message: 'Can only approve pending requests' })

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

    return request
  }, { isSignIn: true })
  .post(
    '/:id/reject',
    async ({ params: { orgId, id }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return error(403, { message: 'Admin or HR manager only' })

      const request = await LeaveRequest.findOne({ _id: id, orgId }).exec()
      if (!request) return error(404, { message: 'Leave request not found' })
      if (request.status !== 'pending')
        return error(400, { message: 'Can only reject pending requests' })

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

      return request
    },
    {
      isSignIn: true,
      body: t.Object({
        reason: t.Optional(t.String()),
      }),
    },
  )
