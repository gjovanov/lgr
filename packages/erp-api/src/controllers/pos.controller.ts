import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry } from 'services/biz/audit-log.service'

export const posController = new Elysia({ prefix: '/org/:orgId/erp/pos' })
  .use(AppAuthService)
  .post(
    '/session',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Generate session number
      const lastResult = await r.posSessions.findAll(
        { orgId } as any,
        { page: 0, size: 1, sort: { createdAt: -1 } },
      )
      const lastSession = lastResult.items[0]
      const seq = lastSession
        ? Number((lastSession as any).sessionNumber.replace(/\D/g, '')) + 1
        : 1
      const sessionNumber = `POS-${String(seq).padStart(6, '0')}`

      const session = await r.posSessions.create({
        ...body,
        orgId,
        sessionNumber,
        cashierId: user.id,
        openedAt: new Date(),
        status: 'open',
        totalSales: 0,
        totalReturns: 0,
        totalCash: 0,
        totalCard: 0,
        transactionCount: 0,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'pos_session', entityId: session.id, entityName: sessionNumber })

      return { session }
    },
    {
      isSignIn: true,
      body: t.Object({
        warehouseId: t.String(),
        openingBalance: t.Number({ minimum: 0 }),
        currency: t.String(),
      }),
    },
  )
  .get('/session', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.cashierId) filter.cashierId = query.cashierId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'openedAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.posSessions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { sessions: result.items, ...result }
  }, { isSignIn: true })
  .get('/session/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const session = await r.posSessions.findOne({ id, orgId } as any)
    if (!session) return status(404, { message: 'POS session not found' })

    return { session }
  }, { isSignIn: true })
  .post(
    '/session/:id/close',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const session = await r.posSessions.findOne({ id, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })
      if (session.status === 'closed') return status(400, { message: 'Session already closed' })

      const expectedBalance = session.openingBalance + session.totalCash
      const updated = await r.posSessions.update(id, {
        status: 'closed',
        closedAt: new Date(),
        closingBalance: body.closingBalance,
        expectedBalance,
        difference: body.closingBalance - (expectedBalance || 0),
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'close', module: 'erp', entityType: 'pos_session', entityId: id, entityName: session.sessionNumber })

      return { session: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        closingBalance: t.Number(),
      }),
    },
  )
  .post(
    '/session/:id/transaction',
    async ({ params: { orgId, id: sessionId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })
      if (session.status === 'closed') return status(400, { message: 'Session is closed' })

      // Generate transaction number
      const lastResult = await r.posTransactions.findAll(
        { orgId, sessionId } as any,
        { page: 0, size: 1, sort: { createdAt: -1 } },
      )
      const lastTxn = lastResult.items[0]
      const seq = lastTxn
        ? Number((lastTxn as any).transactionNumber.replace(/\D/g, '')) + 1
        : 1
      const transactionNumber = `TXN-${String(seq).padStart(8, '0')}`

      const transaction = await r.posTransactions.create({
        ...body,
        orgId,
        sessionId,
        transactionNumber,
        createdBy: user.id,
      } as any)

      // Update session totals
      const updateData: Record<string, any> = {
        transactionCount: session.transactionCount + 1,
      }

      if (body.type === 'sale') {
        updateData.totalSales = session.totalSales + body.total
      } else if (body.type === 'return') {
        updateData.totalReturns = session.totalReturns + body.total
      }

      const cashPayment = body.payments
        .filter((p: any) => p.method === 'cash')
        .reduce((s: number, p: any) => s + p.amount, 0)
      const cardPayment = body.payments
        .filter((p: any) => p.method === 'card')
        .reduce((s: number, p: any) => s + p.amount, 0)

      updateData.totalCash = session.totalCash + cashPayment
      updateData.totalCard = session.totalCard + cardPayment

      await r.posSessions.update(sessionId, updateData as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'pos_transaction', entityId: transaction.id, entityName: transactionNumber })

      return { transaction }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Union([
          t.Literal('sale'),
          t.Literal('return'),
          t.Literal('exchange'),
        ]),
        customerId: t.Optional(t.String()),
        lines: t.Array(t.Object({
          productId: t.String(),
          name: t.String(),
          quantity: t.Number({ minimum: 1 }),
          unitPrice: t.Number(),
          discount: t.Optional(t.Number()),
          taxRate: t.Optional(t.Number()),
          taxAmount: t.Optional(t.Number()),
          lineTotal: t.Number(),
          priceExplanation: t.Optional(t.Array(t.Object({
            type: t.Union([t.Literal('base'), t.Literal('tag'), t.Literal('contact'), t.Literal('override')]),
            label: t.String(),
            price: t.Number(),
          }))),
        })),
        subtotal: t.Number(),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        total: t.Number(),
        payments: t.Array(t.Object({
          method: t.Union([
            t.Literal('cash'),
            t.Literal('card'),
            t.Literal('mobile'),
            t.Literal('voucher'),
          ]),
          amount: t.Number(),
          reference: t.Optional(t.String()),
        })),
        changeDue: t.Optional(t.Number()),
      }),
    },
  )
  .get('/session/:id/transaction', async ({ params: { orgId, id: sessionId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId, sessionId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.posTransactions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { transactions: result.items, ...result }
  }, { isSignIn: true })
