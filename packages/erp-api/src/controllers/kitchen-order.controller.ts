import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { KitchenOrder } from 'db/models'

export const kitchenOrderController = new Elysia({ prefix: '/org/:orgId/erp/restaurant/kitchen' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.state) filter.state = query.state
    if (query.priority) filter.priority = query.priority
    if (query.tableNumber) filter.tableNumber = Number(query.tableNumber)

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.kitchenOrders.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { kitchenOrders: result.items, ...result }
  }, { access: { permission: 'erp.read' } })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      const r = getRepos()

      const order = await r.kitchenOrders.create({
        ...body,
        orgId,
        state: 'pending',
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'kitchen_order', entityId: order.id, entityName: `Kitchen #${order.id.slice(-6)}` })

      return { kitchenOrder: order }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        posTransactionId: t.String(),
        tableNumber: t.Optional(t.Number()),
        lines: t.Array(t.Object({
          productId: t.String(),
          productName: t.String(),
          quantity: t.Number({ minimum: 1 }),
          notes: t.Optional(t.String()),
        })),
        priority: t.Optional(t.Union([
          t.Literal('normal'),
          t.Literal('rush'),
        ])),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const order = await r.kitchenOrders.findOne({ id, orgId } as any)
    if (!order) return status(404, { message: 'Kitchen order not found' })

    return { kitchenOrder: order }
  }, { access: { permission: 'erp.read' } })

  // State transitions using atomic findOneAndUpdate
  .post('/:id/start', async ({ params: { orgId, id }, user, status }) => {
    const order = await KitchenOrder.findOneAndUpdate(
      { _id: id, orgId, state: 'pending' },
      { $set: { state: 'in_progress' } },
      { new: true },
    ).exec()

    if (!order) return status(400, { message: 'Kitchen order not found or not in pending state' })

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'kitchen_order', entityId: id, entityName: `Kitchen #${id.slice(-6)}`, changes: [{ field: 'state', oldValue: 'pending', newValue: 'in_progress' }] })

    return { kitchenOrder: order }
  }, { access: { permission: 'erp.write' } })

  .post('/:id/ready', async ({ params: { orgId, id }, user, status }) => {
    const order = await KitchenOrder.findOneAndUpdate(
      { _id: id, orgId, state: 'in_progress' },
      { $set: { state: 'ready' } },
      { new: true },
    ).exec()

    if (!order) return status(400, { message: 'Kitchen order not found or not in progress' })

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'kitchen_order', entityId: id, entityName: `Kitchen #${id.slice(-6)}`, changes: [{ field: 'state', oldValue: 'in_progress', newValue: 'ready' }] })

    return { kitchenOrder: order }
  }, { access: { permission: 'erp.write' } })

  .post('/:id/serve', async ({ params: { orgId, id }, user, status }) => {
    const order = await KitchenOrder.findOneAndUpdate(
      { _id: id, orgId, state: 'ready' },
      { $set: { state: 'served' } },
      { new: true },
    ).exec()

    if (!order) return status(400, { message: 'Kitchen order not found or not ready' })

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'kitchen_order', entityId: id, entityName: `Kitchen #${id.slice(-6)}`, changes: [{ field: 'state', oldValue: 'ready', newValue: 'served' }] })

    return { kitchenOrder: order }
  }, { access: { permission: 'erp.write' } })

  // Update individual line state
  .put(
    '/:id/line',
    async ({ params: { orgId, id }, body, user, status }) => {
      const order = await KitchenOrder.findOneAndUpdate(
        { _id: id, orgId, 'lines.productId': body.productId },
        { $set: { 'lines.$.state': body.state } },
        { new: true },
      ).exec()

      if (!order) return status(404, { message: 'Kitchen order or line not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'kitchen_order', entityId: id, entityName: `Kitchen #${id.slice(-6)}`, changes: [{ field: `line.${body.productId}.state`, oldValue: '', newValue: body.state }] })

      return { kitchenOrder: order }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        productId: t.String(),
        state: t.Union([
          t.Literal('pending'),
          t.Literal('preparing'),
          t.Literal('ready'),
          t.Literal('served'),
        ]),
      }),
    },
  )
