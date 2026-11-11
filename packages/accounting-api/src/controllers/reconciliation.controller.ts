import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { clientCreate, clientUpdate } from 'services/biz/server-owned'
import {
  ReconciliationError, addStatementLines, completeReconciliation, matchLines, reconciliationView, removeStatementLine, unmatchLines,
} from 'services/biz/bank-reconciliation/bank-reconciliation.service'
import { parseStatementCsv } from 'services/biz/bank-reconciliation/statement-csv'

/** A refusal of the reconciliation service, as an answer: its status, its code, what it says. */
const refused = (status: any, e: unknown) => {
  if (e instanceof ReconciliationError) return status(e.status, { code: e.code, message: e.message, ...e.extra })
  throw e
}
const lineBody = t.Object({
  date: t.String({ minLength: 8 }),
  description: t.String({ minLength: 1, maxLength: 500 }),
  amount: t.Number(),
  bankReference: t.Optional(t.String({ maxLength: 200 })),
})

// A PUT never carries `orgId`: a document does not move between orgs (FR-20.7). `updateInOrg`
// drops it too; this answers 422 instead of ignoring it. What else a body may not choose (the
// fields the server sets) is refused in the handlers: `services/biz/server-owned.ts`.
const updateBody = t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })

/** Who completed a reconciliation and when: the server says, as the status changes; never the body. */
const completion = (status: unknown, was: unknown, userId: string) =>
  status === undefined || status === was ? {} : status === 'completed' ? { reconciledBy: userId, reconciledAt: new Date() } : { reconciledBy: null, reconciledAt: null }

export const reconciliationController = new Elysia({ prefix: '/org/:orgId/accounting/reconciliation' })
  .use(AppAuthService)
  // ── #675: the bank's statement against the ledger (`services/biz/bank-reconciliation`) ──
  // Declared before `/:id`, so a word here is never read as an id.
  .get('/transactions', async ({ params, query, status }) => {
    try {
      return await reconciliationView(params.orgId, String(query.bankAccountId ?? ''), query.date)
    } catch (e) { return refused(status, e) }
  }, { isSignIn: true })
  .post('/lines', async ({ params, body, user, status }) => {
    try {
      const r = await addStatementLines(params.orgId, body.bankAccountId, [{ ...body.line, date: new Date(body.line.date) }], { statementDate: body.statementDate, source: 'manual' })
      createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'reconciliation', entityId: r.reconciliationId, changes: [{ field: 'items', oldValue: null, newValue: `+1 line by hand: ${body.line.amount}` }] })
      return r
    } catch (e) { return refused(status, e) }
  }, { isSignIn: true, body: t.Object({ bankAccountId: t.String(), statementDate: t.Optional(t.String()), line: lineBody }) })
  .post('/import', async ({ params, body, user, status }) => {
    try {
      const parsed = parseStatementCsv(body.content)
      if (!parsed.lines.length) {
        return status(422, { code: 'statement_unreadable', message: 'No statement line could be read from the file', unrecognized: parsed.unrecognized.slice(0, 10) })
      }
      const r = await addStatementLines(params.orgId, body.bankAccountId, parsed.lines, { statementDate: body.statementDate, source: 'import' })
      createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'import', module: 'accounting', entityType: 'reconciliation', entityId: r.reconciliationId, changes: [{ field: 'items', oldValue: null, newValue: `+${r.added} imported, ${r.skipped} already there` }] })
      return { ...r, unrecognized: parsed.unrecognized.length, unrecognizedRows: parsed.unrecognized.slice(0, 10), columns: parsed.columns }
    } catch (e) { return refused(status, e) }
  }, { isSignIn: true, body: t.Object({ bankAccountId: t.String(), statementDate: t.Optional(t.String()), content: t.String({ minLength: 1, maxLength: 5_000_000 }) }) })
  .delete('/lines/:lineId', async ({ params, query, user, status }) => {
    try {
      await removeStatementLine(params.orgId, String(query.bankAccountId ?? ''), params.lineId)
      createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'reconciliation', entityId: String(query.bankAccountId ?? ''), changes: [{ field: 'items', oldValue: params.lineId, newValue: null }] })
      return { removed: true }
    } catch (e) { return refused(status, e) }
  }, { isSignIn: true })
  .post('/match', async ({ params, body, user, status }) => {
    try {
      await matchLines(params.orgId, body.bankAccountId, body.bankIds, body.ledgerIds)
      createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'reconciliation', entityId: body.bankAccountId, changes: [{ field: 'matches', oldValue: null, newValue: { bank: body.bankIds, ledger: body.ledgerIds } }] })
      return { matched: true }
    } catch (e) { return refused(status, e) }
  }, { isSignIn: true, body: t.Object({ bankAccountId: t.String(), bankIds: t.Array(t.String()), ledgerIds: t.Array(t.String()) }) })
  .post('/unmatch', async ({ params, body, user, status }) => {
    try {
      await unmatchLines(params.orgId, body.bankAccountId, body.bankIds)
      createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'reconciliation', entityId: body.bankAccountId, changes: [{ field: 'matches', oldValue: body.bankIds, newValue: null }] })
      return { unmatched: true }
    } catch (e) { return refused(status, e) }
  }, { isSignIn: true, body: t.Object({ bankAccountId: t.String(), bankIds: t.Array(t.String()) }) })
  .post('/complete', async ({ params, body, user, status }) => {
    try {
      const r = await completeReconciliation(params.orgId, body.bankAccountId, body.statementDate, body.statementBalance, user.id)
      createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'reconciliation', entityId: r.reconciliationId, changes: [{ field: 'status', oldValue: 'draft', newValue: 'completed' }] })
      return { completed: true, ...r }
    } catch (e) { return refused(status, e) }
  }, { isSignIn: true, body: t.Object({ bankAccountId: t.String(), statementDate: t.String(), statementBalance: t.Number() }) })
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.bankReconciliations.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { reconciliations: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.bankReconciliations.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { bankReconciliation: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const data = clientCreate('BankReconciliation', body, { orgId: params.orgId })
    const item = await r.bankReconciliations.create({ ...data, ...completion(data.status, 'draft', user.id), orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'reconciliation', entityId: item.id })

    return { bankReconciliation: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.bankReconciliations.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    const data = clientUpdate('BankReconciliation', body, existing)
    const item = await r.bankReconciliations.updateInOrg(params.id, params.orgId, { ...data, ...completion(data.status, (existing as any).status, user.id) } as any, {}, { validate: true })
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'reconciliation', entityId: params.id, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { bankReconciliation: item }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    const r = getRepos()
    if (!(await r.bankReconciliations.deleteInOrg(params.id, params.orgId))) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'reconciliation', entityId: params.id })

    return { success: true }
  }, { isSignIn: true })
