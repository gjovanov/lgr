import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestAccount, createTestFiscalPeriod, createTestFiscalYear, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Account, JournalEntry } from 'db/models'
import { getProfitLoss, getTrialBalance } from 'services/biz/accounting.service'
import { getRepos } from 'services/context'

/**
 * The financial statements over HTTP, on data shaped like the books FR-25 imports (FR-25 R0).
 *
 * The accounts are fictional; the SHAPES are the point: cost of sales as a debit on the revenue
 * account, a customers account with partners on both sides, entries dated later on a month's last
 * day, and a cached `Account.balance` that says something else.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let app: Elysia

async function tokenFor(orgId: unknown, userId: unknown) {
  return (signer as any).decorator.jwt.sign({
    id: String(userId), orgId: String(orgId), role: 'accountant', email: 'books@statements.test', username: 'books',
    firstName: 'B', lastName: 'K', permissions: DEFAULT_ROLE_PERMISSIONS.accountant, ownRecordsModules: [],
  })
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

/** One org with its chart, two fiscal years and a helper that books a balanced entry. */
async function makeWorld() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'accountant' } as any)
  const token = await tokenFor(org._id, user._id)

  const account = (code: string, name: string, type: string, subType: string, extra: Record<string, unknown> = {}) =>
    createTestAccount(org._id, { code, name, type, subType, ...extra } as any)
  const cash = await account('501', 'Cash', 'asset', 'current_asset')
  const goods = await account('304', 'Goods', 'asset', 'current_asset')
  const customers = await account('411', 'Customers', 'asset', 'current_asset')
  const suppliers = await account('401', 'Suppliers', 'liability', 'current_liability')
  const capital = await account('101', 'Capital', 'equity', 'owner_equity')
  const sales = await account('702', 'Sales of goods', 'revenue', 'operating_revenue')
  const materials = await account('601', 'Materials', 'expense', 'operating_expense')

  const fy2025 = await createTestFiscalYear(org._id, { name: 'FY 2025', startDate: new Date('2025-01-01'), endDate: new Date('2025-12-31') } as any)
  const fy2026 = await createTestFiscalYear(org._id, { name: 'FY 2026', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') } as any)
  const jan2025 = await createTestFiscalPeriod(org._id, fy2025._id, { name: 'January', number: 1, startDate: new Date('2025-01-01'), endDate: new Date('2025-01-31') } as any)
  const feb2025 = await createTestFiscalPeriod(org._id, fy2025._id, { name: 'February', number: 2, startDate: new Date('2025-02-01'), endDate: new Date('2025-02-28') } as any)
  const jan2026 = await createTestFiscalPeriod(org._id, fy2026._id, { name: 'January', number: 1, startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31') } as any)

  let n = 0
  /** `lines`: [account, debit, credit, contactId?] */
  const book = (date: string, period: any, lines: [any, number, number, unknown?][], status = 'posted') => JournalEntry.create({
    orgId: org._id,
    entryNumber: `JE-${String(++n).padStart(5, '0')}`,
    date: new Date(date),
    fiscalPeriodId: period._id,
    description: 'Booked by the test',
    status,
    lines: lines.map(([a, debit, credit, contactId]) => ({
      accountId: a._id, debit, credit, currency: 'EUR', exchangeRate: 1, baseDebit: debit, baseCredit: credit, ...(contactId ? { contactId } : {}),
    })),
    totalDebit: lines.reduce((s, l) => s + l[1], 0),
    totalCredit: lines.reduce((s, l) => s + l[2], 0),
    createdBy: user._id,
  } as any)

  const report = (name: string, query = '') => call('GET', `/api/org/${orgId}/accounting/report/${name}${query}`, token)
  return { org, orgId, user, token, cash, goods, customers, suppliers, capital, sales, materials, fy2025, fy2026, jan2025, feb2025, jan2026, book, report }
}

type World = Awaited<ReturnType<typeof makeWorld>>

const rowOf = (rows: any[], code: string) => rows.find(r => r.code === code || String(r.account).startsWith(`${code} - `))

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('the trial balance is read for a year, a period and a date', () => {
  let w: World

  beforeAll(async () => {
    w = await makeWorld()
    await w.book('2025-01-15T10:00:00Z', w.jan2025, [[w.cash, 100, 0], [w.capital, 0, 100]])
    await w.book('2025-02-15T10:00:00Z', w.feb2025, [[w.cash, 20, 0], [w.capital, 0, 20]])
    await w.book('2026-01-15T10:00:00Z', w.jan2026, [[w.cash, 3, 0], [w.capital, 0, 3]])
  })

  it('selecting a year counts that year, where it used to return nothing', async () => {
    const { status, json } = await w.report('trial-balance', `?fiscalYearId=${w.fy2025._id}`)
    expect(status).toBe(200)
    expect(rowOf(json.rows, '501').debit).toBe(120)
    expect(rowOf(json.rows, '101').credit).toBe(120)

    expect(rowOf((await w.report('trial-balance', `?fiscalYearId=${w.fy2026._id}`)).json.rows, '501').debit).toBe(3)
  })

  it('selecting a period counts that period', async () => {
    const { json } = await w.report('trial-balance', `?fiscalPeriodId=${w.feb2025._id}`)
    expect(rowOf(json.rows, '501').debit).toBe(20)
  })

  it('a period inside the named year is that period; one outside it is nothing', async () => {
    const inside = await w.report('trial-balance', `?fiscalYearId=${w.fy2025._id}&fiscalPeriodId=${w.jan2025._id}`)
    expect(rowOf(inside.json.rows, '501').debit).toBe(100)

    const outside = await w.report('trial-balance', `?fiscalYearId=${w.fy2025._id}&fiscalPeriodId=${w.jan2026._id}`)
    expect(outside.json.rows).toEqual([])
  })

  it('nothing selected is everything', async () => {
    expect(rowOf((await w.report('trial-balance')).json.rows, '501').debit).toBe(123)
  })

  it('a date cuts it off, and the day named counts whole', async () => {
    expect(rowOf((await w.report('trial-balance', '?asOf=2025-01-14')).json.rows, '501')).toBeUndefined()
    expect(rowOf((await w.report('trial-balance', '?asOf=2025-01-15')).json.rows, '501').debit).toBe(100)
    expect(rowOf((await w.report('trial-balance', `?asOf=2025-02-15&fiscalYearId=${w.fy2025._id}`)).json.rows, '501').debit).toBe(120)
  })

  it('another org\'s year and period name nothing here', async () => {
    const other = await makeWorld()
    await other.book('2025-03-01T10:00:00Z', other.jan2025, [[other.cash, 7, 0], [other.capital, 0, 7]])

    expect((await w.report('trial-balance', `?fiscalYearId=${other.fy2025._id}`)).json.rows).toEqual([])
    expect((await w.report('trial-balance', `?fiscalPeriodId=${other.jan2025._id}`)).json.rows).toEqual([])
  })

  it('an id or a date that is none is refused, never a 500', async () => {
    expect((await w.report('trial-balance', '?fiscalYearId=FY%202025')).status).toBe(422)
    expect((await w.report('trial-balance', '?fiscalPeriodId=january')).status).toBe(422)
    expect((await w.report('trial-balance', '?asOf=not-a-date')).status).toBe(422)
  })

  it('a parameter it does not know is ignored', async () => {
    const { status, json } = await w.report('trial-balance', '?page=1')
    expect(status).toBe(200)
    expect(rowOf(json.rows, '501').debit).toBe(123)
  })
})

describe('profit and loss shows both sides of an account', () => {
  let w: World

  beforeAll(async () => {
    w = await makeWorld()
    // Cost of sales on the revenue account (`D702 K304`), as the imported books keep it.
    await w.book('2025-01-10T10:00:00Z', w.jan2025, [[w.customers, 1000, 0], [w.sales, 0, 1000]])
    await w.book('2025-01-10T10:00:00Z', w.jan2025, [[w.sales, 700, 0], [w.goods, 0, 700]])
    await w.book('2025-01-20T10:00:00Z', w.jan2025, [[w.materials, 50, 0], [w.cash, 0, 50]])
    await w.book('2025-01-25T10:00:00Z', w.jan2025, [[w.cash, 5, 0], [w.materials, 0, 5]])
  })

  it('each row carries its debit and credit, and `amount` is still the net', async () => {
    const { status, json } = await w.report('profit-loss', '?startDate=2025-01-01&endDate=2025-01-31')
    expect(status).toBe(200)

    expect(rowOf(json.revenue, '702')).toEqual({ account: '702 - Sales of goods', amount: 300, debit: 700, credit: 1000 })
    expect(rowOf(json.expenses, '601')).toEqual({ account: '601 - Materials', amount: 45, debit: 50, credit: 5 })
  })

  it('every total is what it was: nothing is reclassified', async () => {
    const { json } = await w.report('profit-loss', '?startDate=2025-01-01&endDate=2025-01-31')
    expect(json.totalRevenue).toBe(300)
    expect(json.totalExpenses).toBe(45)
    expect(json.netIncome).toBe(255)
  })

  it('an entry booked later on the period\'s last day belongs to the period', async () => {
    const x = await makeWorld()
    await x.book('2025-01-31T15:30:00Z', x.jan2025, [[x.cash, 80, 0], [x.sales, 0, 80]])

    expect((await x.report('profit-loss', '?startDate=2025-01-01&endDate=2025-01-31')).json.totalRevenue).toBe(80)
    expect((await x.report('profit-loss', '?startDate=2025-01-01&endDate=2025-01-30')).json.totalRevenue).toBe(0)
  })

  it('a date that is none is refused', async () => {
    expect((await w.report('profit-loss', '?startDate=soon')).status).toBe(422)
    expect((await w.report('profit-loss', '?endDate=later')).status).toBe(422)
  })
})

describe('the balance sheet is read from posted entries, as of a date', () => {
  let w: World

  beforeAll(async () => {
    w = await makeWorld()
    await w.book('2025-01-05T10:00:00Z', w.jan2025, [[w.cash, 1000, 0], [w.capital, 0, 1000]])
    await w.book('2025-02-10T10:00:00Z', w.feb2025, [[w.goods, 400, 0], [w.suppliers, 0, 400]])
  })

  it('keeps its shape', async () => {
    const { status, json } = await w.report('balance-sheet', '?asOf=2025-01-31')
    expect(status).toBe(200)
    expect(Object.keys(json).sort()).toEqual(['assets', 'equity', 'liabilities', 'totalAssets', 'totalEquity', 'totalLiabilities', 'totalLiabilitiesAndEquity'])
    expect(rowOf(json.assets, '501')).toEqual({ account: '501 - Cash', balance: 1000 })
    expect(rowOf(json.equity, '101')).toEqual({ account: '101 - Capital', balance: 1000 })
    expect(json.totalAssets).toBe(1000)
    expect(json.totalLiabilities).toBe(0)
    expect(json.totalEquity).toBe(1000)
    expect(json.totalLiabilitiesAndEquity).toBe(1000)
  })

  it('a date sees only what was booked by then, and that whole day', async () => {
    const before = await w.report('balance-sheet', '?asOf=2025-01-04')
    expect(before.json.totalAssets).toBe(0)

    const on = await w.report('balance-sheet', '?asOf=2025-01-05')
    expect(on.json.totalAssets).toBe(1000)

    const after = await w.report('balance-sheet', '?asOf=2025-12-31')
    expect(after.json.totalAssets).toBe(1400)
    expect(rowOf(after.json.liabilities, '401').balance).toBe(400)
  })

  it('no date is today: an entry dated tomorrow is not on it yet', async () => {
    const x = await makeWorld()
    await x.book(new Date(Date.now() - 86_400_000).toISOString(), x.jan2026, [[x.cash, 10, 0], [x.capital, 0, 10]])
    await x.book(new Date(Date.now() + 86_400_000).toISOString(), x.jan2026, [[x.cash, 90, 0], [x.capital, 0, 90]])

    expect((await x.report('balance-sheet')).json.totalAssets).toBe(10)
  })

  it('reads no cached balance, no draft and no voided entry', async () => {
    const x = await makeWorld()
    await x.book('2025-01-05T10:00:00Z', x.jan2025, [[x.cash, 100, 0], [x.capital, 0, 100]])
    await x.book('2025-01-06T10:00:00Z', x.jan2025, [[x.cash, 30, 0], [x.capital, 0, 30]], 'draft')
    await x.book('2025-01-07T10:00:00Z', x.jan2025, [[x.cash, 50, 0], [x.capital, 0, 50]], 'voided')
    await Account.updateOne({ _id: x.cash._id }, { $set: { balance: 99999 } })

    const { json } = await x.report('balance-sheet', '?asOf=2025-12-31')
    expect(rowOf(json.assets, '501').balance).toBe(100)
  })

  it('an account running on both sides shows each partner on its own side, and the sheet still balances', async () => {
    const x = await makeWorld()
    const owesUs = '0123456789abcdef01234561'
    const paidAhead = '0123456789abcdef01234562'
    const weOwe = '0123456789abcdef01234563'
    const weAdvanced = '0123456789abcdef01234564'
    await x.book('2025-01-05T10:00:00Z', x.jan2025, [[x.customers, 300, 0, owesUs], [x.capital, 0, 300]])
    await x.book('2025-01-06T10:00:00Z', x.jan2025, [[x.cash, 80, 0], [x.customers, 0, 80, paidAhead]])
    await x.book('2025-01-07T10:00:00Z', x.jan2025, [[x.goods, 200, 0], [x.suppliers, 0, 200, weOwe]])
    await x.book('2025-01-08T10:00:00Z', x.jan2025, [[x.suppliers, 60, 0, weAdvanced], [x.cash, 0, 60]])

    const { json } = await x.report('balance-sheet', '?asOf=2025-12-31')

    expect(rowOf(json.assets, '411').balance).toBe(300)
    expect(rowOf(json.liabilities, '411').balance).toBe(80)
    expect(rowOf(json.liabilities, '401').balance).toBe(200)
    expect(rowOf(json.assets, '401').balance).toBe(60)

    expect(json.totalAssets).toBe(300 + 60 + 200 + 20) // customers, advances, goods, cash
    expect(json.totalLiabilitiesAndEquity).toBe(json.totalAssets)
  })

  it('a line that names no partner stays on its account\'s own side, whatever its sign', async () => {
    const x = await makeWorld()
    await x.book('2025-01-05T10:00:00Z', x.jan2025, [[x.goods, 50, 0], [x.cash, 0, 50]])

    const { json } = await x.report('balance-sheet', '?asOf=2025-12-31')

    expect(rowOf(json.assets, '501').balance).toBe(-50)
    expect(rowOf(json.liabilities, '501')).toBeUndefined()
  })

  it('what revenue and expenses add up to is equity until something closes them', async () => {
    const x = await makeWorld()
    await x.book('2025-01-05T10:00:00Z', x.jan2025, [[x.cash, 1000, 0], [x.capital, 0, 1000]])
    await x.book('2025-01-10T10:00:00Z', x.jan2025, [[x.customers, 500, 0], [x.sales, 0, 500]])
    await x.book('2025-01-10T10:00:00Z', x.jan2025, [[x.sales, 300, 0], [x.goods, 0, 300]])
    await x.book('2025-01-20T10:00:00Z', x.jan2025, [[x.materials, 40, 0], [x.cash, 0, 40]])

    const { json } = await x.report('balance-sheet', '?asOf=2025-12-31')

    const result = json.equity.find((row: any) => row.unclosedResult)
    expect(result.balance).toBe(160) // (500 − 300) − 40
    expect(json.totalEquity).toBe(1160)
    expect(json.totalLiabilitiesAndEquity).toBe(json.totalAssets)
  })

  it('a closed year leaves no such row', async () => {
    const x = await makeWorld()
    await x.book('2025-01-10T10:00:00Z', x.jan2025, [[x.cash, 500, 0], [x.sales, 0, 500]])
    await x.book('2025-12-31T10:00:00Z', x.jan2025, [[x.sales, 500, 0], [x.capital, 0, 500]])

    const { json } = await x.report('balance-sheet', '?asOf=2025-12-31')

    expect(json.equity.some((row: any) => row.unclosedResult)).toBe(false)
    expect(json.totalLiabilitiesAndEquity).toBe(500)
  })

  it('an account deactivated with a balance on it stays on the sheet; an empty one does not', async () => {
    const x = await makeWorld()
    await x.book('2025-01-05T10:00:00Z', x.jan2025, [[x.goods, 70, 0], [x.capital, 0, 70]])
    await Account.updateOne({ _id: x.goods._id }, { $set: { isActive: false } })
    await Account.updateOne({ _id: x.cash._id }, { $set: { isActive: false } })

    const { json } = await x.report('balance-sheet', '?asOf=2025-12-31')

    expect(rowOf(json.assets, '304').balance).toBe(70)
    expect(rowOf(json.assets, '501')).toBeUndefined()
    expect(json.totalLiabilitiesAndEquity).toBe(json.totalAssets)
  })

  it('a date that is none is refused', async () => {
    expect((await w.report('balance-sheet', '?asOf=yesterdayish')).status).toBe(422)
  })
})

describe('statements add up in the database, not in the pod', () => {
  it('neither the trial balance nor profit and loss loads the entries', async () => {
    const w = await makeWorld()
    await w.book('2025-01-10T10:00:00Z', w.jan2025, [[w.cash, 10, 0], [w.sales, 0, 10]])

    const real = getRepos()
    const journalEntries = Object.create(real.journalEntries)
    journalEntries.findMany = () => { throw new Error('a statement loaded every entry') }
    const repos = { ...real, journalEntries }

    expect(rowOf(await getTrialBalance(w.orgId, {}, repos), '501').debit).toBe(10)
    expect((await getProfitLoss(w.orgId, new Date('2025-01-01'), new Date('2025-12-31'), repos)).totalRevenue).toBe(10)
  })
})

describe('the journal analysis', () => {
  const analysis = (w: World, query = '') => call('GET', `/api/org/${w.orgId}/accounting/reports/journal-analysis${query}`, w.token)

  it('returns the org\'s lines by account and month, where it used to return nothing', async () => {
    const w = await makeWorld()
    await w.book('2025-01-15T10:00:00Z', w.jan2025, [[w.cash, 100, 0], [w.sales, 0, 100]])
    await w.book('2025-01-20T10:00:00Z', w.jan2025, [[w.cash, 11, 0], [w.sales, 0, 11]], 'draft')
    await w.book('2025-02-15T10:00:00Z', w.feb2025, [[w.cash, 20, 0], [w.sales, 0, 20]])
    await w.book('2025-02-16T10:00:00Z', w.feb2025, [[w.cash, 7, 0], [w.sales, 0, 7]], 'voided')

    const { status, json } = await analysis(w, '?dateFrom=2025-01-01&dateTo=2025-12-31')

    expect(status).toBe(200)
    const cash = json.data.filter((row: any) => row.accountCode === '501')
    expect(cash.map((row: any) => [row.month, row.totalDebit, row.totalCredit, row.balance, row.count])).toEqual([
      ['2025-01', 111, 0, 111, 2], // a draft counts here, as the route has always asked for
      ['2025-02', 20, 0, 20, 1],
    ])
    expect(cash[0].accountName).toBe('Cash')
    expect(cash[0].accountType).toBe('asset')
  })

  it('never another org\'s', async () => {
    const mine = await makeWorld()
    const theirs = await makeWorld()
    await theirs.book('2025-01-15T10:00:00Z', theirs.jan2025, [[theirs.cash, 999, 0], [theirs.sales, 0, 999]])

    expect((await analysis(mine, '?dateFrom=2025-01-01&dateTo=2025-12-31')).json.data).toEqual([])
    expect((await analysis(theirs, '?dateFrom=2025-01-01&dateTo=2025-12-31')).json.data).toHaveLength(2)
  })

  it('counts the last day of the range whole', async () => {
    const w = await makeWorld()
    await w.book('2025-01-31T15:30:00Z', w.jan2025, [[w.cash, 5, 0], [w.sales, 0, 5]])

    expect((await analysis(w, '?dateFrom=2025-01-01&dateTo=2025-01-31')).json.data).toHaveLength(2)
  })

  it('runs one query, not a discarded full one before it', async () => {
    const w = await makeWorld()
    const spy = spyOn(JournalEntry, 'aggregate')
    try {
      await analysis(w, '?dateFrom=2025-01-01&dateTo=2025-12-31')
      expect(spy).toHaveBeenCalledTimes(1)
      // The match is the org's own, as an id: `{ $exists: true }` over every org is what it replaced.
      const [pipeline] = spy.mock.calls[0] as any
      expect(String(pipeline[0].$match.orgId)).toBe(w.orgId)
      expect(typeof pipeline[0].$match.orgId).toBe('object')
    } finally {
      spy.mockRestore()
    }
  })

  it('a date that is none is refused', async () => {
    const w = await makeWorld()
    expect((await analysis(w, '?dateFrom=soon')).status).toBe(422)
  })
})

describe('the journal routes post through the service', () => {
  const journal = (w: World, rest = '') => `/api/org/${w.orgId}/accounting/journal${rest}`

  /** What the entry form sends: amounts, and no base amounts. */
  async function createDraft(w: World) {
    const { status, json } = await call('POST', journal(w), w.token, {
      date: '2025-01-15',
      description: 'Typed by hand',
      lines: [
        { accountId: String(w.cash._id), debit: 40, credit: 0 },
        { accountId: String(w.cash._id), debit: 60, credit: 0 },
        { accountId: String(w.sales._id), debit: 0, credit: 100 },
      ],
    })
    expect(status).toBe(200)
    return json.journalEntry
  }

  it('an entry typed in the form reaches the statements', async () => {
    const w = await makeWorld()
    const entry = await createDraft(w)
    expect(entry.lines[0].baseDebit).toBe(40)
    expect(entry.lines[2].baseCredit).toBe(100)

    expect((await call('POST', journal(w, `/${entry.id}/post`), w.token)).status).toBe(200)

    const tb = await w.report('trial-balance')
    expect(rowOf(tb.json.rows, '501').debit).toBe(100)
    expect(rowOf(tb.json.rows, '702').credit).toBe(100)
  })

  it('a line in another currency reaches them at its rate', async () => {
    const w = await makeWorld()
    const { json } = await call('POST', journal(w), w.token, {
      date: '2025-01-15',
      description: 'In dollars',
      lines: [
        { accountId: String(w.cash._id), debit: 100, credit: 0, currency: 'USD', exchangeRate: 0.9 },
        { accountId: String(w.sales._id), debit: 0, credit: 100, currency: 'USD', exchangeRate: 0.9 },
      ],
    })
    expect(json.journalEntry.lines[0].baseDebit).toBe(90)
    expect(json.journalEntry.lines[1].baseCredit).toBe(90)
  })

  it('base amounts the caller sends are kept', async () => {
    const w = await makeWorld()
    const { json } = await call('POST', journal(w), w.token, {
      date: '2025-01-15',
      description: 'Rounded by the caller',
      lines: [
        { accountId: String(w.cash._id), debit: 100, credit: 0, exchangeRate: 0.9, baseDebit: 90.01 },
        { accountId: String(w.sales._id), debit: 0, credit: 100, exchangeRate: 0.9, baseCredit: 90.01 },
      ],
    })
    expect(json.journalEntry.lines[0].baseDebit).toBe(90.01)
  })

  it('editing a draft in the form keeps its lines and its totals true', async () => {
    const w = await makeWorld()
    const entry = await createDraft(w)

    const { status, json } = await call('PUT', journal(w, `/${entry.id}`), w.token, {
      description: 'Typed by hand, corrected',
      lines: [
        { accountId: String(w.cash._id), debit: 25, credit: 0 },
        { accountId: String(w.sales._id), debit: 0, credit: 25 },
      ],
    })

    expect(status).toBe(200)
    expect(json.journalEntry.lines[0].baseDebit).toBe(25)
    expect(json.journalEntry.totalDebit).toBe(25)
    expect(json.journalEntry.totalCredit).toBe(25)
  })

  it('an edit that unbalances a draft is refused', async () => {
    const w = await makeWorld()
    const entry = await createDraft(w)

    const { status } = await call('PUT', journal(w, `/${entry.id}`), w.token, {
      lines: [
        { accountId: String(w.cash._id), debit: 25, credit: 0 },
        { accountId: String(w.sales._id), debit: 0, credit: 24 },
      ],
    })

    expect(status).toBe(400)
  })

  it('posting moves each balance on its own side, and voiding moves it back', async () => {
    const w = await makeWorld()
    const entry = await createDraft(w)

    await call('POST', journal(w, `/${entry.id}/post`), w.token)
    expect((await Account.findById(w.cash._id))!.balance).toBe(100)
    expect((await Account.findById(w.sales._id))!.balance).toBe(100) // a revenue account grows with a credit

    await call('POST', journal(w, `/${entry.id}/void`), w.token)
    expect((await Account.findById(w.cash._id))!.balance).toBe(0)
    expect((await Account.findById(w.sales._id))!.balance).toBe(0)
  })

  it('a refusal is an answer, not a 500', async () => {
    const w = await makeWorld()
    const entry = await createDraft(w)
    await call('POST', journal(w, `/${entry.id}/post`), w.token)

    const twice = await call('POST', journal(w, `/${entry.id}/post`), w.token)
    expect(twice.status).toBe(400)

    const other = await makeWorld()
    const foreign = await w.book('2025-01-15T10:00:00Z', w.jan2025, [[other.cash, 5, 0], [w.sales, 0, 5]], 'draft')
    const refused = await call('POST', journal(w, `/${foreign._id}/post`), w.token)
    expect(refused.status).toBe(400)
    expect((await Account.findById(other.cash._id))!.balance).toBe(0)
  })
})
