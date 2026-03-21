import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const vehicleCostController = new Elysia({ prefix: '/org/:orgId/fleet/costs' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('fleet.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.vehicleId) filter.vehicleId = query.vehicleId
    if (query.type) filter.type = query.type
    if (query.dateFrom || query.dateTo) {
      filter.date = {}
      if (query.dateFrom) filter.date.$gte = new Date(query.dateFrom as string)
      if (query.dateTo) filter.date.$lte = new Date(query.dateTo as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'date'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.vehicleCosts.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { vehicleCosts: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('fleet.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      // Verify vehicle exists
      const vehicle = await r.vehicles.findOne({ id: body.vehicleId, orgId } as any)
      if (!vehicle) return status(404, { message: 'Vehicle not found' })

      if (body.amount <= 0)
        return status(400, { message: 'Amount must be positive' })

      const cost = await r.vehicleCosts.create({
        ...body,
        orgId,
      } as any)

      // Update vehicle odometer if provided on cost
      if (body.odometer !== undefined && body.odometer > (vehicle as any).odometer) {
        await r.vehicles.update(body.vehicleId, { odometer: body.odometer } as any)
      }

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'fleet', entityType: 'vehicle_cost', entityId: cost.id, entityName: `${body.type} - ${(vehicle as any).name}` })

      return { vehicleCost: cost }
    },
    {
      isSignIn: true,
      body: t.Object({
        vehicleId: t.String(),
        type: t.Union([
          t.Literal('fuel'),
          t.Literal('insurance'),
          t.Literal('maintenance'),
          t.Literal('repair'),
          t.Literal('tax'),
          t.Literal('toll'),
          t.Literal('parking'),
          t.Literal('fine'),
          t.Literal('other'),
        ]),
        amount: t.Number({ minimum: 0 }),
        date: t.String(),
        vendorId: t.Optional(t.String()),
        odometer: t.Optional(t.Number({ minimum: 0 })),
        description: t.Optional(t.String()),
        isRecurring: t.Optional(t.Boolean()),
        recurringInterval: t.Optional(t.Number({ minimum: 1 })),
        recurringPeriod: t.Optional(t.Union([
          t.Literal('daily'),
          t.Literal('weekly'),
          t.Literal('monthly'),
          t.Literal('yearly'),
        ])),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('fleet.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const cost = await r.vehicleCosts.findOne({ id, orgId } as any)
    if (!cost) return status(404, { message: 'Vehicle cost not found' })

    return { vehicleCost: cost }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('fleet.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.vehicleCosts.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Vehicle cost not found' })

      if (body.amount !== undefined && body.amount <= 0)
        return status(400, { message: 'Amount must be positive' })

      const cost = await r.vehicleCosts.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'fleet', entityType: 'vehicle_cost', entityId: id, entityName: `${(cost as any).type} cost`, changes: diffChanges(existing as any, cost as any) })

      return { vehicleCost: cost }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Optional(t.String()),
        amount: t.Optional(t.Number({ minimum: 0 })),
        date: t.Optional(t.String()),
        vendorId: t.Optional(t.String()),
        odometer: t.Optional(t.Number({ minimum: 0 })),
        description: t.Optional(t.String()),
        isRecurring: t.Optional(t.Boolean()),
        recurringInterval: t.Optional(t.Number({ minimum: 1 })),
        recurringPeriod: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('fleet.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.vehicleCosts.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Vehicle cost not found' })

    await r.vehicleCosts.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'fleet', entityType: 'vehicle_cost', entityId: id, entityName: `${(existing as any).type} cost` })

    return { message: 'Vehicle cost deleted' }
  }, { isSignIn: true })
