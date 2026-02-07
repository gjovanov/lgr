import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { JournalEntry, Account } from 'db/models'

export const journalController = new Elysia({ prefix: '/org/:orgId/accounting/journal' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.fiscalPeriodId) filter.fiscalPeriodId = query.fiscalPeriodId
    if (query.startDate || query.endDate) {
      filter.date = {}
      if (query.startDate) filter.date.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.date.$lte = new Date(query.endDate as string)
    }

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      JournalEntry.find(filter).sort({ date: -1 }).skip(skip).limit(pageSize).exec(),
      JournalEntry.countDocuments(filter).exec(),
    ])

    return { journalEntries: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })

      if (Math.abs(body.totalDebit - body.totalCredit) > 0.01) {
        return error(400, { message: 'Total debit must equal total credit' })
      }

      const entry = await JournalEntry.create({
        ...body,
        orgId,
        status: 'draft',
        createdBy: user.id,
      })

      return entry
    },
    {
      isSignIn: true,
      body: t.Object({
        entryNumber: t.String({ minLength: 1 }),
        date: t.String(),
        fiscalPeriodId: t.String(),
        description: t.String({ minLength: 1 }),
        reference: t.Optional(t.String()),
        type: t.Optional(t.Union([
          t.Literal('standard'),
          t.Literal('adjusting'),
          t.Literal('closing'),
          t.Literal('reversing'),
          t.Literal('opening'),
        ])),
        lines: t.Array(t.Object({
          accountId: t.String(),
          description: t.Optional(t.String()),
          debit: t.Number({ minimum: 0 }),
          credit: t.Number({ minimum: 0 }),
          currency: t.String(),
          exchangeRate: t.Optional(t.Number()),
          baseDebit: t.Optional(t.Number()),
          baseCredit: t.Optional(t.Number()),
          contactId: t.Optional(t.String()),
          tags: t.Optional(t.Array(t.String())),
        })),
        totalDebit: t.Number(),
        totalCredit: t.Number(),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const entry = await JournalEntry.findOne({ _id: id, orgId })
      .populate('lines.accountId', 'code name')
      .exec()
    if (!entry) return error(404, { message: 'Journal entry not found' })

    return entry
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })

      const existing = await JournalEntry.findOne({ _id: id, orgId }).exec()
      if (!existing) return error(404, { message: 'Journal entry not found' })
      if (existing.status !== 'draft') return error(400, { message: 'Can only edit draft entries' })

      if (body.totalDebit !== undefined && body.totalCredit !== undefined) {
        if (Math.abs(body.totalDebit - body.totalCredit) > 0.01) {
          return error(400, { message: 'Total debit must equal total credit' })
        }
      }

      const updated = await JournalEntry.findByIdAndUpdate(id, body, { new: true }).exec()
      return updated
    },
    {
      isSignIn: true,
      body: t.Object({
        date: t.Optional(t.String()),
        description: t.Optional(t.String()),
        reference: t.Optional(t.String()),
        lines: t.Optional(t.Array(t.Object({
          accountId: t.String(),
          description: t.Optional(t.String()),
          debit: t.Number({ minimum: 0 }),
          credit: t.Number({ minimum: 0 }),
          currency: t.String(),
          exchangeRate: t.Optional(t.Number()),
          baseDebit: t.Optional(t.Number()),
          baseCredit: t.Optional(t.Number()),
        }))),
        totalDebit: t.Optional(t.Number()),
        totalCredit: t.Optional(t.Number()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const entry = await JournalEntry.findOne({ _id: id, orgId }).exec()
    if (!entry) return error(404, { message: 'Journal entry not found' })
    if (entry.status !== 'draft') return error(400, { message: 'Can only delete draft entries' })

    await JournalEntry.findByIdAndDelete(id).exec()
    return { message: 'Journal entry deleted' }
  }, { isSignIn: true })
  .post('/:id/post', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const entry = await JournalEntry.findOne({ _id: id, orgId }).exec()
    if (!entry) return error(404, { message: 'Journal entry not found' })
    if (entry.status !== 'draft') return error(400, { message: 'Entry is not in draft status' })

    entry.status = 'posted'
    entry.postedBy = user.id as any
    entry.postedAt = new Date()
    await entry.save()

    // Update account balances
    for (const line of entry.lines) {
      const amount = line.baseDebit - line.baseCredit
      await Account.findByIdAndUpdate(line.accountId, {
        $inc: { balance: amount },
      }).exec()
    }

    return entry
  }, { isSignIn: true })
  .post('/:id/void', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const entry = await JournalEntry.findOne({ _id: id, orgId }).exec()
    if (!entry) return error(404, { message: 'Journal entry not found' })
    if (entry.status !== 'posted') return error(400, { message: 'Can only void posted entries' })

    // Reverse account balances
    for (const line of entry.lines) {
      const amount = line.baseCredit - line.baseDebit
      await Account.findByIdAndUpdate(line.accountId, {
        $inc: { balance: amount },
      }).exec()
    }

    entry.status = 'voided'
    await entry.save()

    return entry
  }, { isSignIn: true })
