import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestAccount, createTestFiscalPeriod, createTestFiscalYear, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { AccountingAnalytic, BOOKS_IMPORT, JournalEntry, VatRegisterEntry } from 'db/models'
import { journalListFilter } from 'services/biz/journal-header.service'

/**
 * FR-25a §3.6, §3.8 over HTTP: the journal entry's document header, read and (for an entry made in LGR) written, the
 * journal grid's filters, the entries a header's links name, and the entry behind a VAT register row.
 *
 * Every number, partner and amount is made up.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let app: Elysia

async function tokenFor(orgId: unknown, userId: unknown) {
  return (signer as any).decorator.jwt.sign({
    id: String(userId), orgId: String(orgId), role: 'accountant', email: 'books@header.test', username: 'books',
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

async function makeWorld() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'accountant' } as any)
  const token = await tokenFor(org._id, user._id)
  const cash = await createTestAccount(org._id, { code: '501', name: 'Cash', type: 'asset', subType: 'current_asset' } as any)
  const sales = await createTestAccount(org._id, { code: '702', name: 'Sales', type: 'revenue', subType: 'operating_revenue' } as any)
  const fy = await createTestFiscalYear(org._id, { name: 'FY 2026', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') } as any)
  const march = await createTestFiscalPeriod(org._id, fy._id, { name: 'March', number: 3, startDate: new Date('2026-03-01'), endDate: new Date('2026-03-31') } as any)
  const partnerA = await AccountingAnalytic.create({ orgId: org._id, path: 'КЛИЕНТИ:Fictional A', root: 'КЛИЕНТИ', name: 'Fictional A', nameLower: 'fictional a', kind: 'customer' } as any)
  const partnerB = await AccountingAnalytic.create({ orgId: org._id, path: 'КЛИЕНТИ:Fictional B', root: 'КЛИЕНТИ', name: 'Fictional B', nameLower: 'fictional b', kind: 'customer' } as any)

  let n = 0
  /** An entry as the books import writes one: posted, in the books, `sourceModule: 'plusminus'`. */
  const imported = (over: Record<string, unknown>) => JournalEntry.create({
    orgId: org._id,
    entryNumber: `PM-2026-${String(++n).padStart(6, '0')}`,
    date: new Date('2026-03-10'),
    fiscalPeriodId: march._id,
    description: 'Imported by the test',
    status: 'posted',
    ledger: 'books',
    sourceModule: BOOKS_IMPORT,
    importKey: `key-${n}`,
    lines: [
      { accountId: cash._id, debit: 120, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 120, baseCredit: 0 },
      { accountId: sales._id, debit: 0, credit: 120, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 120 },
    ],
    totalDebit: 120,
    totalCredit: 120,
    createdBy: user._id,
    ...over,
  } as any)

  const lines = [
    { accountId: String(cash._id), debit: 50, credit: 0 },
    { accountId: String(sales._id), debit: 0, credit: 50 },
  ]
  const journal = (rest = '') => `/api/org/${orgId}/accounting/journal${rest}`
  return { org, orgId, user, token, cash, sales, march, partnerA, partnerB, imported, lines, journal }
}

type World = Awaited<ReturnType<typeof makeWorld>>

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('an entry made in LGR states its document header', () => {
  let w: World
  beforeAll(async () => { w = await makeWorld() })

  it('saves the header on create, and reads it back', async () => {
    const { status, json } = await call('POST', w.journal(), w.token, {
      date: '2026-03-12', description: 'A sale typed by hand', lines: w.lines,
      docType: '-Ф', docNumber: '0000000501', docDate: '2026-03-12', registerDocType: '1', paymentCode: '1',
      paidAmount: 50, paidCash: 50, vatRate: 20, reportingMonth: '202604', vatExemptionReason: null,
      links: [{ docType: '+ББ', docNumber: '9', date: '2026-03-14', amount: 50 }],
    })
    expect(status).toBe(200)
    const id = json.journalEntry.id
    const stored: any = await JournalEntry.findById(id).lean()
    expect(stored.registerDocType).toBe('01')
    expect(stored.paymentCode).toBe('1')
    expect(stored.paidCash).toBe(50)
    expect(stored.docDate).toEqual(new Date('2026-03-12'))
    expect(stored.links).toEqual([{ docType: '+ББ', docNumber: '9', date: new Date('2026-03-14'), amount: 50 }])
    // A cleared field on create is no field.
    expect('vatExemptionReason' in stored).toBe(false)

    const got = await call('GET', w.journal(`/${id}`), w.token)
    expect(got.status).toBe(200)
    expect(got.json.journalEntry.reportingMonth).toBe('202604')
    expect(got.json.journalEntry.links[0].docNumber).toBe('9')
  })

  it('refuses a header §3.6 does not allow, with a code and the fields', async () => {
    const cashOverPaid = await call('POST', w.journal(), w.token, {
      date: '2026-03-12', description: 'Over-paid', lines: w.lines, paidAmount: 10, paidCash: 20,
    })
    expect(cashOverPaid.status).toBe(422)
    expect(cashOverPaid.json.code).toBe('journal_header_invalid')
    expect(cashOverPaid.json.problems).toEqual([{ field: 'paidCash', code: 'paid_cash_exceeds_paid' }])

    const notice = await call('POST', w.journal(), w.token, { date: '2026-03-12', description: 'A notice', lines: w.lines, registerDocType: '03' })
    expect(notice.status).toBe(422)
    expect(notice.json.problems).toEqual([{ field: 'reasonRef', code: 'reason_ref_required' }])

    const zeroRated = { date: '2026-03-12', description: 'At 0 %', lines: w.lines, docType: '-Ф', registerDocType: '01', vatRate: 0 }
    expect((await call('POST', w.journal(), w.token, zeroRated)).json.problems).toEqual([{ field: 'vatExemptionReason', code: 'exemption_reason_required' }])
    expect((await call('POST', w.journal(), w.token, { ...zeroRated, vatExemptionReason: 'A legal ground' })).status).toBe(200)

    expect((await call('POST', w.journal(), w.token, { date: '2026-03-12', description: 'Bad', lines: w.lines, paymentCode: '7' })).status).toBe(422)
    // Nothing of the refused ones was written.
    expect(await JournalEntry.countDocuments({ orgId: w.org._id, description: { $in: ['Over-paid', 'A notice', 'Bad'] } })).toBe(0)
  })

  it('edits a draft\'s header, and a cleared field leaves the entry', async () => {
    const created = await call('POST', w.journal(), w.token, {
      date: '2026-03-12', description: 'To edit', lines: w.lines, paymentCode: '2', paidAmount: 30, reasonRef: 'Something',
    })
    const id = created.json.journalEntry.id

    const edited = await call('PUT', w.journal(`/${id}`), w.token, { paidAmount: 40, paidCash: 10, reasonRef: null, customsRef: '' })
    expect(edited.status).toBe(200)
    expect(edited.json.journalEntry.paidAmount).toBe(40)
    const stored: any = await JournalEntry.findById(id).lean()
    expect(stored.paidCash).toBe(10)
    expect(stored.paymentCode).toBe('2')
    expect('reasonRef' in stored).toBe(false)
    expect('customsRef' in stored).toBe(false)

    // The rule is checked on what the edit leaves: removing the paid amount strands the cash part.
    const stranded = await call('PUT', w.journal(`/${id}`), w.token, { paidAmount: null })
    expect(stranded.status).toBe(422)
    expect(stranded.json.problems).toEqual([{ field: 'paidCash', code: 'paid_cash_exceeds_paid' }])
    expect(((await JournalEntry.findById(id).lean()) as any).paidAmount).toBe(40)
  })

  it('keeps the old body working: an edit without a header changes no header field', async () => {
    const created = await call('POST', w.journal(), w.token, { date: '2026-03-12', description: 'Old client', lines: w.lines, paymentCode: '1' })
    const id = created.json.journalEntry.id
    const edited = await call('PUT', w.journal(`/${id}`), w.token, { description: 'Old client, edited', lines: w.lines })
    expect(edited.status).toBe(200)
    expect(((await JournalEntry.findById(id).lean()) as any).paymentCode).toBe('1')
  })

  it('still edits only a draft', async () => {
    const created = await call('POST', w.journal(), w.token, { date: '2026-03-12', description: 'Posted', lines: w.lines })
    const id = created.json.journalEntry.id
    expect((await call('POST', w.journal(`/${id}/post`), w.token)).status).toBe(200)
    expect((await call('PUT', w.journal(`/${id}`), w.token, { paymentCode: '1' })).status).toBe(400)
    // A posted entry of LGR's own is voided as before.
    expect((await call('POST', w.journal(`/${id}/void`), w.token)).status).toBe(200)
  })
})

describe('an imported entry is as booked, for everyone', () => {
  let w: World
  beforeAll(async () => { w = await makeWorld() })

  it('refuses any edit with a stable code, and writes nothing', async () => {
    const entry = await w.imported({ docType: '-Ф', docNumber: '0000000700', paymentCode: '2', paidAmount: 0 })
    for (const body of [{ paidAmount: 120 }, { description: 'Changed' }, { reasonRef: null }]) {
      const res = await call('PUT', w.journal(`/${entry._id}`), w.token, body)
      expect(res.status).toBe(422)
      expect(res.json.code).toBe('journal_entry_as_booked')
    }
    const stored: any = await JournalEntry.findById(entry._id).lean()
    expect(stored.paidAmount).toBe(0)
    expect(stored.description).toBe('Imported by the test')
  })

  it('refuses it even as a draft, before anything else is said of it', async () => {
    const entry = await w.imported({ status: 'draft' })
    const res = await call('PUT', w.journal(`/${entry._id}`), w.token, { paidCash: 5 })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('journal_entry_as_booked')
  })

  it('refuses a void', async () => {
    const entry = await w.imported({})
    const res = await call('POST', w.journal(`/${entry._id}/void`), w.token)
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('journal_entry_as_booked')
    expect(((await JournalEntry.findById(entry._id).lean()) as any).status).toBe('posted')
  })

  it('reads its links to the entries they name, by type, number and partner', async () => {
    const invoice = await w.imported({ docType: '-Ф', docNumber: '0000000800', partnerAnalyticId: w.partnerA._id, date: new Date('2026-03-02') })
    // The same number of another partner's: a number is unique only per partner.
    await w.imported({ docType: '-Ф', docNumber: '0000000800', partnerAnalyticId: w.partnerB._id, date: new Date('2026-03-02') })
    const bank = await w.imported({
      docType: '+ББ', docNumber: '31', partnerAnalyticId: w.partnerA._id,
      links: [
        { docType: '-Ф', docNumber: '0000000800', date: new Date('2026-03-02'), amount: 120 },
        { docType: '-Ф', docNumber: '0000000999', amount: 5 },
      ],
    })
    const res = await call('GET', w.journal(`/${bank._id}`), w.token)
    expect(res.status).toBe(200)
    expect(res.json.journalEntry.links[0].entryId).toBe(String(invoice._id))
    // One this org does not hold has none.
    expect(res.json.journalEntry.links[1].entryId).toBeUndefined()
    expect(res.json.journalEntry.partnerName).toBe('Fictional A')
  })
})

describe('the journal grid\'s list', () => {
  let w: World
  let ids: Record<string, string>

  beforeAll(async () => {
    w = await makeWorld()
    const make = async (over: Record<string, unknown>) => String((await w.imported(over))._id)
    ids = {
      cashPaid: await make({ docType: '-Ф', docNumber: '1', paymentCode: '1', docTotal: 120, paidAmount: 120, paidCash: 120, registerDocType: '1' }),
      bankPart: await make({ docType: '-Ф', docNumber: '2', paymentCode: '2', docTotal: 120, paidAmount: 20, registerDocType: '1' }),
      bankNone: await make({ docType: '+Ф', docNumber: '3', paymentCode: '2', docTotal: 80, registerDocType: '1', reportingMonth: '202605' }),
      credit: await make({ docType: '-Ф', docNumber: '4', paymentCode: '2', docTotal: -30, paidAmount: 0, registerDocType: '3', reasonRef: 'Invoice 1' }),
      debit: await make({ docType: '-Ф', docNumber: '5', registerDocType: '02', reasonRef: 'Invoice 2' }),
      ownMonth: await make({ docType: 'ЗАП', docNumber: '6', reportingMonth: '202603' }),
      bankDoc: await make({ docType: '+ББ', docNumber: '7', docTotal: 500, paidAmount: 0 }),
    }
  })

  const list = (query: string) => call('GET', `${w.journal()}?size=50&sortBy=date&sortOrder=desc${query}`, w.token)
  const listed = async (query: string) => {
    const res = await list(query)
    expect(res.status).toBe(200)
    expect(res.json.total).toBe(res.json.journalEntries.length)
    return res.json.journalEntries.map((e: any) => e._id).sort()
  }
  const of = (...names: string[]) => names.map(name => ids[name]).sort()

  it('answers without the lines, with what the grid shows', async () => {
    const res = await list('')
    expect(res.json.total).toBe(7)
    const row = res.json.journalEntries.find((e: any) => e._id === ids.bankPart)
    expect(row.lines).toBeUndefined()
    expect(row.id).toBe(ids.bankPart)
    expect(row).toMatchObject({ paymentCode: '2', docTotal: 120, paidAmount: 20, registerDocType: '1', sourceModule: BOOKS_IMPORT, totalDebit: 120 })
  })

  it('filters by how a document is paid', async () => {
    expect(await listed('&payment=cash')).toEqual(of('cashPaid'))
    expect(await listed('&payment=bank')).toEqual(of('bankPart', 'bankNone', 'credit'))
    // An unknown way filters nothing, as an unknown status did before.
    expect((await listed('&payment=cheque')).length).toBe(7)
  })

  it('lists what is unpaid: paid some way, and short of the total', async () => {
    expect(await listed('&unpaid=true')).toEqual(of('bankPart', 'bankNone', 'credit'))
    expect(await listed('&unpaid=true&payment=bank')).toEqual(of('bankPart', 'bankNone', 'credit'))
    expect(await listed('&unpaid=true&payment=cash')).toEqual([])
  })

  it('lists the notices only', async () => {
    expect(await listed('&notices=true')).toEqual(of('credit', 'debit'))
  })

  it('lists what is declared in another month than its own', async () => {
    expect(await listed('&otherMonth=true')).toEqual(of('bankNone'))
  })

  it('combines the filters with the search, which now finds a document number', async () => {
    expect(await listed('&search=3')).toContain(ids.bankNone)
    expect(await listed('&notices=true&search=Imported')).toEqual(of('credit', 'debit'))
    expect(await listed('&unpaid=true&otherMonth=true')).toEqual(of('bankNone'))
  })

  it('answers a page and its count', async () => {
    const res = await call('GET', `${w.journal()}?size=2&page=1&sortBy=entryNumber&sortOrder=asc`, w.token)
    expect(res.json.total).toBe(7)
    expect(res.json.journalEntries.map((e: any) => e.entryNumber)).toEqual(['PM-2026-000003', 'PM-2026-000004'])
  })
})

/** The stages of a winning plan, and the indexes it reads. */
function stagesOf(plan: any, out: { stages: string[]; indexes: string[] } = { stages: [], indexes: [] }) {
  if (!plan) return out
  out.stages.push(plan.stage)
  // An `$in` reads one range per value of the same index, merged in date order (SORT_MERGE): one index all the same.
  if (plan.indexName && !out.indexes.includes(plan.indexName)) out.indexes.push(plan.indexName)
  for (const child of [plan.inputStage, ...(plan.inputStages ?? [])]) stagesOf(child, out)
  return out
}
const winningOf = (explained: any) => {
  const planner = explained.queryPlanner ?? explained.stages?.[0]?.$cursor?.queryPlanner ?? explained[0]?.queryPlanner
  return stagesOf(planner.winningPlan.queryPlan ?? planner.winningPlan)
}

/**
 * The planner chooses by what it finds, so the plans are read on an org shaped like a books org: many entries without
 * the header, a few with each field. On a handful of entries every plan ties and the answer proves nothing.
 */
describe('the grid\'s filters read their own index, never the whole org', () => {
  let w: World

  beforeAll(async () => {
    w = await makeWorld()
    const filler = Array.from({ length: 1500 }, (_, i) => ({
      orgId: w.org._id, entryNumber: `PM-2025-${String(i).padStart(6, '0')}`, date: new Date(Date.UTC(2025, i % 12, 1 + (i % 28))),
      fiscalPeriodId: w.march._id, description: 'Filler', status: 'posted', ledger: 'books', sourceModule: BOOKS_IMPORT,
      docType: i % 2 ? 'СТ' : '+ББ', docNumber: `F${i}`, lines: [], totalDebit: 0, totalCredit: 0, createdBy: w.user._id,
    }))
    await JournalEntry.insertMany(filler)
    await w.imported({ docType: '-Ф', docNumber: '1', paymentCode: '1', docTotal: 10, paidAmount: 10 })
    await w.imported({ docType: '-Ф', docNumber: '2', paymentCode: '2', docTotal: 10, registerDocType: '3', reasonRef: 'x' })
    await w.imported({ docType: '+Ф', docNumber: '3', registerDocType: '1', reportingMonth: '202605' })
    await JournalEntry.syncIndexes()
  })

  it('for the page, sorted by date', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ payment: 'cash' }, 'orgId_1_paymentCode_1_date_-1'],
      [{ unpaid: 'true' }, 'orgId_1_paymentCode_1_date_-1'],
      [{ notices: 'true' }, 'orgId_1_registerDocType_1_date_-1'],
      [{ otherMonth: 'true' }, 'orgId_1_reportingMonth_1_date_-1'],
      [{}, 'orgId_1_date_-1'],
    ]
    for (const [query, index] of cases) {
      const plan = winningOf(await JournalEntry.find(journalListFilter(w.orgId, query)).sort({ date: -1 }).limit(10).explain('queryPlanner'))
      expect({ query, collscan: plan.stages.includes('COLLSCAN'), index: plan.indexes }).toEqual({ query, collscan: false, index: [index] })
    }
  })

  it('for its count, which has no sort to lean on', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ payment: 'bank' }, 'orgId_1_paymentCode_1_date_-1'],
      [{ unpaid: 'true' }, 'orgId_1_paymentCode_1_date_-1'],
      [{ notices: 'true' }, 'orgId_1_registerDocType_1_date_-1'],
      [{ otherMonth: 'true' }, 'orgId_1_reportingMonth_1_date_-1'],
    ]
    for (const [query, index] of cases) {
      // `countDocuments` is this aggregation.
      // An aggregation is not cast against the schema: the org as an ObjectId, as `countDocuments` casts it.
      const filter = { ...journalListFilter(w.orgId, query), orgId: w.org._id }
      const plan = winningOf(await JournalEntry.aggregate([{ $match: filter }, { $group: { _id: 1, n: { $sum: 1 } } }]).explain('queryPlanner'))
      expect({ query, collscan: plan.stages.includes('COLLSCAN'), index: plan.indexes }).toEqual({ query, collscan: false, index: [index] })
    }
  })

  it('finds a VAT register page\'s entries by their numbers', async () => {
    const plan = winningOf(await JournalEntry.find({ orgId: w.org._id, docNumber: { $in: ['F7', '0000000007', '3'] } }).explain('queryPlanner'))
    expect(plan.stages).not.toContain('COLLSCAN')
    expect(plan.indexes).toEqual(['orgId_1_docType_1_docNumber_1'])
  })
})

describe('a VAT register row links its journal entry', () => {
  let w: World
  beforeAll(async () => { w = await makeWorld() })

  const row = (over: Record<string, unknown>) => VatRegisterEntry.create({
    orgId: w.org._id, period: '202604', side: 'purchase', ledger: 'books', rowNo: 1, docTypeCode: '01', docNumber: '0000000123',
    docDate: new Date('2026-04-03'), cells: {}, frozen: true, ...over,
  } as any)

  it('by its two-digit type and its number, and narrows to what is declared in another month', async () => {
    const entry = await w.imported({ docType: '+Ф', docNumber: '123', registerDocType: '1', date: new Date('2026-04-03') })
    await w.imported({ docType: '+Ф', docNumber: '124', registerDocType: '3', reasonRef: 'Invoice 123', date: new Date('2026-04-05') })
    await row({ rowNo: 1 })
    await row({ rowNo: 2, docTypeCode: '01', docNumber: '0000000124', docDate: new Date('2026-04-05') }) // a notice's number, an invoice's type
    await row({ rowNo: 3, docNumber: '0000000999', docDate: new Date('2026-02-20') }) // in another org's journal, or none

    const res = await call('GET', `/api/org/${w.orgId}/accounting/vat/202604/rows?side=purchase&size=25`, w.token)
    expect(res.status).toBe(200)
    const byNo = Object.fromEntries(res.json.rows.map((r: any) => [r.rowNo, r]))
    expect(byNo[1].journalEntryId).toBe(String(entry._id))
    expect(byNo[1].journalEntryNumber).toBe(entry.entryNumber)
    expect(byNo[2].journalEntryId).toBeUndefined()
    expect(byNo[3].journalEntryId).toBeUndefined()
    // The rows stay as filed: nothing is written on them.
    expect(((await VatRegisterEntry.findOne({ orgId: w.org._id, rowNo: 1 }).lean()) as any).journalEntryId).toBeUndefined()

    const other = await call('GET', `/api/org/${w.orgId}/accounting/vat/202604/rows?side=purchase&otherMonth=true`, w.token)
    expect(other.json.total).toBe(1)
    expect(other.json.rows.map((r: any) => r.rowNo)).toEqual([3])
  })
})
