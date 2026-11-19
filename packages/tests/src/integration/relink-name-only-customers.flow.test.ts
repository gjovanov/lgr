import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mongoose } from 'db/connection'
import { AccountingAnalytic, AuditLog, Contact, Invoice, JournalEntry, StockMovement } from 'db/models'
import { matchContact } from 'services/biz/doc-import/matching'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestContact, createTestInvoice, createTestJournalEntry, createTestOrg, createTestStockMovement, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import {
  SCRIPT, applyNameOnlyCustomers, manifestOf, parseManifest, planNameOnlyCustomers, undoNameOnlyCustomers,
} from '../../../../scripts/lib/name-only-customers'
import { manifestText } from '../../../../scripts/lib/repair-run'

/**
 * FR-25 R3: the documents of a customer kept by its name alone move to the one contact that holds its company number and
 * carries the same name (`scripts/relink-name-only-customers.ts`). Made-up partners and documents only.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

const SLUG = 'name-only-twins-test'
let org: any, user: any
let c: Record<string, any> = {}
let d: Record<string, any> = {}
let movement: any, stray: any
const oid = () => new mongoose.Types.ObjectId()
const contactOf = async (doc: any) => String(((await Invoice.findById(doc._id).lean().exec()) as any).contactId)

async function world() {
  await Promise.all([Invoice, Contact, StockMovement, JournalEntry, AccountingAnalytic, AuditLog].map((M: any) => M.deleteMany({ orgId: org._id }).exec()))
  const customer = (companyName: string, extra: Record<string, unknown> = {}) => createTestContact(org._id, { type: 'customer', companyName, ...extra } as any)
  // Each name-only contact is made first, as the import left them: the older of two of the same name.
  c = {
    bare: await customer('ДВОЙНИК ТЕСТ ЕООД'),
    numbered: await customer('ДВОЙНИК ТЕСТ ЕООД', { taxId: '999000191', taxNumber: '999000191', vatNumber: 'BG999000191' }),
    aliasBare: await customer('ПРЕКОР ТЕСТ ЕООД'),
    aliasNumbered: await customer('ПРЕКОР-1 ТЕСТ ЕООД', { aliases: ['Прекор Тест ЕООД'], taxId: '999000282' }),
    splitBare: await customer('РАЗДВОЕН ТЕСТ ООД'),
    splitA: await customer('РАЗДВОЕН А ООД', { aliases: ['Раздвоен Тест ООД'], taxId: '999000373' }),
    splitB: await customer('РАЗДВОЕН Б ООД', { aliases: ['Раздвоен Тест ООД'], taxId: '999000464' }),
    lonely: await customer('САМОТЕН ТЕСТ ООД'),
  }
  const doc = (contact: any, number: string, extra: Record<string, unknown> = {}) =>
    createTestInvoice(org._id, contact._id, { invoiceNumber: `INV-${number}`, status: 'paid', ...extra } as any)
  d = {
    paid: await doc(c.bare, '3000700301'),
    note: await doc(c.bare, '3000700302', { type: 'credit_note', status: 'sent' }),
    session: await doc(c.bare, '3000700303', { register: { origin: 'pos', sessionId: oid() } }),
    booksElsewhere: await doc(c.bare, '3000700304'),
    booksUnlinked: await doc(c.bare, '3000700310'),
    ownEntry: await doc(c.bare, '3000700305'),
    sale: await doc(c.bare, '3000700306', { type: 'cash_sale' }),
    alias: await doc(c.aliasBare, '3000700307'),
    split: await doc(c.splitBare, '3000700308'),
    lonely: await doc(c.lonely, '3000700309'),
  }
  // The books file one document under the numbered contact, one under someone else, and one under a card linked to no
  // contact. An entry of the books naming no partner says nothing.
  const card = async (path: string, contactId?: unknown) => AccountingAnalytic.create({
    orgId: org._id, path, root: 'КЛИЕНТИ', name: path, nameLower: path.toLowerCase(), kind: 'customer', ...(contactId ? { contactId } : {}),
  } as any)
  const books = async (docNumber: string, analytic?: any) => createTestJournalEntry(org._id, oid(), user._id, {
    ledger: 'books', docType: '-ФЕ', docNumber, ...(analytic ? { partnerAnalyticId: analytic._id } : {}),
  } as any)
  await books('3000700301', await card('КЛИЕНТИ:ДВОЙНИК', c.numbered._id))
  await books('3000700302')
  await books('3000700304', await card('КЛИЕНТИ:ДРУГ', c.aliasNumbered._id))
  await books('3000700310', await card('КЛИЕНТИ:НИКОЙ'))
  // A document whose own entry names the name-only contact on a line.
  await createTestJournalEntry(org._id, oid(), user._id, {
    sourceModule: 'invoicing', sourceId: d.ownEntry._id,
    lines: [
      { accountId: oid(), contactId: c.bare._id, debit: 1, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1, baseCredit: 0 },
      { accountId: oid(), debit: 0, credit: 1, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1 },
    ],
  } as any)
  movement = await createTestStockMovement(org._id, { type: 'dispatch', status: 'completed', contactId: c.bare._id, invoiceId: d.paid._id } as any)
  stray = await createTestStockMovement(org._id, { type: 'dispatch', status: 'completed', contactId: c.bare._id } as any)
}

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg({ name: 'Двойници', slug: SLUG } as any)
  user = await createTestUser(org._id)
  await world()
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('the dry run', () => {
  it('finds the name-only customers kept twice, what moves, and what is left alone and why', async () => {
    const plan = await planNameOnlyCustomers(String(org._id))
    expect(plan.twins.map(t => [t.fromId, t.toId, t.documents.map(x => x.invoiceNumber), t.movements])).toEqual([
      [String(c.bare._id), String(c.numbered._id), ['INV-3000700301', 'INV-3000700302'], [String(movement._id)]],
      [String(c.aliasBare._id), String(c.aliasNumbered._id), ['INV-3000700307'], []],
    ])
    expect(plan.counts).toEqual({
      nameOnly: 4, twins: 2, none: 1, several: 1, documents: 3, booksAgree: 1, notInBooks: 2, movements: 1,
      left: {
        'a cash sale or a receipt naming the contact: never rewritten': 1,
        'in a till session': 1,
        'the books file it under another contact': 1,
        'the books file it under a partner card linked to no contact': 1,
        'its own journal entry names the contact': 1,
        'a stock movement of the contact that is no moved document\'s': 1,
      },
    })
  })

  it('writes nothing', async () => {
    expect(await contactOf(d.paid)).toBe(String(c.bare._id))
    expect(await AuditLog.countDocuments({ via: SCRIPT })).toBe(0)
  })
})

describe('the run', () => {
  it('moves the documents and the movement they made, changes no contact, and leaves one audit row', async () => {
    const before = await Contact.find({ orgId: org._id }).sort({ _id: 1 }).lean().exec()
    const result = await applyNameOnlyCustomers(await planNameOnlyCustomers(String(org._id)))
    expect(result).toEqual({ twins: 2, documents: 3, movements: 1, failed: [] })
    expect(await contactOf(d.paid)).toBe(String(c.numbered._id))
    expect(await contactOf(d.note)).toBe(String(c.numbered._id))
    expect(await contactOf(d.alias)).toBe(String(c.aliasNumbered._id))
    expect(String(((await StockMovement.findById(movement._id).lean().exec()) as any).contactId)).toBe(String(c.numbered._id))
    // What it left alone is as it was.
    for (const k of ['session', 'booksElsewhere', 'booksUnlinked', 'ownEntry', 'sale']) expect(await contactOf(d[k])).toBe(String(c.bare._id))
    expect(await contactOf(d.split)).toBe(String(c.splitBare._id))
    expect(String(((await StockMovement.findById(stray._id).lean().exec()) as any).contactId)).toBe(String(c.bare._id))
    expect(await Contact.find({ orgId: org._id }).sort({ _id: 1 }).lean().exec()).toEqual(before)
    const audit: any[] = await AuditLog.find({ orgId: org._id, via: SCRIPT }).lean()
    expect(audit).toHaveLength(1)
    expect(String(audit[0].entityId)).toBe(String(org._id))
    expect(audit[0].changes.map((x: any) => [x.field, x.newValue])).toEqual([['twins', 2], ['documents', 3], ['movements', 1]])
  })

  it('a second run finds nothing to move, and the import now names the contact holding the number', async () => {
    expect((await planNameOnlyCustomers(String(org._id))).counts.documents).toBe(0)
    const found = await matchContact(String(org._id), { name: 'ДВОЙНИК ТЕСТ ЕООД' } as any, 'customer', { create: false, enrich: false })
    expect(found?.contactId).toBe(String(c.numbered._id))
  })

  it('a document someone moved since the dry run is left as they set it, and reported', async () => {
    await world()
    const plan = await planNameOnlyCustomers(String(org._id))
    await Invoice.updateOne({ _id: d.note._id }, { $set: { contactId: c.lonely._id } }).exec()
    const result = await applyNameOnlyCustomers(plan)
    expect(result).toMatchObject({ documents: 2, movements: 1 })
    expect(result.failed).toHaveLength(1)
    expect(await contactOf(d.note)).toBe(String(c.lonely._id))
  })
})

describe('undo', () => {
  it('moves back what still names the contact the run gave it, and refuses another org\'s manifest', async () => {
    await world()
    const plan = await planNameOnlyCustomers(String(org._id))
    const manifest = parseManifest(manifestText(manifestOf(plan, SLUG)), String(org._id))
    expect(manifest.twins.map(t => t.documents.length)).toEqual([2, 1])
    await applyNameOnlyCustomers(plan)
    await Invoice.updateOne({ _id: d.alias._id }, { $set: { contactId: c.lonely._id } }).exec()
    expect(await undoNameOnlyCustomers(manifest, false)).toEqual({ documents: 3, back: 2, changed: 1, movements: 1, gone: 0 })
    expect(await contactOf(d.paid)).toBe(String(c.numbered._id))
    expect(await undoNameOnlyCustomers(manifest, true)).toEqual({ documents: 3, back: 2, changed: 1, movements: 1, gone: 0 })
    expect(await contactOf(d.paid)).toBe(String(c.bare._id))
    expect(await contactOf(d.note)).toBe(String(c.bare._id))
    expect(await contactOf(d.alias)).toBe(String(c.lonely._id))
    expect(String(((await StockMovement.findById(movement._id).lean().exec()) as any).contactId)).toBe(String(c.bare._id))
    expect(await AuditLog.countDocuments({ orgId: org._id, via: SCRIPT })).toBe(2)

    const text = manifestText(manifest)
    expect((await captureRejection(Promise.resolve().then(() => parseManifest(text, String(oid()))))).code).toBe('other_org')
    expect((await captureRejection(Promise.resolve().then(() => parseManifest('{"a":1}', String(org._id))))).code).toBe('not_a_manifest')
  })
})

describe('the script', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..')
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'relink-name-only-customers.ts'), ...args], {
      cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out: out + err }
  }

  it('a dry run of counts, --expect, a manifest outside the checkout, and --undo', async () => {
    await world()
    // The script builds no index and refuses to write without the unique ones: the app (here, the test) builds them.
    await Promise.all([Invoice, StockMovement, AuditLog].map(M => M.init()))
    const out = mkdtempSync(join(tmpdir(), 'relink-name-only-customers-test-'))
    try {
      const dry = await cli('--org', SLUG)
      expect(dry.code).toBe(0)
      expect(dry.out).toContain('Re-run with --execute --expect 3.')
      // Counts only: no name and no number.
      for (const private_ of ['ДВОЙНИК', 'ПРЕКОР', '999000191', '3000700301']) expect(dry.out).not.toContain(private_)

      expect((await cli('--org', SLUG, '--execute')).code).toBe(2)
      expect((await cli('--org', SLUG, '--execute', '--expect', '2', '--out', out)).code).toBe(2)
      expect(await contactOf(d.paid)).toBe(String(c.bare._id))

      const run = await cli('--org', SLUG, '--execute', '--expect', '3', '--out', out)
      expect(run.code).toBe(0)
      expect(run.out).toContain('Moved: 3 of 3 documents')
      expect(await contactOf(d.paid)).toBe(String(c.numbered._id))
      const [file] = readdirSync(out)
      expect(file).toMatch(/^relink-name-only-customers-name-only-twins-test-.+\.json$/)
      expect(readFileSync(join(out, file), 'utf8')).toContain(String(d.paid._id))

      expect((await cli('--org', SLUG)).out).toContain('Re-run with --execute --expect 0.')
      const undoDry = await cli('--org', SLUG, '--undo', join(out, file))
      expect(undoDry.code).toBe(0)
      expect(undoDry.out).toContain('to move back')
      expect(await contactOf(d.paid)).toBe(String(c.numbered._id))
      expect((await cli('--org', SLUG, '--undo', join(out, file), '--execute')).code).toBe(0)
      expect(await contactOf(d.paid)).toBe(String(c.bare._id))

      const refused = await cli('--org', `${SLUG}-missing`)
      expect(refused.code).toBe(2)
      expect(refused.out).toContain('Refused (not_found)')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
    expect(existsSync(out)).toBe(false)
  }, 120_000)
})
