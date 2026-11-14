import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { ensureFiscalPeriod, JournalEntryRefusedError, postJournalEntry, voidJournalEntry } from 'services/biz/accounting.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { listJournalEntries, withHeaderReferences } from 'services/biz/journal-header.service'
import {
  BOOKS_SOURCE_MODULE, JOURNAL_HEADER_FIELDS, headerProblems, headerUpdateOf, isAsBooked, mergedHeader,
  type HeaderProblem, type JournalHeaderInput,
} from 'config/journal-header'

interface LineInput {
  debit: number
  credit: number
  currency?: string
  exchangeRate?: number
  baseDebit?: number
  baseCredit?: number
}

/**
 * A line as it is stored. Every statement and balance reads the base amounts, and the entry form
 * sends only `debit` and `credit`: left to the model's default of 0, an entry typed by hand reached
 * no statement at all.
 */
function storedLine<L extends LineInput>(line: L) {
  const exchangeRate = line.exchangeRate ?? 1
  return {
    ...line,
    currency: line.currency || 'EUR',
    exchangeRate,
    baseDebit: line.baseDebit ?? Math.round(line.debit * exchangeRate * 100) / 100,
    baseCredit: line.baseCredit ?? Math.round(line.credit * exchangeRate * 100) / 100,
  }
}

// ── FR-25a §3.6: the document header ──────────────────────────────────────────────────────────────

/** A header field a person may clear: `null` removes it. */
const text = (maxLength: number) => t.Optional(t.Union([t.String({ maxLength }), t.Null()]))
const amount = t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()]))
const day = t.Optional(t.Union([t.String({ maxLength: 40 }), t.Null()]))

/** What an entry made in LGR may say of its document. `docOptions` and `source` are the books import's alone. */
const headerBody = {
  docType: text(20),
  docNumber: text(40),
  docDate: day,
  registerDocType: text(2),
  reasonRef: text(200),
  paymentCode: text(2),
  paidAmount: amount,
  paidCash: amount,
  bankOperation: text(100),
  vatKind: text(20),
  vatRate: t.Optional(t.Union([t.Number(), t.Null()])),
  vatRule: text(200),
  vatExemptionReason: text(300),
  taxEventDate: day,
  reportingMonth: text(6),
  protocolType: text(20),
  customsRef: text(40),
  links: t.Optional(t.Union([
    t.Array(t.Object({
      docType: t.String({ minLength: 1, maxLength: 20 }),
      docNumber: t.String({ minLength: 1, maxLength: 40 }),
      date: t.Optional(t.Union([t.String({ maxLength: 40 }), t.Null()])),
      amount: t.Optional(t.Union([t.Number(), t.Null()])),
      amountFx: t.Optional(t.Union([t.Number(), t.Null()])),
    }), { maxItems: 100 }),
    t.Null(),
  ])),
}

/** The body without its header, and the header alone. */
function splitHeader<B extends Record<string, unknown>>(body: B) {
  const rest: Record<string, unknown> = { ...body }
  const header: Record<string, unknown> = {}
  for (const field of JOURNAL_HEADER_FIELDS) {
    if (field in rest) {
      header[field] = rest[field]
      delete rest[field]
    }
  }
  return { rest, header: header as JournalHeaderInput }
}

const AS_BOOKED = {
  code: 'journal_entry_as_booked',
  message: 'This entry is as booked in the accountant\'s program: the books import wrote it, and it is changed there, not here.',
} as const

function headerRefusal(problems: HeaderProblem[]) {
  return {
    code: 'journal_header_invalid',
    message: `The document header is not valid: ${problems.map(p => `${p.field} (${p.code})`).join(', ')}`,
    problems,
  }
}

export const journalController = new Elysia({ prefix: '/org/:orgId/accounting/journal' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    // FR-25a: the entries without their lines, and the header's filters (`journal-header.service.ts`).
    const result = await listJournalEntries(orgId, query)
    return { journalEntries: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body: fullBody, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // FR-25a: an entry made here is LGR's own, so its header is the person's to state, by the same rules as an edit.
      const { rest, header } = splitHeader(fullBody)
      const body = rest as typeof fullBody
      const headerUpdate = headerUpdateOf(header)
      const problems = headerProblems(mergedHeader({}, headerUpdate))
      if (problems.length) return status(422, headerRefusal(problems))

      // Compute totalDebit and totalCredit from lines if not provided
      const totalDebit = body.totalDebit ?? body.lines.reduce((sum, l) => sum + (l.debit || 0), 0)
      const totalCredit = body.totalCredit ?? body.lines.reduce((sum, l) => sum + (l.credit || 0), 0)

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return status(400, { message: 'Total debit must equal total credit' })
      }

      const lines = body.lines.map(storedLine)

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
        ...headerUpdate.set,
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
        ...headerBody,
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
      const accounts = await r.accounts.findMany({ orgId, id: { $in: accountIds } } as any)
      const accountMap = new Map(accounts.map(a => [String(a.id), a]))
      ;(entry as any).lines = (entry as any).lines.map((l: any) => {
        const acc = accountMap.get(String(l.accountId))
        return {
          ...l,
          account: acc ? { code: (acc as any).code, name: (acc as any).name } : undefined,
        }
      })
    }

    // FR-25a: each link with the entry it names, and the partner the links are matched by.
    return { journalEntry: await withHeaderReferences(orgId, entry as any) }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body: fullBody, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.journalEntries.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Journal entry not found' })
      // FR-25a: what the books import wrote is as booked, for everyone and whatever the body holds.
      if (isAsBooked(existing)) return status(422, AS_BOOKED)
      if ((existing as any).status !== 'draft') return status(400, { message: 'Can only edit draft entries' })

      const { rest, header } = splitHeader(fullBody)
      const body = rest as typeof fullBody
      const headerUpdate = headerUpdateOf(header)
      const problems = headerProblems(mergedHeader(existing as any, headerUpdate))
      if (problems.length) return status(422, headerRefusal(problems))

      // New lines bring new totals: posting checks the totals, so stale ones would let it through unbalanced.
      const totalDebit = body.totalDebit ?? body.lines?.reduce((sum, l) => sum + (l.debit || 0), 0)
      const totalCredit = body.totalCredit ?? body.lines?.reduce((sum, l) => sum + (l.credit || 0), 0)

      if (totalDebit !== undefined && totalCredit !== undefined) {
        if (Math.abs(totalDebit - totalCredit) > 0.01) {
          return status(400, { message: 'Total debit must equal total credit' })
        }
      }

      // The draft, LGR's own, at the moment of the write: a post or an import between the checks and here changes nothing.
      const updated = await r.journalEntries.updateInOrg(id, orgId, {
        ...body,
        ...headerUpdate.set,
        ...(body.lines ? { lines: body.lines.map(storedLine), totalDebit, totalCredit } : {}),
      } as any, { status: 'draft', sourceModule: { $ne: BOOKS_SOURCE_MODULE } }, { unset: headerUpdate.unset })
      if (!updated) return status(409, { message: 'The entry changed meanwhile: it is no longer a draft of LGR\'s own.' })

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
          currency: t.Optional(t.String()),
          exchangeRate: t.Optional(t.Number()),
          baseDebit: t.Optional(t.Number()),
          baseCredit: t.Optional(t.Number()),
        }))),
        totalDebit: t.Optional(t.Number()),
        totalCredit: t.Optional(t.Number()),
        ...headerBody,
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const entry = await r.journalEntries.findOne({ id, orgId } as any)
    if (!entry) return status(404, { message: 'Journal entry not found' })
    if ((entry as any).status !== 'draft') return status(400, { message: 'Can only delete draft entries' })

    await r.journalEntries.deleteInOrg(id, orgId)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'journal_entry', entityId: id, entityName: entry.entryNumber })

    return { message: 'Journal entry deleted' }
  }, { isSignIn: true })
  .post('/:id/post', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const entry = await r.journalEntries.findOne({ id, orgId } as any)
    if (!entry) return status(404, { message: 'Journal entry not found' })
    if ((entry as any).status !== 'draft') return status(400, { message: 'Entry is not in draft status' })

    let updated
    try {
      updated = await postJournalEntry(id, user.id)
    } catch (err) {
      if (err instanceof JournalEntryRefusedError) return status(400, { message: err.message })
      throw err
    }

    createAuditEntry({ orgId, userId: user.id, action: 'post', module: 'accounting', entityType: 'journal_entry', entityId: id, entityName: entry.entryNumber })

    return { journalEntry: updated }
  }, { isSignIn: true })
  .post('/:id/void', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const entry = await r.journalEntries.findOne({ id, orgId } as any)
    if (!entry) return status(404, { message: 'Journal entry not found' })
    // FR-25a: voiding an imported entry would change the books the accountant filed, and the next import would not know.
    if (isAsBooked(entry)) return status(422, AS_BOOKED)
    if ((entry as any).status !== 'posted') return status(400, { message: 'Can only void posted entries' })

    let updated
    try {
      updated = await voidJournalEntry(id)
    } catch (err) {
      if (err instanceof JournalEntryRefusedError) return status(400, { message: err.message })
      throw err
    }

    createAuditEntry({ orgId, userId: user.id, action: 'void', module: 'accounting', entityType: 'journal_entry', entityId: id, entityName: entry.entryNumber })

    return { journalEntry: updated }
  }, { isSignIn: true })
