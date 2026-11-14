import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCollections, setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { AccountingAnalytic, AuditLog, Contact, DocFile, JournalEntry, Org } from 'db/models'
import { importAnalytics, importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { analyticTrialBalance, mainBook, trialBalance } from 'services/biz/accounting-books/books-ledger'
import { getBalanceSheet } from 'services/biz/accounting.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'
import {
  RelinkError, SCRIPT, applyRelink, manifestOf, manifestText, parseManifest, planRelink, splitOrg, undoRelink,
} from '../../../../scripts/lib/relink-books-contacts'

/**
 * FR-25 R7: the repair for what the first split import made twice (`scripts/relink-books-contacts.ts`). Fictional
 * data only.
 *
 * The first import into the store orgs compared numbers as written and by type, and made a Contact of its own for
 * a company the store already held. Today's import would link it instead (`contact-match.ts`), so the state is made
 * the other way round: the import runs first and makes its contacts, and the store's older contacts are added after
 * it, dated before it. That is the state the first import left.
 */

const EIK = '000000000'
const SERIES_A = '00001'
const SERIES_B = '00002'
const YEAR = { from: '2025-01-01', to: '2025-12-31' }
const LONG_AGO = new Date('2024-01-01T00:00:00.000Z')

const CHART = [
  ['101', 'Основен капитал'], ['304', 'Стоки'], ['401', 'Доставчици'], ['411', 'Клиенти'], ['4531', 'ДДС за покупките'],
  ['4532', 'ДДС за продажбите'], ['702', 'Приходи от стоки'],
].map(([code, name]) => ({ code, name }))

const GOODS = 'СТОКИ:БОЛТОВЕ'
const HOME_CUSTOMER = 'КЛИЕНТИ:Клиент А'
/** The store holds this company as a supplier, its number spaced: the pair. */
const PAIRED = 'КЛИЕНТИ:Клиент Б'
/** An older contact holds its number; an invoice names the made one. */
const INVOICED = 'КЛИЕНТИ:Клиент Д'
/** An older contact holds its number; someone edited the made one in the app. */
const EDITED = 'КЛИЕНТИ:Клиент Е'
/** An older contact holds its number; a document import's cached analysis names the made one. */
const ANALYZED = 'КЛИЕНТИ:Клиент Ж'
/** No number; an older contact of that name holds none either. */
const NAMELESS = 'КЛИЕНТИ:Клиент Без'
/** Two contacts made for one number, which no older contact holds (put there by hand: today's import makes one). */
const TWICE_1 = 'КЛИЕНТИ:Клиент З'
const TWICE_2 = 'КЛИЕНТИ:Клиент И'
const SUPPLIER = 'ДОСТАВЧИЦИ:Доставчик А'

const AP_ROWS = [
  { ap: 'СТОКИ', params: {}, group: 'true' },
  { ap: GOODS, params: { 'МЯРКА': 'бр' } },
  { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
  { ap: HOME_CUSTOMER, params: { 'БУЛСТАТ': '000000011' } },
  { ap: PAIRED, params: { 'БУЛСТАТ': '000000022', 'ИНДДС': 'BG000000022' } },
  { ap: INVOICED, params: { 'БУЛСТАТ': '000000055' } },
  { ap: EDITED, params: { 'БУЛСТАТ': '000000066' } },
  { ap: ANALYZED, params: { 'БУЛСТАТ': '000000077' } },
  { ap: NAMELESS, params: {} },
  { ap: TWICE_1, params: { 'БУЛСТАТ': '000000088' } },
  { ap: TWICE_2, params: { 'БУЛСТАТ': '000000099' } },
  { ap: 'ДОСТАВЧИЦИ', params: {}, group: 'true' },
  { ap: SUPPLIER, params: { 'БУЛСТАТ': '000000044' } },
]
const ITEMS = parseAnalyticsFile(new TextEncoder().encode(JSON.stringify(AP_ROWS)))

const storeSale = (no: string, day: string, path: string, net: number): ImportDocument => ({
  date: `2025-03-${day}`, docType: '-ФЕ', docNumber: `${SERIES_B}${no}`, vatKind: '1', total: net * 1.2, ops: [
    { d: '411', k: '702', ad: path, amount: net },
    { d: '411', k: '4532', ad: path, amount: net * 0.2 },
  ],
})

const MARCH: ImportDocument[] = [
  { date: '2025-03-02', docType: '-ФЕ', docNumber: `${SERIES_A}00101`, vatKind: '1', total: 12, ops: [
    { d: '411', k: '702', ad: HOME_CUSTOMER, amount: 10 }, { d: '411', k: '4532', ad: HOME_CUSTOMER, amount: 2 },
  ] },
  storeSale('00101', '03', PAIRED, 100),
  storeSale('00102', '04', INVOICED, 50),
  storeSale('00103', '05', EDITED, 30),
  storeSale('00104', '06', ANALYZED, 20),
  storeSale('00105', '07', NAMELESS, 10),
  { date: '2025-03-10', docType: '+ФЕ', docNumber: '77', vatKind: '1', total: 120, ops: [
    { d: '304', k: '401', ad: GOODS, ak: SUPPLIER, qty: 30, amount: 100 }, { d: '4531', k: '401', ak: SUPPLIER, amount: 20 },
  ] },
]

const execute = { eik: EIK, dryRun: false }

interface World {
  home: string
  store: string
  storeSlug: string
  by: { id: string }
  /** The contacts the import made in the store, by analytic path. */
  made: Record<string, any>
  /** The store's older contacts. */
  older: Record<string, any>
}

let seq = 0
let w: World

/** A contact the store held before the books came: made now, dated before the import. */
async function older(orgId: string, fields: Record<string, unknown>) {
  const c = await Contact.create({ orgId, ...fields })
  await Contact.collection.updateOne({ _id: c._id }, { $set: { createdAt: LONG_AGO, updatedAt: LONG_AGO } })
  return Contact.findById(c._id).lean()
}

const madeFor = async (orgId: string, path: string) => {
  const a: any = await AccountingAnalytic.findOne({ orgId, path }).lean()
  return a?.contactId ? Contact.findById(a.contactId).lean() : null
}

async function makeWorld(): Promise<World> {
  const n = ++seq
  const home = await createTestOrg({ slug: `relink-home-${n}`, name: 'Магазин А', taxNumber: EIK } as any)
  const store = await createTestOrg({ slug: `relink-store-${n}`, name: 'Магазин Б', taxNumber: EIK } as any)
  await linkBooks({
    booksSlug: home.slug,
    split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_A] }, { slug: store.slug, code: 'B', docSeries: [SERIES_B] }],
  }, { dryRun: false })
  const user = await createTestUser(home._id as any)
  const by = { id: String(user._id) }
  for (const orgId of [String(home._id), String(store._id)]) {
    await importChart(orgId, { ...execute, accounts: CHART }, by)
    await importAnalytics(orgId, { ...execute, items: ITEMS }, by)
    await importJournalMonth(orgId, { ...execute, month: '2025-03', coverage: YEAR, documents: MARCH }, by)
  }
  const s = String(store._id)

  const made: Record<string, any> = {}
  for (const path of [PAIRED, INVOICED, EDITED, ANALYZED, NAMELESS]) made[path] = await madeFor(s, path)
  // Two contacts for one company, made by the first import for two of its spellings (by hand here).
  made[TWICE_1] = (await Contact.create({ orgId: s, type: 'customer', companyName: 'Клиент З', taxId: '000000088' })).toObject()
  made[TWICE_2] = (await Contact.create({ orgId: s, type: 'customer', companyName: 'Клиент И', vatNumber: 'BG 000000088' })).toObject()
  await AccountingAnalytic.updateOne({ orgId: s, path: TWICE_1 }, { $set: { contactId: made[TWICE_1]._id } })
  await AccountingAnalytic.updateOne({ orgId: s, path: TWICE_2 }, { $set: { contactId: made[TWICE_2]._id } })

  const o: Record<string, any> = {}
  // The shop buys from this company, and typed its number with spaces.
  o[PAIRED] = await older(s, { type: 'supplier', companyName: 'Клиент Б ООД', taxId: '000 000 022' })
  o[INVOICED] = await older(s, { type: 'customer', companyName: 'Клиент Д', vatNumber: 'BG000000055' })
  o[EDITED] = await older(s, { type: 'both', companyName: 'Клиент Е', taxNumber: '000-000-066' })
  o[ANALYZED] = await older(s, { type: 'customer', companyName: 'Клиент Ж', taxId: '000000077' })
  o[NAMELESS] = await older(s, { type: 'supplier', companyName: 'Клиент Без' })

  await createTestInvoice(store._id as any, made[INVOICED]._id)
  await AuditLog.create({ orgId: s, userId: user._id, action: 'update', module: 'invoicing', entityType: 'contact', entityId: made[EDITED]._id, entityName: 'Клиент Е' })
  await DocFile.create({
    orgId: s, docType: 'invoicem', docNumber: '0000000001', docDate: '2025-03-06', originalName: 'doc.pdf', currentPath: '/nowhere',
    // A checksum that starts with the pair's id names nothing: an id is 24 hex digits on their own.
    currentChecksum: 'c'.repeat(64), mimeType: 'application/pdf', size: 1, uploadedBy: user._id,
    analysis: { mapped: { contactId: String(made[ANALYZED]._id) }, checksum: `${String(made[PAIRED]._id)}${'f'.repeat(40)}` },
  })
  return { home: String(home._id), store: s, storeSlug: store.slug, by, made, older: o }
}

/** What the books say, per account, per analytic, per correspondent, and the balance sheet's totals. */
async function ledgerOf(orgId: string): Promise<string> {
  const [tb, atb, mb, sheet] = await Promise.all([
    trialBalance(orgId, YEAR), analyticTrialBalance(orgId, YEAR), mainBook(orgId, YEAR), getBalanceSheet(orgId, new Date('2025-12-31T00:00:00.000Z')),
  ])
  return JSON.stringify([tb, atb, mb, [sheet.totalAssets, sheet.totalLiabilitiesAndEquity]])
}

const linesWith = async (orgId: string, contactId: unknown) =>
  (await JournalEntry.find({ orgId, 'lines.contactId': contactId }).lean() as any[]).flatMap(e => e.lines.filter((l: any) => String(l.contactId) === String(contactId)))

beforeAll(async () => {
  await setupTestDB()
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await clearCollections()
  w = await makeWorld()
})

describe('the dry run', () => {
  it('finds the second contact for an older one by its number, whatever its type, and says what it leaves alone and why', async () => {
    const plan = await planRelink(w.store)
    expect(plan.since).toBeInstanceOf(Date)
    expect(plan.counts).toEqual({
      partnerAnalytics: 7,
      made: 7,
      noNumber: 1,
      noOlder: 2,
      madeTwice: 2,
      withOlder: 4,
      namedElsewhere: 3,
      pairs: 1,
      keepDeactivated: 0,
      lookAlikes: 1,
      analytics: 1,
      entries: 1,
      lines: 2,
      byType: { 'customer<-supplier': 1 },
    })
    expect(plan.pairs).toEqual([{
      duplicateId: String(w.made[PAIRED]._id),
      keepId: String(w.older[PAIRED]._id),
      duplicateType: 'customer',
      keepType: 'supplier',
      keepActive: true,
      analyticIds: [String((await AccountingAnalytic.findOne({ orgId: w.store, path: PAIRED }).lean() as any)._id)],
      // An operation is a debit line and a credit line: the partner is on the debits, 0 and 2.
      entries: [expect.objectContaining({ lines: [expect.objectContaining({ i: 0 }), expect.objectContaining({ i: 2 })] })],
    }])
  })

  it('writes nothing', async () => {
    const before = await Promise.all([Contact.countDocuments({ orgId: w.store }), ledgerOf(w.store)])
    await planRelink(w.store)
    expect(await Promise.all([Contact.countDocuments({ orgId: w.store }), ledgerOf(w.store)])).toEqual(before)
    expect(await AuditLog.countDocuments({ via: SCRIPT })).toBe(0)
  })

  it('the home: its contacts were made by its own entries and none is a second one', async () => {
    expect((await planRelink(w.home)).counts).toMatchObject({ made: 2, pairs: 0, withOlder: 0 })
  })
})

describe('the run', () => {
  it('points the analytic and its lines at the older contact, deletes the made one, and moves no balance', async () => {
    const before = await Promise.all([ledgerOf(w.home), ledgerOf(w.store)])
    const result = await applyRelink(await planRelink(w.store))
    expect(result).toEqual({ analytics: 1, entries: 1, lines: 2, deleted: 1, kept: 0, failed: [] })

    const keep = w.older[PAIRED]
    expect(String((await AccountingAnalytic.findOne({ orgId: w.store, path: PAIRED }).lean() as any).contactId)).toBe(String(keep._id))
    expect(await linesWith(w.store, w.made[PAIRED]._id)).toEqual([])
    expect(await linesWith(w.store, keep._id)).toHaveLength(2)
    expect(await Contact.findById(w.made[PAIRED]._id).lean()).toBeNull()
    // Found, never retyped: the shop's supplier stays a supplier.
    expect(await Contact.findById(keep._id).lean()).toMatchObject({ type: 'supplier', taxId: '000 000 022' })
    // What something else names is all still there.
    for (const path of [INVOICED, EDITED, ANALYZED, NAMELESS, TWICE_1, TWICE_2]) expect(await Contact.exists({ _id: w.made[path]._id })).toBeTruthy()

    expect(await Promise.all([ledgerOf(w.home), ledgerOf(w.store)])).toEqual(before)
    const audit: any[] = await AuditLog.find({ orgId: w.store, via: SCRIPT }).lean()
    expect(audit).toHaveLength(1)
    // The run's row names the org, never a contact: a person's edit is what keeps a contact (`namedOutsideBooks`).
    expect([audit[0].entityType, String(audit[0].entityId), audit[0].userId]).toEqual(['contact', w.store, undefined])
  })

  it('a second run finds no pair', async () => {
    await applyRelink(await planRelink(w.store))
    const again = await planRelink(w.store)
    expect(again.counts).toMatchObject({ pairs: 0, withOlder: 3, namedElsewhere: 3, made: 6 })
    expect(await applyRelink(again)).toEqual({ analytics: 0, entries: 0, lines: 0, deleted: 0, kept: 0, failed: [] })
  })

  it('keeps a made contact something names after the plan, and points the books away from it all the same', async () => {
    const plan = await planRelink(w.store)
    await createTestInvoice(w.store as any, w.made[PAIRED]._id)
    expect(await applyRelink(plan)).toMatchObject({ analytics: 1, lines: 2, deleted: 0, kept: 1 })
    expect(await Contact.exists({ _id: w.made[PAIRED]._id })).toBeTruthy()
    expect(await linesWith(w.store, w.made[PAIRED]._id)).toEqual([])
  })

  it('the next import of the month reports the entry changed, once, and writes it as it is', async () => {
    await applyRelink(await planRelink(w.store))
    const month = (dryRun: boolean) => importJournalMonth(w.store, { eik: EIK, dryRun, month: '2025-03', coverage: YEAR, documents: MARCH }, w.by)
    expect(await month(true)).toMatchObject({ entries: 5, changed: 1, unchanged: 4, new: 0, gone: 0 })
    await month(false)
    expect(await month(true)).toMatchObject({ entries: 5, changed: 0, unchanged: 5 })
    expect(await linesWith(w.store, w.older[PAIRED]._id)).toHaveLength(2)
  })
})

describe('undo', () => {
  it('makes the deleted contact again as it was and points the books back at it, after a re-import too', async () => {
    const ledger = await ledgerOf(w.store)
    const plan = await planRelink(w.store)
    const manifest = parseManifest(manifestText(await manifestOf(plan, w.storeSlug)), w.store)
    const original: any = await Contact.findById(w.made[PAIRED]._id).lean()
    await applyRelink(plan)
    await importJournalMonth(w.store, { ...execute, month: '2025-03', coverage: YEAR, documents: MARCH }, w.by)

    expect(await undoRelink(manifest, false)).toEqual({ pairs: 1, contacts: 1, analytics: 1, entries: 1, lines: 2 })
    expect(await Contact.exists({ _id: w.made[PAIRED]._id })).toBeNull()
    expect(await undoRelink(manifest, true)).toEqual({ pairs: 1, contacts: 1, analytics: 1, entries: 1, lines: 2 })

    expect(await Contact.findById(w.made[PAIRED]._id).lean()).toEqual(original)
    expect(String((await AccountingAnalytic.findOne({ orgId: w.store, path: PAIRED }).lean() as any).contactId)).toBe(String(w.made[PAIRED]._id))
    expect(await linesWith(w.store, w.made[PAIRED]._id)).toHaveLength(2)
    expect(await linesWith(w.store, w.older[PAIRED]._id)).toEqual([])
    expect(await ledgerOf(w.store)).toBe(ledger)
    // Back where it was: the dry run finds the pair again, and an undo once more changes nothing.
    expect((await planRelink(w.store)).counts.pairs).toBe(1)
    expect(await undoRelink(manifest, true)).toEqual({ pairs: 1, contacts: 0, analytics: 0, entries: 0, lines: 0 })
  })

  it('refuses another org\'s manifest, and what is no manifest', async () => {
    const text = manifestText(await manifestOf(await planRelink(w.store), w.storeSlug))
    expect((await captureRejection(Promise.resolve().then(() => parseManifest(text, w.home)))).code).toBe('other_org')
    expect((await captureRejection(Promise.resolve().then(() => parseManifest('{"a":1}', w.store)))).code).toBe('not_a_manifest')
  })
})

describe('which orgs', () => {
  it('only an org keeping a share of split books', async () => {
    await createTestOrg({ slug: 'relink-plain', taxNumber: EIK } as any)
    const own = await createTestOrg({ slug: 'relink-own-books', taxNumber: EIK } as any)
    await Org.updateOne({ _id: own._id }, { $set: { 'settings.accounting.books': { mode: 'books', branches: [] } } })
    for (const slug of ['relink-plain', 'relink-own-books']) {
      const err = await captureRejection(splitOrg(slug))
      expect(err).toBeInstanceOf(RelinkError)
      expect(err.code).toBe('not_split')
    }
    expect((await captureRejection(splitOrg('relink-nobody'))).code).toBe('not_found')
    expect(await splitOrg(w.storeSlug)).toMatchObject({ id: w.store, role: 'member' })
  })
})

describe('the script', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..')
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'relink-books-contacts.ts'), ...args], {
      cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: out + err }
  }

  it('a dry run of counts, --expect, a manifest outside the checkout, and --undo', async () => {
    // The script builds no index and refuses to write without the unique ones: the app (here, the test) builds them.
    await Promise.all([AccountingAnalytic, AuditLog, Contact, JournalEntry].map(M => M.init()))
    const out = mkdtempSync(join(tmpdir(), 'relink-books-contacts-test-'))
    try {
      const dry = await cli('--org', w.storeSlug)
      expect(dry.code).toBe(0)
      expect(dry.out).toContain('PAIRS: a second contact for the older one')
      expect(dry.out).toContain('Re-run with --execute --expect 1.')
      // Counts only: no name of anyone.
      for (const name of ['Клиент', 'Доставчик']) expect(dry.out).not.toContain(name)

      expect((await cli('--org', w.storeSlug, '--execute')).code).toBe(2)
      expect((await cli('--org', w.storeSlug, '--execute', '--expect', '2', '--out', out)).code).toBe(2)
      expect(await Contact.exists({ _id: w.made[PAIRED]._id })).toBeTruthy()

      const run = await cli('--org', w.storeSlug, '--execute', '--expect', '1', '--out', out)
      expect(run.code).toBe(0)
      expect(run.out).toContain('Made contacts deleted: 1')
      expect(await Contact.exists({ _id: w.made[PAIRED]._id })).toBeNull()
      const [file] = readdirSync(out)
      expect(file).toMatch(/^relink-books-contacts-.+\.json$/)
      expect(readFileSync(join(out, file), 'utf8')).toContain(String(w.made[PAIRED]._id))

      expect((await cli('--org', w.storeSlug)).out).toContain('Re-run with --execute --expect 0.')
      const undoDry = await cli('--org', w.storeSlug, '--undo', join(out, file))
      expect(undoDry.code).toBe(0)
      expect(undoDry.out).toContain('made contacts to make again')
      expect(await Contact.exists({ _id: w.made[PAIRED]._id })).toBeNull()
      expect((await cli('--org', w.storeSlug, '--undo', join(out, file), '--execute')).code).toBe(0)
      expect(await Contact.exists({ _id: w.made[PAIRED]._id })).toBeTruthy()

      const refused = await cli('--org', `relink-home-${seq}-missing`)
      expect(refused.code).toBe(2)
      expect(refused.out).toContain('Refused (not_found)')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
    expect(existsSync(out)).toBe(false)
  }, 120_000)
})
