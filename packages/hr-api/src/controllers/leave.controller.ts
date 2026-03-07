import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const leaveController = new Elysia({ prefix: '/org/:orgId/hr/leave-request' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.employeeId) filter.employeeId = query.employeeId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.leaveRequests.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { leaveRequests: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const request = await r.leaveRequests.create({
        ...body,
        orgId,
        status: 'pending',
      } as any)

      // Update leave balance pending count
      const year = new Date(body.startDate).getFullYear()
      const balance = await r.leaveBalances.findOne({
        orgId, employeeId: body.employeeId, leaveTypeId: body.leaveTypeId, year,
      } as any)
      if (balance) {
        await r.leaveBalances.update(balance.id, {
          pending: (balance as any).pending + body.days,
        } as any)
      }

      return { leaveRequest: request }
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
    const r = getRepos()

    const request = await r.leaveRequests.findOne({ id, orgId } as any)
    if (!request) return status(404, { message: 'Leave request not found' })

    return { leaveRequest: request }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.leaveRequests.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Leave request not found' })
      if (existing.status !== 'pending')
        return status(400, { message: 'Can only edit pending requests' })

      const updated = await r.leaveRequests.update(id, body as any)
      return { leaveRequest: updated }
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
    const r = getRepos()

    const request = await r.leaveRequests.findOne({ id, orgId } as any)
    if (!request) return status(404, { message: 'Leave request not found' })
    if (request.status !== 'pending')
      return status(400, { message: 'Can only cancel pending requests' })

    await r.leaveRequests.update(id, { status: 'cancelled' } as any)

    // Reverse pending balance
    const year = new Date(request.startDate).getFullYear()
    const balance = await r.leaveBalances.findOne({
      orgId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year,
    } as any)
    if (balance) {
      await r.leaveBalances.update(balance.id, {
        pending: (balance as any).pending - request.days,
      } as any)
    }

    return { message: 'Leave request cancelled' }
  }, { isSignIn: true })
  .post('/:id/approve', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })
    const r = getRepos()

    const request = await r.leaveRequests.findOne({ id, orgId } as any)
    if (!request) return status(404, { message: 'Leave request not found' })
    if (request.status !== 'pending')
      return status(400, { message: 'Can only approve pending requests' })

    const updatedRequest = await r.leaveRequests.update(id, {
      status: 'approved',
      approvedBy: user.id,
      approvedAt: new Date(),
    } as any)

    // Update leave balance: move from pending to taken
    const year = new Date(request.startDate).getFullYear()
    const balance = await r.leaveBalances.findOne({
      orgId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year,
    } as any)
    if (balance) {
      await r.leaveBalances.update(balance.id, {
        pending: (balance as any).pending - request.days,
        taken: (balance as any).taken + request.days,
        remaining: (balance as any).remaining - request.days,
      } as any)
    }

    return { leaveRequest: updatedRequest }
  }, { isSignIn: true })
  .post(
    '/:id/reject',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })
      const r = getRepos()

      const request = await r.leaveRequests.findOne({ id, orgId } as any)
      if (!request) return status(404, { message: 'Leave request not found' })
      if (request.status !== 'pending')
        return status(400, { message: 'Can only reject pending requests' })

      const updatedRequest = await r.leaveRequests.update(id, {
        status: 'rejected',
        rejectionReason: body?.reason,
        approvedBy: user.id,
        approvedAt: new Date(),
      } as any)

      // Reverse pending balance
      const year = new Date(request.startDate).getFullYear()
      const balance = await r.leaveBalances.findOne({
        orgId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year,
      } as any)
      if (balance) {
        await r.leaveBalances.update(balance.id, {
          pending: (balance as any).pending - request.days,
        } as any)
      }

      return { leaveRequest: updatedRequest }
    },
    {
      isSignIn: true,
      body: t.Object({
        reason: t.Optional(t.String()),
      }),
    },
  )
