import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import {
  activateSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  generateSubscriptionInvoices,
} from 'services/biz/subscription.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'state', 'amountRecurring', 'nextInvoiceDate']

export const subscriptionController = new Elysia({ prefix: '/org/:orgId/subscriptions' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.read')) {
      return status(403, { message: 'Forbidden: subscriptions.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name']))
    }
    if (query.state) filter.state = query.state
    if (query.partnerId) filter.partnerId = query.partnerId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.subscriptions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      subscriptions: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.read')) {
      return status(403, { message: 'Forbidden: subscriptions.read permission required' })
    }
    const r = getRepos()
    const sub = await r.subscriptions.findOne({ id, orgId } as any)
    if (!sub) return status(404, { message: 'Subscription not found' })
    return sub
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.write')) {
      return status(403, { message: 'Forbidden: subscriptions.write permission required' })
    }
    const r = getRepos()

    // Compute line subtotals
    const lines = (body.lines || []).map((line: any) => {
      const priceSubtotal = line.quantity * line.priceUnit * (1 - (line.discount || 0) / 100)
      return {
        ...line,
        priceSubtotal: Math.round(priceSubtotal * 100) / 100,
      }
    })

    const amountRecurring = lines.reduce((sum: number, l: any) => sum + l.priceSubtotal, 0)

    const sub = await r.subscriptions.create({
      orgId,
      name: body.name,
      partnerId: body.partnerId,
      state: 'draft',
      lines,
      recurringInterval: body.recurringInterval || 1,
      recurringPeriod: body.recurringPeriod || 'month',
      dateStart: new Date(body.dateStart),
      dateEnd: body.dateEnd ? new Date(body.dateEnd) : undefined,
      nextInvoiceDate: new Date(body.nextInvoiceDate || body.dateStart),
      currency: body.currency || 'EUR',
      amountRecurring: Math.round(amountRecurring * 100) / 100,
      paymentMethod: body.paymentMethod,
      autoRenew: body.autoRenew ?? true,
      invoiceIds: [],
      notes: body.notes,
      createdBy: user.id,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, action: 'create', module: 'subscriptions',
      entityType: 'Subscription', entityId: sub.id, entityName: sub.name,
    })

    return sub
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String(),
      partnerId: t.String(),
      lines: t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        priceUnit: t.Number({ minimum: 0 }),
        discount: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
      })),
      recurringInterval: t.Optional(t.Number({ minimum: 1 })),
      recurringPeriod: t.Optional(t.String()),
      dateStart: t.String(),
      dateEnd: t.Optional(t.String()),
      nextInvoiceDate: t.Optional(t.String()),
      currency: t.Optional(t.String()),
      paymentMethod: t.Optional(t.String()),
      autoRenew: t.Optional(t.Boolean()),
      notes: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.write')) {
      return status(403, { message: 'Forbidden: subscriptions.write permission required' })
    }
    const r = getRepos()
    const existing = await r.subscriptions.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Subscription not found' })
    if (existing.state !== 'draft') {
      return status(400, { message: 'Can only edit draft subscriptions' })
    }

    const updates: any = { ...body }
    if (body.lines) {
      updates.lines = body.lines.map((line: any) => {
        const priceSubtotal = line.quantity * line.priceUnit * (1 - (line.discount || 0) / 100)
        return { ...line, priceSubtotal: Math.round(priceSubtotal * 100) / 100 }
      })
      updates.amountRecurring = Math.round(
        updates.lines.reduce((sum: number, l: any) => sum + l.priceSubtotal, 0) * 100,
      ) / 100
    }
    if (body.dateStart) updates.dateStart = new Date(body.dateStart)
    if (body.dateEnd) updates.dateEnd = new Date(body.dateEnd)
    if (body.nextInvoiceDate) updates.nextInvoiceDate = new Date(body.nextInvoiceDate)

    const updated = await r.subscriptions.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, action: 'update', module: 'subscriptions',
        entityType: 'Subscription', entityId: id, entityName: existing.name, changes,
      })
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
      lines: t.Optional(t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        priceUnit: t.Number({ minimum: 0 }),
        discount: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
      }))),
      recurringInterval: t.Optional(t.Number({ minimum: 1 })),
      recurringPeriod: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      nextInvoiceDate: t.Optional(t.String()),
      currency: t.Optional(t.String()),
      paymentMethod: t.Optional(t.String()),
      autoRenew: t.Optional(t.Boolean()),
      notes: t.Optional(t.String()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.manage')) {
      return status(403, { message: 'Forbidden: subscriptions.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.subscriptions.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Subscription not found' })
    if (existing.state !== 'draft') {
      return status(400, { message: 'Can only delete draft subscriptions' })
    }

    await r.subscriptions.delete(id)

    createAuditEntry({
      orgId, userId: user.id, action: 'delete', module: 'subscriptions',
      entityType: 'Subscription', entityId: id, entityName: existing.name,
    })

    return { message: 'Deleted' }
  }, { isSignIn: true })

  // ── ACTIONS ──

  // Activate
  .post('/:id/activate', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.manage')) {
      return status(403, { message: 'Forbidden: subscriptions.manage permission required' })
    }
    const result = await activateSubscription(id, orgId)

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'subscriptions',
      entityType: 'Subscription', entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'draft', newValue: 'active' }],
    })

    return result
  }, { isSignIn: true })

  // Pause
  .post('/:id/pause', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.manage')) {
      return status(403, { message: 'Forbidden: subscriptions.manage permission required' })
    }
    const result = await pauseSubscription(id, orgId)

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'subscriptions',
      entityType: 'Subscription', entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'active', newValue: 'paused' }],
    })

    return result
  }, { isSignIn: true })

  // Resume
  .post('/:id/resume', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.manage')) {
      return status(403, { message: 'Forbidden: subscriptions.manage permission required' })
    }
    const result = await resumeSubscription(id, orgId)

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'subscriptions',
      entityType: 'Subscription', entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'paused', newValue: 'active' }],
    })

    return result
  }, { isSignIn: true })

  // Cancel
  .post('/:id/cancel', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.manage')) {
      return status(403, { message: 'Forbidden: subscriptions.manage permission required' })
    }
    const result = await cancelSubscription(id, orgId, body.reason)

    createAuditEntry({
      orgId, userId: user.id, action: 'update', module: 'subscriptions',
      entityType: 'Subscription', entityId: id, entityName: result.name,
      changes: [
        { field: 'state', oldValue: result.state === 'cancelled' ? 'active' : result.state, newValue: 'cancelled' },
        { field: 'cancellationReason', oldValue: null, newValue: body.reason },
      ],
    })

    return result
  }, {
    isSignIn: true,
    body: t.Object({
      reason: t.String(),
    }),
  })

  // Generate invoices (background job trigger)
  .post('/generate-invoices', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('subscriptions.manage')) {
      return status(403, { message: 'Forbidden: subscriptions.manage permission required' })
    }
    const count = await generateSubscriptionInvoices(orgId)
    return { invoicesCreated: count }
  }, { isSignIn: true })
