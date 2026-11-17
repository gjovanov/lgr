import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCollections, setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { AccountingAnalytic, AuditLog, Contact, JournalEntry } from 'db/models'
import { importAnalytics, importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { analyticTrialBalance, mainBook, trialBalance } from 'services/biz/accounting-books/books-ledger'
import { getBalanceSheet } from 'services/biz/accounting.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'
import {
  SCRIPT, applyFillerLinks, manifestOf, manifestText, parseManifest, planFillerLinks, undoFillerLinks,
} from '../../../../scripts/lib/books-filler-links'

/**
 * FR-25 R7: the repair for the partner links the first split import made on a number that is no number
 * (`scripts/relink-books-filler-links.ts`). Fictional data only.
 *
 * The books give partners abroad a number typed to fill the box, and several share one. The first import looked a
 * partner up by that number as written, so each of them was linked to the one contact of the store that held it.
 * Today's import finds such a partner by its name, so the state is made the way the first import left it: the
 * analytics are imported, the links are set by hand to the contact holding the filler, and only then is the month
 * imported, so its lines carry that contact and its entries' stored hashes say so.
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

/** Numbers typed to fill the box. */
const NINES = '9999999999'
const EIGHTS = '888888888'
const SEVENS = '777777777'

const GOODS = 'СТОКИ:БОЛТОВЕ'
/** The store holds this supplier, under this name, with the filler: rightly linked. */
const OWNER = 'ДОСТАВЧИЦИ:Доставчик Първи'
/** Shares the filler. The org's entries book on it and nobody of its name is held: a contact is made. */
const BOOKED = 'ДОСТАВЧИЦИ:Доставчик Втори'
/** Shares the filler. The store holds a contact of its exact name. */
const NAMED = 'ДОСТАВЧИЦИ:Доставчик Трети'
/** Shares the filler. Nothing books on it and nobody of its name is held: the link is removed. */
const UNBOOKED = 'ДОСТАВЧИЦИ:Доставчик Четвърти'
/** A filler for its ЕИК and a VAT number of its own: its contact is made by its first entry. */
const C_OWNER = 'КЛИЕНТИ:Клиент Първи'
/** The same filler for its ЕИК, and its own VAT number, which a store contact holds under another name. */
const C_NUMBERED = 'КЛИЕНТИ:Клиент Втори'
/** Its own contact, renamed in the app since: a link on a filler to a contact that is nobody else's. */
const RENAMED = 'КЛИЕНТИ:Клиент Трети'
/** Its own contact, whose number someone retyped since: no filler made that link. */
const RETYPED = 'КЛИЕНТИ:Клиент А'

const AP_ROWS = [
  { ap: 'СТОКИ', params: {}, group: 'true' },
  { ap: GOODS, params: { 'МЯРКА': 'бр' } },
  { ap: 'ДОСТАВЧИЦИ', params: {}, group: 'true' },
  { ap: OWNER, params: { 'БУЛСТАТ': '', 'ИНДДС': NINES } },
  { ap: BOOKED, params: { 'БУЛСТАТ': '', 'ИНДДС': NINES, 'АДРЕС': 'ул. Първа 1', 'ГРАД': 'гр. Измир' } },
  { ap: NAMED, params: { 'ИНДДС': NINES } },
  { ap: UNBOOKED, params: { 'ИНДДС': NINES } },
  { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
  { ap: RETYPED, params: { 'БУЛСТАТ': '000000011' } },
  { ap: C_OWNER, params: { 'БУЛСТАТ': EIGHTS, 'ИНДДС': 'RO00054321' } },
  { ap: C_NUMBERED, params: { 'БУЛСТАТ': EIGHTS, 'ИНДДС': 'RO00012345' } },
  { ap: RENAMED, params: { 'БУЛСТАТ': SEVENS } },
]
const ITEMS = parseAnalyticsFile(new TextEncoder().encode(JSON.stringify(AP_ROWS)))

/** A purchase names no series: it is the home's. */
const purchase = (month: string, no: string, day: string, path: string, net: number): ImportDocument => ({
  date: `2025-${month}-${day}`, docType: '+ФЕ', docNumber: no, vatKind: '1', total: net * 1.2, ops: [
    { d: '304', k: '401', ad: GOODS, ak: path, qty: 10, amount: net },
    { d: '4531', k: '401', ak: path, amount: net * 0.2 },
  ],
})

const sale = (month: string, series: string, no: string, day: string, path: string, net: number): ImportDocument => ({
  date: `2025-${month}-${day}`, docType: '-ФЕ', docNumber: `${series}${no}`, vatKind: '1', total: net * 1.2, ops: [
    { d: '411', k: '702', ad: path, amount: net },
    { d: '411', k: '4532', ad: path, amount: net * 0.2 },
  ],
})

/** The holders' own entries: the month that makes the customer holder's contact. */
const FEBRUARY: ImportDocument[] = [
  purchase('02', '61', '10', OWNER, 100),
  sale('02', SERIES_A, '00091', '11', C_OWNER, 10),
]

const MARCH: ImportDocument[] = [
  purchase('03', '72', '03', BOOKED, 200),
  purchase('03', '73', '04', NAMED, 300),
  sale('03', SERIES_A, '00102', '06', C_NUMBERED, 20),
  sale('03', SERIES_A, '00103', '07', RENAMED, 30),
  sale('03', SERIES_A, '00104', '08', RETYPED, 40),
  sale('03', SERIES_B, '00201', '09', RETYPED, 50),
]

/** Booked on the partner nothing booked on, a month later. */
const APRIL: ImportDocument[] = [purchase('04', '81', '02', UNBOOKED, 400)]

const execute = { eik: EIK, dryRun: false }

interface World {
  home: string
  homeSlug: string
  store: string
  by: { id: string }
  /** The home's contacts the wrong links point at. */
  holder: any
  customerHolder: any
  /** The home's contacts today's rule finds for two of the partners. */
  named: any
  numbered: any
  /** The store's contact its wrong links point at. */
  storeHolder: any
}

let seq = 0
let w: World

/** A contact the store held before the books came: made now, dated before the import. */
async function older(orgId: string, fields: Record<string, unknown>) {
  const c = await Contact.create({ orgId, ...fields })
  await Contact.collection.updateOne({ _id: c._id }, { $set: { createdAt: LONG_AGO, updatedAt: LONG_AGO } })
  return Contact.findById(c._id).lean()
}

const analytic = async (orgId: string, path: string): Promise<any> => AccountingAnalytic.findOne({ orgId, path }).lean()
const contactOf = async (orgId: string, path: string): Promise<any> => {
  const a = await analytic(orgId, path)
  return a?.contactId ? Contact.findById(a.contactId).lean() : null
}
/** The link the first import made: the analytic points at the contact that holds its filler. */
const linkedOnFiller = (orgId: string, path: string, holder: any) =>
  AccountingAnalytic.updateOne({ orgId, path }, { $set: { contactId: holder._id } })

async function makeWorld(): Promise<World> {
  const n = ++seq
  const home = await createTestOrg({ slug: `filler-home-${n}`, name: 'Магазин А', taxNumber: EIK } as any)
  const store = await createTestOrg({ slug: `filler-store-${n}`, name: 'Магазин Б', taxNumber: EIK } as any)
  await linkBooks({
    booksSlug: home.slug,
    split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_A] }, { slug: store.slug, code: 'B', docSeries: [SERIES_B] }],
  }, { dryRun: false })
  const user = await createTestUser(home._id as any)
  const by = { id: String(user._id) }
  const h = String(home._id)
  const s = String(store._id)

  // What the stores held before the books came. The seed wrote a supplier's one number into all three fields.
  const holder = await older(h, { type: 'supplier', companyName: 'Доставчик Първи', taxId: NINES, taxNumber: NINES, vatNumber: NINES })
  const named = await older(h, { type: 'supplier', companyName: 'Доставчик Трети' })
  const numbered = await older(h, { type: 'both', companyName: 'Клиент Втори ООД', vatNumber: 'RO 000 12345' })
  const storeHolder = await older(s, { type: 'supplier', companyName: 'Доставчик Първи', taxId: NINES, taxNumber: NINES, vatNumber: NINES })

  for (const orgId of [h, s]) {
    await importChart(orgId, { ...execute, accounts: CHART }, by)
    await importAnalytics(orgId, { ...execute, items: ITEMS }, by)
  }
  await importJournalMonth(h, { ...execute, month: '2025-02', coverage: YEAR, documents: FEBRUARY }, by)
  const customerHolder = await contactOf(h, C_OWNER)

  // The first import's links, before the month's entries are written on them.
  for (const path of [BOOKED, NAMED, UNBOOKED]) await linkedOnFiller(h, path, holder)
  await linkedOnFiller(h, C_NUMBERED, customerHolder)
  for (const path of [BOOKED, UNBOOKED]) await linkedOnFiller(s, path, storeHolder)
  for (const orgId of [h, s]) await importJournalMonth(orgId, { ...execute, month: '2025-03', coverage: YEAR, documents: MARCH }, by)

  // Since then, in the app: one contact renamed, another's number retyped.
  await Contact.updateOne({ _id: (await contactOf(h, RENAMED))._id }, { $set: { companyName: 'Клиент Трети и синове' } })
  await Contact.updateOne({ _id: (await contactOf(h, RETYPED))._id }, { $set: { taxId: '000000012', taxNumber: '000000012' } })

  return { home: h, homeSlug: home.slug, store: s, by, holder, customerHolder, named, numbered, storeHolder }
}

/** What the books say, per account, per analytic, per correspondent, and the balance sheet's totals. */
async function ledgerOf(orgId: string): Promise<string> {
  const [tb, atb, mb, sheet] = await Promise.all([
    trialBalance(orgId, YEAR), analyticTrialBalance(orgId, YEAR), mainBook(orgId, YEAR), getBalanceSheet(orgId, new Date('2025-12-31T00:00:00.000Z')),
  ])
  return JSON.stringify([tb, atb, mb, [sheet.totalAssets, sheet.totalLiabilitiesAndEquity]])
}

/** The analytics of the lines that carry a contact, sorted: whose entries a contact's ledger shows. */
const analyticsOn = async (orgId: string, contactId: unknown): Promise<string[]> => {
  const entries: any[] = await JournalEntry.find({ orgId, 'lines.contactId': contactId }).lean()
  const ids = entries.flatMap(e => e.lines.filter((l: any) => String(l.contactId) === String(contactId)).map((l: any) => String(l.analyticId)))
  const paths = new Map((await AccountingAnalytic.find({ orgId }, { path: 1 }).lean() as any[]).map(a => [String(a._id), a.path as string]))
  return ids.map(id => paths.get(id) ?? id).sort()
}

const linkOf = async (orgId: string, path: string) => {
  const a = await analytic(orgId, path)
  return a.contactId ? String(a.contactId) : undefined
}

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
  it('finds the links made on a filler to another partner\'s contact, and says what each gets and what is left alone', async () => {
    // The state the first import left: three suppliers' lines on the one contact that holds their filler.
    expect(await analyticsOn(w.home, w.holder._id)).toEqual([OWNER, OWNER, BOOKED, BOOKED, NAMED, NAMED].sort())

    const plan = await planFillerLinks(w.home)
    expect(plan.counts).toEqual({
      partnerAnalytics: 8,
      byNumber: 1,
      byName: 1,
      dangling: 0,
      unexplained: 1,
      noOwner: 1,
      wrong: 4,
      holders: 2,
      repoint: 2,
      create: 1,
      unlink: 1,
      entries: 3,
      lines: 6,
    })
    const id = async (path: string) => String((await analytic(w.home, path))._id)
    expect(plan.links).toEqual([
      {
        analyticId: await id(BOOKED), fromId: String(w.holder._id), action: 'create', toId: expect.any(String),
        // The contact the journal import makes for a partner its entries name, from what the analytic keeps of the file.
        contact: expect.objectContaining({
          type: 'supplier', companyName: 'Доставчик Втори', taxId: NINES, taxNumber: NINES, vatNumber: NINES,
          addresses: [{ type: 'billing', street: 'ул. Първа 1', city: 'Измир', country: 'BG', isDefault: true }],
        }),
        // An operation is a debit line and a credit line: a supplier is on the credits, 1 and 3.
        entries: [{ entryId: expect.any(String), lines: [1, 3] }],
      },
      { analyticId: await id(NAMED), fromId: String(w.holder._id), action: 'repoint', toId: String(w.named._id), entries: [{ entryId: expect.any(String), lines: [1, 3] }] },
      { analyticId: await id(UNBOOKED), fromId: String(w.holder._id), action: 'unlink', entries: [] },
      // Found by its own number, spaced and typed `both` in the store: a customer is on the debits, 0 and 2.
      { analyticId: await id(C_NUMBERED), fromId: String(w.customerHolder._id), action: 'repoint', toId: String(w.numbered._id), entries: [{ entryId: expect.any(String), lines: [0, 2] }] },
    ])
  })

  it('writes nothing', async () => {
    const before = await Promise.all([Contact.find({ orgId: w.home }).sort({ _id: 1 }).lean(), AccountingAnalytic.find({ orgId: w.home }).sort({ _id: 1 }).lean(), ledgerOf(w.home)])
    await planFillerLinks(w.home)
    expect(await Promise.all([Contact.find({ orgId: w.home }).sort({ _id: 1 }).lean(), AccountingAnalytic.find({ orgId: w.home }).sort({ _id: 1 }).lean(), ledgerOf(w.home)])).toEqual(before)
    expect(await AuditLog.countDocuments({ via: SCRIPT })).toBe(0)
  })

  it('the sister store: its entries book on none of them, so every wrong link is removed', async () => {
    const plan = await planFillerLinks(w.store)
    expect(plan.counts).toMatchObject({ partnerAnalytics: 4, byNumber: 1, byName: 1, wrong: 2, holders: 1, repoint: 0, create: 0, unlink: 2, entries: 0, lines: 0 })
    expect(plan.links.map(l => l.action)).toEqual(['unlink', 'unlink'])
  })
})

describe('the run', () => {
  it('gives each partner the contact a fresh import would, moves its lines with it, and changes no contact and no balance', async () => {
    const before = await Promise.all([ledgerOf(w.home), ledgerOf(w.store)])
    const result = await applyFillerLinks(await planFillerLinks(w.home))
    expect(result).toEqual({ analytics: 4, entries: 3, lines: 6, created: 1, unlinked: 1, failed: [] })

    // The holders keep their own entries, and only those.
    expect(await analyticsOn(w.home, w.holder._id)).toEqual([OWNER, OWNER])
    expect(await analyticsOn(w.home, w.customerHolder._id)).toEqual([C_OWNER, C_OWNER])
    expect(await Contact.findById(w.holder._id).lean()).toEqual(w.holder)
    expect(await Contact.findById(w.customerHolder._id).lean()).toEqual(w.customerHolder)

    // Made as the journal import makes one, lowered mirrors included.
    const made = await contactOf(w.home, BOOKED)
    expect(made).toMatchObject({ type: 'supplier', companyName: 'Доставчик Втори', companyNameLower: 'доставчик втори', taxId: NINES, vatNumber: NINES, isActive: true })
    expect(made.addresses).toMatchObject([{ street: 'ул. Първа 1', city: 'Измир' }])
    expect(await analyticsOn(w.home, made._id)).toEqual([BOOKED, BOOKED])

    expect(await linkOf(w.home, NAMED)).toBe(String(w.named._id))
    expect(await analyticsOn(w.home, w.named._id)).toEqual([NAMED, NAMED])
    expect(await linkOf(w.home, C_NUMBERED)).toBe(String(w.numbered._id))
    expect(await analyticsOn(w.home, w.numbered._id)).toEqual([C_NUMBERED, C_NUMBERED])
    // Found, never retyped.
    expect(await Contact.findById(w.numbered._id).lean()).toEqual(w.numbered)
    expect('contactId' in (await analytic(w.home, UNBOOKED))).toBe(false)

    // Left alone: a contact someone renamed, and one whose number someone retyped.
    expect((await contactOf(w.home, RENAMED)).companyName).toBe('Клиент Трети и синове')
    expect((await contactOf(w.home, RETYPED)).taxId).toBe('000000012')

    expect(await Promise.all([ledgerOf(w.home), ledgerOf(w.store)])).toEqual(before)
    const audit: any[] = await AuditLog.find({ orgId: w.home, via: SCRIPT }).lean()
    expect(audit).toHaveLength(1)
    // The run's row names the org, never a contact.
    expect([audit[0].entityType, String(audit[0].entityId), audit[0].userId]).toEqual(['contact', w.home, undefined])
    expect(Object.fromEntries(audit[0].changes.map((c: any) => [c.field, c.newValue]))).toEqual({ links: 4, analytics: 4, entries: 3, lines: 6, created: 1, unlinked: 1 })
  })

  it('a second run finds nothing wrong', async () => {
    await applyFillerLinks(await planFillerLinks(w.home))
    const again = await planFillerLinks(w.home)
    expect(again.counts).toMatchObject({ partnerAnalytics: 7, byNumber: 2, byName: 3, unexplained: 1, noOwner: 1, wrong: 0 })
    expect(again.links).toEqual([])
    expect(await applyFillerLinks(again)).toEqual({ analytics: 0, entries: 0, lines: 0, created: 0, unlinked: 0, failed: [] })
    expect(await AuditLog.countDocuments({ orgId: w.home, via: SCRIPT })).toBe(1)
  })

  it('the next import of the month reports the re-pointed entries changed, once, and writes them as they are', async () => {
    await applyFillerLinks(await planFillerLinks(w.home))
    const lines = async () => JSON.stringify((await JournalEntry.find({ orgId: w.home }).sort({ _id: 1 }).lean() as any[]).map(e => e.lines.map((l: any) => [String(l.analyticId ?? ''), String(l.contactId ?? '')])))
    const written = await lines()
    const month = (dryRun: boolean) => importJournalMonth(w.home, { eik: EIK, dryRun, month: '2025-03', coverage: YEAR, documents: MARCH }, w.by)
    expect(await month(true)).toMatchObject({ entries: 5, changed: 3, unchanged: 2, new: 0, gone: 0 })
    await month(false)
    expect(await month(true)).toMatchObject({ entries: 5, changed: 0, unchanged: 5 })
    expect(await lines()).toBe(written)
    // And it makes no second contact for the partner the run made one for.
    expect(await Contact.countDocuments({ orgId: w.home, companyName: 'Доставчик Втори' })).toBe(1)
  })

  it('a partner booked on since the dry run is left alone, and gets its contact from the next one', async () => {
    const plan = await planFillerLinks(w.home)
    await importJournalMonth(w.home, { ...execute, month: '2025-04', coverage: YEAR, documents: APRIL }, w.by)
    const result = await applyFillerLinks(plan)
    expect(result).toMatchObject({ analytics: 3, created: 1, unlinked: 0 })
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toContain('booked on since the dry run')
    expect(await linkOf(w.home, UNBOOKED)).toBe(String(w.holder._id))

    const next = await planFillerLinks(w.home)
    expect(next.counts).toMatchObject({ wrong: 1, create: 1, entries: 1, lines: 2 })
    expect(await applyFillerLinks(next)).toMatchObject({ analytics: 1, created: 1, failed: [] })
    expect((await contactOf(w.home, UNBOOKED)).companyName).toBe('Доставчик Четвърти')
    expect(await analyticsOn(w.home, w.holder._id)).toEqual([OWNER, OWNER])
  })

  it('a link someone changed since the dry run is left as they set it, and no contact is made for it', async () => {
    const plan = await planFillerLinks(w.home)
    const theirs = await Contact.create({ orgId: w.home, type: 'supplier', companyName: 'Някой друг' })
    await AccountingAnalytic.updateOne({ orgId: w.home, path: BOOKED }, { $set: { contactId: theirs._id } })
    const result = await applyFillerLinks(plan)
    expect(result).toMatchObject({ analytics: 3, created: 0, unlinked: 1 })
    expect(result.failed).toHaveLength(1)
    expect(await linkOf(w.home, BOOKED)).toBe(String(theirs._id))
    expect(await Contact.countDocuments({ orgId: w.home, companyName: 'Доставчик Втори' })).toBe(0)
  })
})

describe('undo', () => {
  it('points the books back and removes the contact the run made, after a re-import too', async () => {
    const ledger = await ledgerOf(w.home)
    const plan = await planFillerLinks(w.home)
    const manifest = parseManifest(manifestText(manifestOf(plan, w.homeSlug)), w.home)
    await applyFillerLinks(plan)
    const made = await contactOf(w.home, BOOKED)
    await importJournalMonth(w.home, { ...execute, month: '2025-03', coverage: YEAR, documents: MARCH }, w.by)

    expect(await undoFillerLinks(manifest, false)).toEqual({ links: 4, analytics: 4, entries: 3, lines: 6, contacts: 1, kept: 0, gone: 0 })
    expect(await linkOf(w.home, BOOKED)).toBe(String(made._id))
    expect(await undoFillerLinks(manifest, true)).toEqual({ links: 4, analytics: 4, entries: 3, lines: 6, contacts: 1, kept: 0, gone: 0 })

    for (const path of [BOOKED, NAMED, UNBOOKED]) expect(await linkOf(w.home, path)).toBe(String(w.holder._id))
    expect(await linkOf(w.home, C_NUMBERED)).toBe(String(w.customerHolder._id))
    expect(await analyticsOn(w.home, w.holder._id)).toEqual([OWNER, OWNER, BOOKED, BOOKED, NAMED, NAMED].sort())
    expect(await analyticsOn(w.home, w.customerHolder._id)).toEqual([C_OWNER, C_OWNER, C_NUMBERED, C_NUMBERED].sort())
    expect(await Contact.findById(made._id).lean()).toBeNull()
    expect(await ledgerOf(w.home)).toBe(ledger)
    // Back where it was: the dry run finds them again, and an undo once more changes nothing.
    expect((await planFillerLinks(w.home)).counts.wrong).toBe(4)
    expect(await undoFillerLinks(manifest, true)).toEqual({ links: 4, analytics: 0, entries: 0, lines: 0, contacts: 0, kept: 0, gone: 0 })
  })

  it('keeps the contact the run made when something names it by then', async () => {
    const plan = await planFillerLinks(w.home)
    const manifest = parseManifest(manifestText(manifestOf(plan, w.homeSlug)), w.home)
    await applyFillerLinks(plan)
    const made = await contactOf(w.home, BOOKED)
    await createTestInvoice(w.home as any, made._id)
    expect(await undoFillerLinks(manifest, true)).toMatchObject({ analytics: 4, lines: 6, contacts: 0, kept: 1 })
    expect(await Contact.exists({ _id: made._id })).toBeTruthy()
    expect(await linkOf(w.home, BOOKED)).toBe(String(w.holder._id))
  })

  it('refuses another org\'s manifest, and what is no manifest', async () => {
    const text = manifestText(manifestOf(await planFillerLinks(w.home), w.homeSlug))
    expect((await captureRejection(Promise.resolve().then(() => parseManifest(text, w.store)))).code).toBe('other_org')
    expect((await captureRejection(Promise.resolve().then(() => parseManifest('{"a":1}', w.home)))).code).toBe('not_a_manifest')
  })
})

describe('the script', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..')
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'relink-books-filler-links.ts'), ...args], {
      cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: out + err }
  }

  it('a dry run of counts, --expect, a manifest outside the checkout, and --undo', async () => {
    // The script builds no index and refuses to write without the unique ones: the app (here, the test) builds them.
    await Promise.all([AccountingAnalytic, AuditLog, Contact, JournalEntry].map(M => M.init()))
    const out = mkdtempSync(join(tmpdir(), 'relink-books-filler-links-test-'))
    try {
      const dry = await cli('--org', w.homeSlug)
      expect(dry.code).toBe(0)
      expect(dry.out).toContain('WRONG: on a filler, to a contact that is another partner\'s')
      expect(dry.out).toContain('Re-run with --execute --expect 4.')
      // Counts only: no name of anyone, and no number.
      for (const private_ of ['Клиент', 'Доставчик', NINES, EIGHTS]) expect(dry.out).not.toContain(private_)

      expect((await cli('--org', w.homeSlug, '--execute')).code).toBe(2)
      expect((await cli('--org', w.homeSlug, '--execute', '--expect', '3', '--out', out)).code).toBe(2)
      expect(await linkOf(w.home, NAMED)).toBe(String(w.holder._id))

      const run = await cli('--org', w.homeSlug, '--execute', '--expect', '4', '--out', out)
      expect(run.code).toBe(0)
      expect(run.out).toContain('Contacts made: 1')
      expect(await linkOf(w.home, NAMED)).toBe(String(w.named._id))
      const [file] = readdirSync(out)
      expect(file).toMatch(/^relink-books-filler-links-.+\.json$/)
      expect(readFileSync(join(out, file), 'utf8')).toContain(String(w.holder._id))

      expect((await cli('--org', w.homeSlug)).out).toContain('Re-run with --execute --expect 0.')
      const undoDry = await cli('--org', w.homeSlug, '--undo', join(out, file))
      expect(undoDry.code).toBe(0)
      expect(undoDry.out).toContain('analytics to point back')
      expect(await linkOf(w.home, NAMED)).toBe(String(w.named._id))
      expect((await cli('--org', w.homeSlug, '--undo', join(out, file), '--execute')).code).toBe(0)
      expect(await linkOf(w.home, NAMED)).toBe(String(w.holder._id))

      const refused = await cli('--org', `filler-home-${seq}-missing`)
      expect(refused.code).toBe(2)
      expect(refused.out).toContain('Refused (not_found)')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
    expect(existsSync(out)).toBe(false)
  }, 120_000)
})
