import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from 'mongodb'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { Invoice, INVOICE_NUMBER_SEQ_KEY } from 'db/models'
import { withNumberParts } from 'db/plugins/invoice-number-parts'
import { getRepos } from 'services/context'
import { currentMaxSuffix, getNextInvoiceNumber, peekNextInvoiceNumber } from 'services/biz/invoice-numbering.service'
import { setContinuousSeries, setDisplayPrefix } from 'services/biz/sequence.service'
import { collectionDigests, importMoveBundle, writeMoveBundle } from 'services/biz/move/move-bundle'
import { invoiceNumberParts } from 'migrations/migrations/0024-invoice-number-parts'

/**
 * #929: the next number of a series is read from each invoice's stored running number (`numberHead` / `numberSeq`),
 * a few index keys, never a scan of the org's numbers. Every writer stores it; an org whose documents do not carry it
 * yet (production deploys the code before migration 0024 runs) still gets the scan's answer, from those documents.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const year = new Date().getFullYear()
const scratch = mkdtempSync(join(tmpdir(), 'lgr-929-'))
const db = () => mongoose.connection.db as unknown as Db

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => {
  await teardownTestDB()
  rmSync(scratch, { recursive: true, force: true })
}, 60_000)
afterEach(async () => {
  await db().command({ profile: 0 })
  await db().collection('system.profile').drop().catch(() => {})
  await clearCollections()
}, 30_000)

let n = 0
async function world() {
  const org = await createTestOrg({ slug: `parts-929-${++n}` } as any)
  const orgId = String(org._id)
  const contact = await createTestContact(org._id)
  const base = (invoiceNumber: string, extra: Record<string, unknown> = {}) => ({
    orgId: org._id, invoiceNumber, type: 'invoice', direction: 'outgoing', status: 'sent', contactId: contact._id,
    issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, lines: [], ...extra,
  })
  /** As a writer of this release leaves it: through the model, its hooks storing the parts. */
  const holds = (invoiceNumber: string, extra: Record<string, unknown> = {}) =>
    createTestInvoice(org._id, contact._id, { invoiceNumber, status: 'sent', ...extra } as any)
  /** As a document from before #929 is: written raw, no parts. */
  const old = async (...numbers: string[]) => { await Invoice.collection.insertMany(numbers.map(x => base(x)) as any[]) }
  const raw = async (number: string) => Invoice.collection.findOne({ orgId: org._id, invoiceNumber: number } as any) as Promise<any>
  return { org, orgId, contact, base, holds, old, raw }
}

/** What MongoDB's profiler saw of `run`, on the invoices. */
async function profiled(run: () => Promise<unknown>): Promise<any[]> {
  await db().command({ profile: 0 })
  await db().collection('system.profile').drop().catch(() => {})
  await db().createCollection('system.profile', { capped: true, size: 16 * 1024 * 1024 })
  await db().command({ profile: 2, slowms: 0 })
  try {
    await run()
  } finally {
    await db().command({ profile: 0 })
  }
  const ops = await db().collection('system.profile').find({ ns: /\.invoices$/ }).toArray()
  await db().collection('system.profile').drop().catch(() => {})
  return ops
}
const keysOf = (ops: any[]) => ops.reduce((s, op) => s + (op.keysExamined ?? 0), 0)
const docsOf = (ops: any[]) => ops.reduce((s, op) => s + (op.docsExamined ?? 0), 0)
const scans = (ops: any[]) => ops.filter(op => op.command?.aggregate)

describe('every write stores the running number', () => {
  it('a create, a save, an insertMany, the update queries and the repository keep it with the number', async () => {
    const w = await world()
    const a: any = await w.holds(`DRF-INV-${year}-00007`)
    expect(await w.raw(`DRF-INV-${year}-00007`)).toMatchObject({ numberHead: `DRF-INV-${year}`, numberSeq: 7 })

    // Issued (Q1 goes through the repository's updateInOrg): the draft's parts go with its number.
    await getRepos().invoices.updateInOrg(String(a._id), w.orgId, { invoiceNumber: `INV-${year}-00031`, draftNumber: `DRF-INV-${year}-00007` } as any)
    expect(await w.raw(`INV-${year}-00031`)).toMatchObject({ numberHead: `INV-${year}`, numberSeq: 31 })

    await Invoice.findOneAndUpdate({ _id: a._id }, { $set: { invoiceNumber: 'INV-0000000040' } })
    expect(await w.raw('INV-0000000040')).toMatchObject({ numberHead: 'INV', numberSeq: 40 })
    await Invoice.updateOne({ _id: a._id }, { invoiceNumber: '~pending:k1' })
    expect(await w.raw('~pending:k1')).toMatchObject({ numberHead: '', numberSeq: null })
    await Invoice.findByIdAndUpdate(a._id, { $set: { invoiceNumber: `CS-${year}-0000002` } })
    expect(await w.raw(`CS-${year}-0000002`)).toMatchObject({ numberHead: `CS-${year}`, numberSeq: 2 })

    const doc: any = await Invoice.findById(a._id)
    doc.invoiceNumber = `INV-${year}-00032`
    await doc.save()
    expect(await w.raw(`INV-${year}-00032`)).toMatchObject({ numberHead: `INV-${year}`, numberSeq: 32 })

    await Invoice.insertMany([w.base(`BILL-${year}-00005`, { direction: 'incoming', createdBy: w.org._id })])
    expect(await w.raw(`BILL-${year}-00005`)).toMatchObject({ numberHead: `BILL-${year}`, numberSeq: 5 })
  })

  it('a value a client sends for the parts never lands', async () => {
    const w = await world()
    const a: any = await w.holds(`INV-${year}-00003`, { numberHead: 'INV', numberSeq: 9_999_999 } as any)
    expect(await w.raw(`INV-${year}-00003`)).toMatchObject({ numberHead: `INV-${year}`, numberSeq: 3 })
    // A PUT stores its body in a $set: a part in it is dropped.
    await getRepos().invoices.updateInOrg(String(a._id), w.orgId, { notes: 'edited', numberSeq: 9_999_999, numberHead: `INV-${year}` } as any)
    expect(await w.raw(`INV-${year}-00003`)).toMatchObject({ notes: 'edited', numberHead: `INV-${year}`, numberSeq: 3 })
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe(`INV-${year}-00004`)
  })
})

describe('the same numbers as the scan', () => {
  it('a continuous series goes on above its yearly numbers and its own, whatever their width', async () => {
    const w = await world()
    await w.holds(`INV-${year}-0000123`) // yearly, padded to seven
    await w.holds('INV-0000000124') // continuous, ten digits
    await w.holds(`INV-${year - 1}-00099`)
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year, { everyYear: true })).toBe(124)
    expect((await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).next).toBe('INV-0000000125')
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-0000000125')
  })

  it('and above a yearly number wider than any continuous one', async () => {
    const w = await world()
    await w.holds(`INV-${year - 1}-0000200`)
    await w.holds('INV-0000000124')
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-0000000201')
  })

  it('a yearly series reads this year only, by value not by text, its legacy prefixes and a renamed one too', async () => {
    const w = await world()
    await w.holds(`INV-${year}-00999`)
    await w.holds(`INV-${year}-1000`) // sorts before 00999 as text
    await w.holds(`INV-${year - 1}-0005000`) // another year
    await w.holds('INV-0000009000') // no year: not of a yearly series
    await w.holds(`DRF-INV-${year}-07777`) // a draft
    await w.holds(`CS-${year}-0008000`, { type: 'cash_sale' }) // another series
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year)).toBe(1000)
    await w.holds(`CRN-${year}-01200`, { type: 'credit_note' }) // the notes' prefix before the FR-01 merge
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year)).toBe(1200)
    // A prefix renamed AFTER the documents were written: the old numbers still count, read at the time of asking.
    await setDisplayPrefix(w.orgId, 'SALES_DOC', 'FAK')
    await w.holds(`FAK-${year}-01300`)
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year)).toBe(1300)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe(`FAK-${year}-01301`)
  })
})

describe('an org whose documents do not carry the parts yet (before migration 0024)', () => {
  it('gets the scan\'s answer from them, partly written or not at all, and the migration changes nothing in it', async () => {
    const w = await world()
    await w.old(`INV-${year}-00500`, 'INV-0000000777', `CS-${year}-0000010`, '~pending:abc', '0001234')
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year)).toBe(500)
    // A newer document with parts, below the old one: the old one still wins.
    await w.holds(`INV-${year}-00400`)
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year)).toBe(500)
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year, { everyYear: true })).toBe(777)
    expect(scans(await profiled(() => currentMaxSuffix(w.orgId, 'SALES_DOC', year, { everyYear: true })))).toHaveLength(1)

    // The dry run counts, per org, and writes nothing.
    const preview = await invoiceNumberParts.preview!({ db: db(), log: () => {}, orgFilter: {} })
    expect(preview).toEqual([`${w.orgId}: 6 invoice(s); 1 already set, 5 to set (5 missing, 0 stale); 2 with no running number`])
    expect(await w.raw(`INV-${year}-00500`)).not.toHaveProperty('numberHead')

    const logs: string[] = []
    await invoiceNumberParts.up({ db: db(), log: m => logs.push(m), orgFilter: {} })
    expect(logs[logs.length - 1]).toBe('invoices given their running number: 5 of 5; left without one: 0 (the numbering reads those by their numbers)')
    expect(await w.raw('0001234')).toMatchObject({ numberHead: '', numberSeq: null })
    expect(await w.raw('INV-0000000777')).toMatchObject({ numberHead: 'INV', numberSeq: 777 })
    expect((await db().collection('invoices').indexes()).some((i: any) => i.name === INVOICE_NUMBER_SEQ_KEY)).toBe(true)
    // The same answer, and no scan any more.
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year, { everyYear: true })).toBe(777)
    expect(scans(await profiled(() => currentMaxSuffix(w.orgId, 'SALES_DOC', year, { everyYear: true })))).toHaveLength(0)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-0000000778')

    // Again: nothing to set.
    expect(await invoiceNumberParts.preview!({ db: db(), log: () => {}, orgFilter: {} }))
      .toEqual([`${w.orgId}: 6 invoice(s); 6 already set, 0 to set (0 missing, 0 stale); 2 with no running number`])
  })

  it('the migration puts right a value that does not match its number', async () => {
    const w = await world()
    await Invoice.collection.insertOne(w.base(`INV-${year}-00600`, { numberHead: `DRF-INV-${year}`, numberSeq: 3 }) as any)
    const logs: string[] = []
    await invoiceNumberParts.up({ db: db(), log: m => logs.push(m), orgFilter: {} })
    expect(logs[0]).toBe(`${w.orgId}: 1 invoice(s); 0 already set, 1 to set (0 missing, 1 stale); 0 with no running number`)
    expect(await w.raw(`INV-${year}-00600`)).toMatchObject({ numberHead: `INV-${year}`, numberSeq: 600 })
    expect(await currentMaxSuffix(w.orgId, 'SALES_DOC', year)).toBe(600)
  })
})

describe('the cost does not grow with the org (#929, #785)', () => {
  /** An org with `count` documents over the same heads: this year's sales, a continuous run, the till, drafts. */
  async function orgOf(count: number) {
    const w = await world()
    const docs = Array.from({ length: count }, (_, i) => {
      const k = i % 4
      const number = k === 0 ? `INV-${year}-${String(i + 1).padStart(5, '0')}`
        : k === 1 ? `INV-${String(i + 1).padStart(10, '0')}`
          : k === 2 ? `CS-${year}-${String(i + 1).padStart(7, '0')}`
            : `DRF-INV-${year}-${String(i + 1).padStart(5, '0')}`
      return withNumberParts(w.base(number, k === 2 ? { type: 'cash_sale' } : {}))
    })
    for (let i = 0; i < docs.length; i += 1000) await Invoice.collection.insertMany(docs.slice(i, i + 1000) as any[])
    await Invoice.createIndexes()
    return w
  }

  async function cost(count: number, continuous: boolean) {
    const w = await orgOf(count)
    if (continuous) await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    const ops = await profiled(async () => {
      await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')
      await getNextInvoiceNumber(w.orgId, 'outgoing', 'cash_sale')
      await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')
    })
    return { ops, keys: keysOf(ops), docs: docsOf(ops) }
  }

  for (const continuous of [false, true]) {
    it(`${continuous ? 'a continuous' : 'a yearly'} series: the same keys at 200 and at 4 000 invoices`, async () => {
      const small = await cost(200, continuous)
      await clearCollections()
      const big = await cost(4000, continuous)
      expect(big.ops.length).toBeGreaterThan(0)
      expect(scans(big.ops)).toHaveLength(0)
      // A key or two per head and per question, never one per invoice.
      for (const op of big.ops) {
        expect(op.keysExamined ?? 0).toBeLessThanOrEqual(12)
        expect(op.docsExamined ?? 0).toBeLessThanOrEqual(2)
        // #785: the INV query used to be re-planned on every issue, its trial reading the org's keys each time.
        expect(op.replanned ?? false).toBe(false)
      }
      expect(big.keys).toBeLessThanOrEqual(small.keys + 2)
      expect(big.docs).toBeLessThanOrEqual(small.docs + 2)
      expect(big.keys).toBeLessThan(60)
      // Read through the index the parts are kept for.
      expect(big.ops.filter(op => String(op.planSummary ?? '').includes('numberHead')).length).toBeGreaterThan(0)
    })
  }
})

describe('a move carries no part: the importer derives its own', () => {
  it('a bundle from documents with and without parts imports with parts, and both sides\' digests agree', async () => {
    const w = await world()
    await w.holds(`INV-${year}-00011`)
    await w.old(`INV-${year}-00012`)
    await Invoice.collection.insertOne(w.base(`INV-${year}-00013`, { numberHead: 'stale', numberSeq: 1 }) as any)
    const path = join(scratch, `bundle-${n}.ndjson.zst`)
    const b = await writeMoveBundle(db(), w.org._id as any, path)
    expect(b.digests).toEqual(await collectionDigests(db(), w.org._id as any))
    const target = mongoose.connection.getClient().db(`${db().databaseName}-929-${n}`)
    try {
      const got = await importMoveBundle(target as any, w.org._id as any, path)
      expect(got.digests).toEqual(b.digests)
      const there = await target.collection('invoices').find({ orgId: w.org._id }, { sort: { invoiceNumber: 1 } }).toArray()
      expect(there.map(d => [d.invoiceNumber, d.numberHead, d.numberSeq])).toEqual([
        [`INV-${year}-00011`, `INV-${year}`, 11], [`INV-${year}-00012`, `INV-${year}`, 12], [`INV-${year}-00013`, `INV-${year}`, 13],
      ])
    } finally {
      await target.dropDatabase().catch(() => {})
    }
  })
})
