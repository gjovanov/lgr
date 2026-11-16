import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestAccount, createTestBankAccount, createTestFiscalPeriod, createTestFiscalYear, createTestJournalEntry, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { BankReconciliation } from 'db/models'

/**
 * #675 — bank reconciliation, over the real routes: the bank's lines come from a statement file or are entered by
 * hand, the ledger's are the posted journal lines on the bank account's ledger account, they are matched where their
 * amounts agree, and the reconciliation completes only when it balances.
 *
 * NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: any
let orgId = ''
let token = ''
let bankAccountId = ''
const entries: Record<string, string> = {}

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/accounting/reconciliation${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}
const view = async (date = '2026-11-30') => (await call('GET', `/transactions?bankAccountId=${bankAccountId}&date=${date}`)).json

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
  const org = await createTestOrg({ slug: 'bank-rec' } as any)
  orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'admin', email: 'admin@bank-rec.test' } as any)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, email: 'admin@bank-rec.test', username: 'rec', firstName: 'R', lastName: 'C',
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  const gl = await createTestAccount(org._id, { code: '503', name: 'Bank account (BGN)' } as any)
  const other = await createTestAccount(org._id, { code: '411', name: 'Customers' } as any)
  const bank = await createTestBankAccount(org._id, { accountId: gl._id } as any)
  bankAccountId = String(bank._id)
  const year = await createTestFiscalYear(org._id)
  const period = await createTestFiscalPeriod(org._id, year._id as any)
  // The ledger: an opening 1000 in, a customer's 1200 in, rent 800 out; a draft entry that is no book yet.
  const je = (date: string, debit: number, credit: number, description: string, status = 'posted') =>
    createTestJournalEntry(org._id, period._id as any, user._id as any, {
      date: new Date(date), description, status,
      lines: [
        { accountId: gl._id, debit, credit, currency: 'EUR', exchangeRate: 1, baseDebit: debit, baseCredit: credit },
        { accountId: other._id, debit: credit, credit: debit, currency: 'EUR', exchangeRate: 1, baseDebit: credit, baseCredit: debit },
      ],
      totalDebit: Math.max(debit, credit), totalCredit: Math.max(debit, credit),
    } as any)
  entries.opening = String((await je('2026-10-01', 1000, 0, 'Opening'))._id)
  entries.customer = String((await je('2026-11-01', 1200, 0, 'Invoice 123 paid'))._id)
  entries.rent = String((await je('2026-11-03', 0, 800, 'Rent November'))._id)
  await je('2026-11-04', 0, 99, 'A draft, not in the books', 'draft')
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('#675: bank reconciliation', () => {
  it('lists the posted ledger lines on the account with the book balance, and no bank lines yet', async () => {
    const v = await view()
    expect(v.reconciliationId).toBeNull()
    expect(v.bookBalance).toBe(1400)
    expect(v.ledgerTransactions.map((t: any) => [t._id, t.amount])).toEqual([
      [`${entries.opening}:0`, 1000], [`${entries.customer}:0`, 1200], [`${entries.rent}:0`, -800],
    ])
    expect(v.bankTransactions).toEqual([])
  })

  it('imports a statement (Bulgarian CSV), and importing it again adds nothing', async () => {
    const content = [
      'Дата;Основание;Дебит;Кредит;Референция',
      '01.11.2026;Плащане фактура 123;;1 200,00;REF-1',
      '03.11.2026;Наем ноември;800,00;;REF-2',
      '05.11.2026;Такса обслужване;12,50;;REF-3',
    ].join('\n')
    const first = await call('POST', '/import', { bankAccountId, statementDate: '2026-11-30', content })
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ added: 3, skipped: 0, unrecognized: 0 })
    const again = await call('POST', '/import', { bankAccountId, content })
    expect(again.json).toMatchObject({ added: 0, skipped: 3 })
    expect((await call('POST', '/import', { bankAccountId, content: 'nothing;here' })).status).toBe(422)
  })

  it('a line entered by hand, where the statement has none, sits beside the imported ones', async () => {
    const r = await call('POST', '/lines', { bankAccountId, line: { date: '2026-11-06', description: 'Interest', amount: 0.5 } })
    expect(r.status).toBe(200)
    const v = await view()
    expect(v.bankTransactions.map((t: any) => [t.description, t.amount, t.source])).toEqual([
      ['Плащане фактура 123', 1200, 'import'], ['Наем ноември', -800, 'import'], ['Такса обслужване', -12.5, 'import'], ['Interest', 0.5, 'manual'],
    ])
  })

  it('matches only lines whose amounts agree; an unmatched line can be removed, a matched one not', async () => {
    const v = await view()
    const bank = (d: string) => v.bankTransactions.find((t: any) => t.description === d)._id
    const differ = await call('POST', '/match', { bankAccountId, bankIds: [bank('Плащане фактура 123')], ledgerIds: [`${entries.rent}:0`] })
    expect(differ.status).toBe(422)
    expect(differ.json).toMatchObject({ code: 'amounts_differ', bank: 1200, ledger: -800 })

    expect((await call('POST', '/match', { bankAccountId, bankIds: [bank('Плащане фактура 123')], ledgerIds: [`${entries.customer}:0`] })).status).toBe(200)
    expect((await call('POST', '/match', { bankAccountId, bankIds: [bank('Наем ноември')], ledgerIds: [`${entries.rent}:0`] })).status).toBe(200)
    const again = await call('POST', '/match', { bankAccountId, bankIds: [bank('Наем ноември')], ledgerIds: [`${entries.rent}:0`] })
    expect(again.status).toBe(409)

    expect((await call('DELETE', `/lines/${bank('Наем ноември')}?bankAccountId=${bankAccountId}`)).status).toBe(409)
    expect((await call('DELETE', `/lines/${bank('Interest')}?bankAccountId=${bankAccountId}`)).status).toBe(200)

    const after = await view()
    expect(after.bankTransactions.filter((t: any) => t.matched).length).toBe(2)
    expect(after.ledgerTransactions.filter((t: any) => t.matched).map((t: any) => t._id).sort()).toEqual([`${entries.customer}:0`, `${entries.rent}:0`].sort())
  })

  it('unmatch undoes a match', async () => {
    const v = await view()
    const rent = v.bankTransactions.find((t: any) => t.description === 'Наем ноември')._id
    expect((await call('POST', '/unmatch', { bankAccountId, bankIds: [rent] })).status).toBe(200)
    expect((await view()).bankTransactions.find((t: any) => t._id === rent).matched).toBe(false)
    expect((await call('POST', '/match', { bankAccountId, bankIds: [rent], ledgerIds: [`${entries.rent}:0`] })).status).toBe(200)
  })

  it('completes only when it balances, and a completed match is done with', async () => {
    // Statement: 1000 opening + 1200 − 800 − 12.50 fee = 1387.50. Open: the opening line (ledger only, 1000) and the
    // fee (bank only, −12.50). (1387.50 − 1000) − (1400 − 12.50) = −1000: the opening is not on this statement.
    const off = await call('POST', '/complete', { bankAccountId, statementDate: '2026-11-30', statementBalance: 1387.5 })
    expect(off.status).toBe(409)
    expect(off.json).toMatchObject({ code: 'difference_not_zero', difference: -1000 })
    // The statement's balance with the opening on it: (2387.50 − 1000) − (1400 − 12.50) = 0.
    const done = await call('POST', '/complete', { bankAccountId, statementDate: '2026-11-30', statementBalance: 2387.5 })
    expect(done.status).toBe(200)
    expect(done.json).toMatchObject({ completed: true, bookBalance: 1400 })
    const stored: any = await BankReconciliation.findById(done.json.reconciliationId).lean().exec()
    expect(stored).toMatchObject({ status: 'completed', statementBalance: 2387.5, bookBalance: 1400, difference: 0 })
    expect(stored.reconciledBy).toBeTruthy()

    // The next reconciliation starts empty on the bank side, and the matched ledger lines are no longer offered.
    const next = await view('2026-12-31')
    expect(next.reconciliationId).toBeNull()
    expect(next.ledgerTransactions.map((t: any) => t._id)).toEqual([`${entries.opening}:0`])
  })

  it('another org\'s bank account, or none, is not found', async () => {
    expect((await call('GET', '/transactions?bankAccountId=000000000000000000000001&date=2026-11-30')).status).toBe(404)
    expect((await call('GET', '/transactions?date=2026-11-30')).status).toBe(404)
    expect((await call('DELETE', '/lines/000000000000000000000001')).status).toBe(404)
  })
})
