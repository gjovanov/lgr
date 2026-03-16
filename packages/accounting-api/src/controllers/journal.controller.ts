import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { ensureFiscalPeriod } from 'services/biz/accounting.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const journalController = new Elysia({ prefix: '/org/:orgId/accounting/journal' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.fiscalPeriodId) filter.fiscalPeriodId = query.fiscalPeriodId
    if (query.startDate || query.endDate) {
      filter.date = {}
      if (query.startDate) filter.date.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.date.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.journalEntries.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { journalEntries: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Compute totalDebit and totalCredit from lines if not provided
      const totalDebit = body.totalDebit ?? body.lines.reduce((sum, l) => sum + (l.debit || 0), 0)
      const totalCredit = body.totalCredit ?? body.lines.reduce((sum, l) => sum + (l.credit || 0), 0)

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return status(400, { message: 'Total debit must equal total credit' })
      }

      // Default currency for lines if not provided
      const lines = body.lines.map(line => ({
        ...line,
        currency: line.currency || 'EUR',
      }))

      // Auto-resolve fiscal period from date — creates FY + periods if needed
      let fiscalPeriodId = body.fiscalPeriodId
      if (!fiscalPeriodId) {
        const entryDate = new Date(body.date)
        fiscalPeriodId = await ensureFiscalPeriod(orgId, entryDate)
      }

      // Auto-generate entry number if not provided
      let entryNumber = body.entryNumber
      if (!entryNumber) {
        const year = new Date().getFullYear()
        const prefix = `JE-${year}-`
        const existing = await r.journalEntries.findMany(
          { orgId, entryNumber: { $regex: `^${prefix}` } } as any,
          { entryNumber: -1 },
        )
        if (existing.length === 0) {
          entryNumber = `${prefix}00001`
        } else {
          const currentNum = parseInt(existing[0].entryNumber.replace(prefix, ''), 10)
          entryNumber = `${prefix}${String(currentNum + 1).padStart(5, '0')}`
        }
      }

      const entry = await r.journalEntries.create({
        ...body,
        lines,
        entryNumber,
        fiscalPeriodId,
        totalDebit,
        totalCredit,
        orgId,
        status: 'draft',
        createdBy: user.id,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'journal_entry', entityId: entry.id, entityName: entry.entryNumber })

      return { journalEntry: entry }
    },
    {
      isSignIn: true,
      body: t.Object({
        entryNumber: t.Optional(t.String()),
        date: t.String(),
        fiscalPeriodId: t.Optional(t.String()),
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
          currency: t.Optional(t.String()),
          exchangeRate: t.Optional(t.Number()),
          baseDebit: t.Optional(t.Number()),
          baseCredit: t.Optional(t.Number()),
          contactId: t.Optional(t.String()),
          tags: t.Optional(t.Array(t.String())),
        })),
        totalDebit: t.Optional(t.Number()),
        totalCredit: t.Optional(t.Number()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const entry = await r.journalEntries.findOne({ id, orgId } as any)
    if (!entry) return status(404, { message: 'Journal entry not found' })

    // Manual batch lookup for account details on lines
    const accountIds = [...new Set((entry as any).lines?.map((l: any) => l.accountId).filter(Boolean) || [])]
    if (accountIds.length > 0) {
      const accounts = await r.accounts.findMany({ id: { $in: accountIds } } as any)
      const accountMap = new Map(accounts.map(a => [String(a.id), a]))
      ;(entry as any).lines = (entry as any).lines.map((l: any) => {
        const acc = accountMap.get(String(l.accountId))
        return {
          ...l,
          account: acc ? { code: (acc as any).code, name: (acc as any).name } : undefined,
        }
      })
    }

    return { journalEntry: entry }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.journalEntries.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Journal entry not found' })
      if ((existing as any).status !== 'draft') return status(400, { message: 'Can only edit draft entries' })

      if (body.totalDebit !== undefined && body.totalCredit !== undefined) {
        if (Math.abs(body.totalDebit - body.totalCredit) > 0.01) {
          return status(400, { message: 'Total debit must equal total credit' })
        }
      }

      const updated = await r.journalEntries.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'journal_entry', entityId: id, entityName: existing.entryNumber, changes: diffChanges(existing as any, updated as any) })

      return { journalEntry: updated }
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
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const entry = await r.journalEntries.findOne({ id, orgId } as any)
    if (!entry) return status(404, { message: 'Journal entry not found' })
    if ((entry as any).status !== 'draft') return status(400, { message: 'Can only delete draft entries' })

    await r.journalEntries.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'journal_entry', entityId: id, entityName: entry.entryNumber })

    return { message: 'Journal entry deleted' }
  }, { isSignIn: true })
  .post('/:id/post', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const entry = await r.journalEntries.findOne({ id, orgId } as any)
    if (!entry) return status(404, { message: 'Journal entry not found' })
    if ((entry as any).status !== 'draft') return status(400, { message: 'Entry is not in draft status' })

    const updated = await r.journalEntries.update(id, {
      status: 'posted',
      postedBy: user.id,
      postedAt: new Date(),
    } as any)

    // Update account balances
    for (const line of (entry as any).lines) {
      const amount = line.baseDebit - line.baseCredit
      const account = await r.accounts.findById(line.accountId)
      if (account) {
        await r.accounts.update(line.accountId, {
          balance: ((account as any).balance || 0) + amount,
        } as any)
      }
    }

    createAuditEntry({ orgId, userId: user.id, action: 'post', module: 'accounting', entityType: 'journal_entry', entityId: id, entityName: entry.entryNumber })

    return { journalEntry: updated }
  }, { isSignIn: true })
  .post('/:id/void', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const entry = await r.journalEntries.findOne({ id, orgId } as any)
    if (!entry) return status(404, { message: 'Journal entry not found' })
    if ((entry as any).status !== 'posted') return status(400, { message: 'Can only void posted entries' })

    // Reverse account balances
    for (const line of (entry as any).lines) {
      const amount = line.baseCredit - line.baseDebit
      const account = await r.accounts.findById(line.accountId)
      if (account) {
        await r.accounts.update(line.accountId, {
          balance: ((account as any).balance || 0) + amount,
        } as any)
      }
    }

    const updated = await r.journalEntries.update(id, { status: 'voided' } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'void', module: 'accounting', entityType: 'journal_entry', entityId: id, entityName: entry.entryNumber })

    return { journalEntry: updated }
  }, { isSignIn: true })
