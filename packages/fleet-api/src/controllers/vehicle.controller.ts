import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const vehicleController = new Elysia({ prefix: '/org/:orgId/fleet/vehicles' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('fleet.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'model', 'brand'])
      Object.assign(filter, searchFilter)
    }
    if (query.state) filter.state = query.state
    if (query.fuelType) filter.fuelType = query.fuelType
    if (query.driverId) filter.driverId = query.driverId

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.vehicles.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { vehicles: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('fleet.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      if (body.odometer !== undefined && body.odometer < 0)
        return status(400, { message: 'Odometer cannot be negative' })
      if (body.purchaseValue !== undefined && body.purchaseValue < 0)
        return status(400, { message: 'Purchase value cannot be negative' })

      const vehicle = await r.vehicles.create({
        ...body,
        orgId,
        state: body.state || 'active',
        odometer: body.odometer || 0,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'fleet', entityType: 'vehicle', entityId: vehicle.id, entityName: (vehicle as any).name })

      return { vehicle }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        model: t.String({ minLength: 1 }),
        brand: t.String({ minLength: 1 }),
        driverId: t.Optional(t.String()),
        state: t.Optional(t.Union([
          t.Literal('active'),
          t.Literal('in_service'),
          t.Literal('out_of_service'),
          t.Literal('sold'),
          t.Literal('scrapped'),
        ])),
        acquisitionDate: t.Optional(t.String()),
        purchaseValue: t.Optional(t.Number({ minimum: 0 })),
        fuelType: t.Optional(t.Union([
          t.Literal('gasoline'),
          t.Literal('diesel'),
          t.Literal('electric'),
          t.Literal('hybrid'),
          t.Literal('lpg'),
          t.Literal('cng'),
          t.Literal('hydrogen'),
        ])),
        odometer: t.Optional(t.Number({ minimum: 0 })),
        nextServiceDate: t.Optional(t.String()),
        insuranceExpiry: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('fleet.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const vehicle = await r.vehicles.findOne({ id, orgId } as any)
    if (!vehicle) return status(404, { message: 'Vehicle not found' })

    return { vehicle }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('fleet.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.vehicles.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Vehicle not found' })

      if (body.odometer !== undefined && body.odometer < (existing as any).odometer)
        return status(400, { message: 'Odometer cannot decrease' })

      const vehicle = await r.vehicles.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'fleet', entityType: 'vehicle', entityId: id, entityName: (vehicle as any).name, changes: diffChanges(existing as any, vehicle as any) })

      return { vehicle }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        model: t.Optional(t.String()),
        brand: t.Optional(t.String()),
        driverId: t.Optional(t.String()),
        state: t.Optional(t.Union([
          t.Literal('active'),
          t.Literal('in_service'),
          t.Literal('out_of_service'),
          t.Literal('sold'),
          t.Literal('scrapped'),
        ])),
        acquisitionDate: t.Optional(t.String()),
        purchaseValue: t.Optional(t.Number({ minimum: 0 })),
        fuelType: t.Optional(t.String()),
        odometer: t.Optional(t.Number({ minimum: 0 })),
        nextServiceDate: t.Optional(t.String()),
        insuranceExpiry: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('fleet.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.vehicles.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Vehicle not found' })

    await r.vehicles.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'fleet', entityType: 'vehicle', entityId: id, entityName: (existing as any).name })

    return { message: 'Vehicle deactivated' }
  }, { isSignIn: true })
