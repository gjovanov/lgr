import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { POSSession, POSTransaction } from 'db/models'

export const posController = new Elysia({ prefix: '/org/:orgId/erp/pos' })
  .use(AppAuthService)
  .post(
    '/session',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // Generate session number
      const lastSession = await POSSession.findOne({ orgId })
        .sort({ createdAt: -1 })
        .exec()
      const seq = lastSession
        ? Number(lastSession.sessionNumber.replace(/\D/g, '')) + 1
        : 1
      const sessionNumber = `POS-${String(seq).padStart(6, '0')}`

      const session = await POSSession.create({
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
      })

      return { session: session.toJSON() }
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

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.cashierId) filter.cashierId = query.cashierId

    const sessions = await POSSession.find(filter).sort({ openedAt: -1 }).exec()
    return { sessions }
  }, { isSignIn: true })
  .get('/session/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const session = await POSSession.findOne({ _id: id, orgId }).lean().exec()
    if (!session) return status(404, { message: 'POS session not found' })

    return { session }
  }, { isSignIn: true })
  .post(
    '/session/:id/close',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const session = await POSSession.findOne({ _id: id, orgId }).exec()
      if (!session) return status(404, { message: 'POS session not found' })
      if (session.status === 'closed') return status(400, { message: 'Session already closed' })

      session.status = 'closed'
      session.closedAt = new Date()
      session.closingBalance = body.closingBalance
      session.expectedBalance = session.openingBalance + session.totalCash
      session.difference = body.closingBalance - (session.expectedBalance || 0)
      await session.save()

      return { session: session.toJSON() }
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

      const session = await POSSession.findOne({ _id: sessionId, orgId }).exec()
      if (!session) return status(404, { message: 'POS session not found' })
      if (session.status === 'closed') return status(400, { message: 'Session is closed' })

      // Generate transaction number
      const lastTxn = await POSTransaction.findOne({ orgId, sessionId })
        .sort({ createdAt: -1 })
        .exec()
      const seq = lastTxn
        ? Number(lastTxn.transactionNumber.replace(/\D/g, '')) + 1
        : 1
      const transactionNumber = `TXN-${String(seq).padStart(8, '0')}`

      const transaction = await POSTransaction.create({
        ...body,
        orgId,
        sessionId,
        transactionNumber,
        createdBy: user.id,
      })

      // Update session totals
      if (body.type === 'sale') {
        session.totalSales += body.total
      } else if (body.type === 'return') {
        session.totalReturns += body.total
      }

      const cashPayment = body.payments
        .filter((p: any) => p.method === 'cash')
        .reduce((s: number, p: any) => s + p.amount, 0)
      const cardPayment = body.payments
        .filter((p: any) => p.method === 'card')
        .reduce((s: number, p: any) => s + p.amount, 0)

      session.totalCash += cashPayment
      session.totalCard += cardPayment
      session.transactionCount += 1
      await session.save()

      return { transaction: transaction.toJSON() }
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
  .get('/session/:id/transaction', async ({ params: { orgId, id: sessionId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const transactions = await POSTransaction.find({ orgId, sessionId }).sort({ createdAt: -1 }).exec()
    return { transactions }
  }, { isSignIn: true })
