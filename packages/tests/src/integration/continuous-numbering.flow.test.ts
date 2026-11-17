import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'

import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { AuditLog, Sequence, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { continuousSuffixOf, getNextInvoiceNumber, peekNextInvoiceNumber } from 'services/biz/invoice-numbering.service'
import { continueSeries } from 'services/biz/move/fenced-import.service'
import { getNextContinuousNumber, highestCounter, isContinuousSeries, setContinuousSeries } from 'services/biz/sequence.service'

/**
 * A sales series numbered WITHOUT a year (`INV-3000004106`): ten digits that go on from one year into the next, in
 * the form a number brought in from another system already has. An org chooses it on the sequences page; every
 * other org keeps a number per year.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const year = new Date().getFullYear()
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

let n = 0
async function world() {
  const org = await createTestOrg({ slug: `cont-num-${++n}` } as any)
  const orgId = String(org._id)
  const contact = await createTestContact(org._id)
  /** A document that already carries this number, as an import or an earlier issue left it. */
  const holds = (invoiceNumber: string, extra: Record<string, unknown> = {}) =>
    createTestInvoice(org._id, contact._id, { invoiceNumber, status: 'sent', ...extra } as any)
  const row = async (prefix: string, y: number) =>
    Number(((await Sequence.findOne({ orgId: org._id, prefix, year: y }).lean()) as any)?.lastNumber ?? 0)
  return { org, orgId, holds, row }
}

describe('a series numbered per year stays as it was', () => {
  it('numbers with the year, five digits, and says it is not continuous', async () => {
    const w = await world()
    expect(await isContinuousSeries(w.orgId, 'SALES_DOC')).toBe(false)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe(`INV-${year}-00001`)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'credit_note')).toBe(`INV-${year}-00002`)
    expect(await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toMatchObject({ next: `INV-${year}-00003`, counter: 2, prefix: 'INV' })
  })

  it('does not read a year-less number as one of its own', async () => {
    const w = await world()
    await w.holds('INV-3000004104')
    // The yearly reading is of ONE year's numbers: a number without a year is not among them.
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe(`INV-${year}-00001`)
  })
})

describe('a continuous series', () => {
  it('starts at one: ten digits, no year, and the notes share it', async () => {
    const w = await world()
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await isContinuousSeries(w.orgId, 'SALES_DOC')).toBe(true)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-0000000001')
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'credit_note')).toBe('INV-0000000002')
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'debit_note')).toBe('INV-0000000003')
    // One row counts, and this year's row says the same: it is where everything that guards a legal series reads.
    expect(await w.row('SALES_DOC', 0)).toBe(3)
    expect(await w.row('SALES_DOC', year)).toBe(3)
  })

  it('goes on above every number of the series, with a year or without', async () => {
    const w = await world()
    await w.holds('INV-3000004104') // brought in from another system
    await w.holds(`INV-${year}-3000004106`) // issued here, per year, before the switch
    await w.holds(`INV-${year - 1}-00007`) // an old year's
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect((await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).next).toBe('INV-3000004107')
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-3000004107')
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-3000004108')
  })

  it('reads only its own prefixes: a cash sale, a draft and a proforma do not move it', async () => {
    const w = await world()
    await w.holds('CS-9000000001', { type: 'cash_sale' })
    await w.holds('CSR-20261114', { type: 'cash_sale' })
    await w.holds('DRF-INV-2026-88888', { status: 'draft' })
    await w.holds('PRF-2026-77777', { type: 'proforma' })
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-0000000001')
  })

  it('what the form shows before issuing is what the issue gives', async () => {
    const w = await world()
    await w.holds('INV-0000000041')
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    const peek = await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')
    expect(peek).toMatchObject({ next: 'INV-0000000042', prefix: 'INV' })
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe(peek.next)
    // And a look never draws a number.
    expect((await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).next).toBe('INV-0000000043')
    expect((await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).next).toBe('INV-0000000043')
  })

  it('goes on into the next year where the last one stopped', async () => {
    const w = await world()
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await getNextContinuousNumber(w.orgId, 'SALES_DOC', 0, 2026)).toBe(1)
    expect(await getNextContinuousNumber(w.orgId, 'SALES_DOC', 0, 2026)).toBe(2)
    // 1 January: the new year goes on where the old one stopped, and its row says so.
    expect(await getNextContinuousNumber(w.orgId, 'SALES_DOC', 0, 2027)).toBe(3)
    expect(await w.row('SALES_DOC', 2026)).toBe(2)
    expect(await w.row('SALES_DOC', 2027)).toBe(3)
    // A server whose clock still says the old year draws the next number, not one of the new year's.
    expect(await getNextContinuousNumber(w.orgId, 'SALES_DOC', 0, 2026)).toBe(4)
    expect(await highestCounter(w.orgId, 'SALES_DOC')).toBe(4)
    // A number recorded on a yearly row (an import, the last numbers after a promotion) is never given again.
    await Sequence.updateOne({ orgId: w.org._id, prefix: 'SALES_DOC', year: 2027 }, { $set: { lastNumber: 90 } })
    expect(await getNextContinuousNumber(w.orgId, 'SALES_DOC', 0, 2027)).toBe(91)
  })

  it('gives no number twice and skips none while two years are counted on at once', async () => {
    const w = await world()
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    // Around midnight on 31 December, or two servers whose clocks disagree about the year.
    const drawn = await Promise.all(Array.from({ length: 60 }, (_, i) => getNextContinuousNumber(w.orgId, 'SALES_DOC', 0, i % 2 ? 2026 : 2027)))
    expect([...drawn].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    // Each year's row ends at the highest number drawn under it, so the two together stand at 60.
    expect(Math.max(await w.row('SALES_DOC', 2026), await w.row('SALES_DOC', 2027))).toBe(60)
    expect(await w.row('SALES_DOC', 0)).toBe(60)
  })

  it('switched back, the series counts per year again, above what it issued', async () => {
    const w = await world()
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-0000000001')
    await setContinuousSeries(w.orgId, 'SALES_DOC', false)
    expect(await isContinuousSeries(w.orgId, 'SALES_DOC')).toBe(false)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe(`INV-${year}-00002`)
  })

  it('the switch leaves the display prefix of the series alone', async () => {
    const w = await world()
    await Sequence.create({ orgId: w.org._id, prefix: 'SALES_DOC', year: 0, lastNumber: 0, displayPrefix: 'FA' } as any)
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('FA-0000000001')
    // A number issued under the default prefix before the rename still counts.
    await w.holds('INV-0000000009')
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('FA-0000000010')
    await setContinuousSeries(w.orgId, 'SALES_DOC', false)
    expect(((await Sequence.findOne({ orgId: w.org._id, prefix: 'SALES_DOC', year: 0 }).lean()) as any).displayPrefix).toBe('FA')
  })

  it('reads the running number a document number carries, or none', async () => {
    const w = await world()
    expect(await continuousSuffixOf(w.orgId, 'SALES_DOC', 'INV-3000004106')).toBe(3000004106)
    expect(await continuousSuffixOf(w.orgId, 'SALES_DOC', `INV-${year}-00042`)).toBe(42)
    expect(await continuousSuffixOf(w.orgId, 'SALES_DOC', 'CRN-0000000005')).toBe(5) // a prefix the series used to render
    for (const other of ['DRF-INV-2026-00001', 'CSR-20261114', 'INV-12A', 'PRF-2026-00001', '', null]) {
      expect(await continuousSuffixOf(w.orgId, 'SALES_DOC', other)).toBeNull()
    }
  })

  it('reads the highest number of a long history, in both forms', async () => {
    const w = await world()
    // Counted in the database, whatever the number of documents: more than one batch of a cursor here.
    const held = Array.from({ length: 260 }, (_, i) => i % 2 ? `INV-${String(3000000000 + i).padStart(10, '0')}` : `INV-${year}-${String(i + 1).padStart(5, '0')}`)
    for (const number of held) await w.holds(number)
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    expect((await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).next).toBe('INV-3000000260')
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-3000000260')
  })
})

describe('a kept document of a replaced server', () => {
  const sale = (invoiceNumber: string, extra: Record<string, unknown> = {}) =>
    ({ invoiceNumber, status: 'sent', type: 'invoice', direction: 'outgoing', ...extra })

  it('raises a continuous series above its year-less number', async () => {
    const w = await world()
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    await continueSeries(w.orgId, sale('INV-0000000777'))
    expect(await w.row('SALES_DOC', year)).toBe(777)
    expect(await getNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toBe('INV-0000000778')
  })

  it('still counts a yearly number on its own year, and never a number that is none of the series', async () => {
    const w = await world()
    await setContinuousSeries(w.orgId, 'SALES_DOC', true)
    await continueSeries(w.orgId, sale('INV-2025-00042'))
    expect(await w.row('SALES_DOC', 2025)).toBe(42)
    // A till day's document ends in digits too, and is no number of any series.
    await continueSeries(w.orgId, sale('CSR-20261114', { type: 'cash_sale' }))
    expect(await w.row('CASH_SALE', year)).toBe(0)
    expect(await highestCounter(w.orgId, 'CASH_SALE')).toBe(0)
  })

  it('leaves a year-less number alone where the org numbers per year', async () => {
    const w = await world()
    await continueSeries(w.orgId, sale('INV-0000000777'))
    expect(await w.row('SALES_DOC', year)).toBe(0)
  })
})

describe('the sequences page', () => {
  async function signedIn(role: string) {
    const w = await world()
    const person = await createTestUser(w.org._id, { role, username: role, email: `${role}@${w.org.slug}.test` } as any)
    const token = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(person._id).exec())!))
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.handle(new Request(`http://localhost/api/org/${w.orgId}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }))
      let json: any = null
      try { json = await res.json() } catch { /* not json */ }
      return { status: res.status, json }
    }
    const rowOf = async (prefix: string) => (await call('GET', '/invoicing/sequences')).json.sequences.find((s: any) => s.prefix === prefix)
    return { ...w, person, call, rowOf }
  }
  /** The audit entry is written beside the answer, not before it. */
  async function auditOf(orgId: string, field: string) {
    for (let i = 0; i < 40; i++) {
      const rows: any[] = await AuditLog.find({ orgId, entityType: 'sequence' }).lean()
      const hit = rows.find(r => (r.changes || []).some((c: any) => c.field === field))
      if (hit) return hit
      await new Promise(r => setTimeout(r, 50))
    }
    return null
  }

  it('offers the option on the sales documents only, off until chosen', async () => {
    const s = await signedIn('admin')
    const { json } = await s.call('GET', '/invoicing/sequences')
    expect(json.sequences.filter((r: any) => r.mayBeContinuous).map((r: any) => r.prefix)).toEqual(['SALES_DOC'])
    expect(json.sequences.every((r: any) => r.continuous === false)).toBe(true)
    expect(await s.rowOf('SALES_DOC')).toMatchObject({ continuous: false, padLength: 5, lastNumber: 0 })
  })

  it('switches a sales series on and off, shows where it stands, and records who did it', async () => {
    const s = await signedIn('admin')
    await Sequence.create({ orgId: s.org._id, prefix: 'SALES_DOC', year: year - 1, lastNumber: 3000004104 } as any)
    const on = await s.call('PUT', '/invoicing/sequences/SALES_DOC', { continuous: true })
    expect([on.status, on.json]).toEqual([200, { prefix: 'SALES_DOC', displayPrefix: null, continuous: true }])
    // Where it stands is the highest of its yearly rows, whatever the year, in ten digits.
    expect(await s.rowOf('SALES_DOC')).toMatchObject({ continuous: true, padLength: 10, lastNumber: 3000004104 })
    expect(await getNextInvoiceNumber(s.orgId, 'outgoing', 'invoice')).toBe('INV-3000004105')

    const entry = await auditOf(s.orgId, 'continuous')
    expect(entry).toMatchObject({ action: 'update', module: 'invoicing', entityId: 'SALES_DOC' })
    expect(String(entry.userId)).toBe(String(s.person._id))
    expect(entry.changes.find((c: any) => c.field === 'continuous')).toMatchObject({ oldValue: false, newValue: true })

    const off = await s.call('PUT', '/invoicing/sequences/SALES_DOC', { continuous: false })
    expect([off.status, off.json.continuous]).toEqual([200, false])
    expect(await s.rowOf('SALES_DOC')).toMatchObject({ continuous: false, padLength: 5 })
  })

  it('changes only the setting a request names', async () => {
    const s = await signedIn('admin')
    expect((await s.call('PUT', '/invoicing/sequences/SALES_DOC', { displayPrefix: 'FA' })).json).toEqual({ prefix: 'SALES_DOC', displayPrefix: 'FA', continuous: false })
    expect((await s.call('PUT', '/invoicing/sequences/SALES_DOC', { continuous: true })).json).toEqual({ prefix: 'SALES_DOC', displayPrefix: 'FA', continuous: true })
    // A new prefix leaves the numbering as it is, and the other way round.
    expect((await s.call('PUT', '/invoicing/sequences/SALES_DOC', { displayPrefix: 'FB' })).json).toEqual({ prefix: 'SALES_DOC', displayPrefix: 'FB', continuous: true })
    expect(await s.rowOf('SALES_DOC')).toMatchObject({ displayPrefix: 'FB', continuous: true })
    expect((await s.call('PUT', '/invoicing/sequences/SALES_DOC', { displayPrefix: null })).json).toEqual({ prefix: 'SALES_DOC', displayPrefix: null, continuous: true })
    expect(await isContinuousSeries(s.orgId, 'SALES_DOC')).toBe(true)
  })

  it('refuses the option on a series that is numbered per year', async () => {
    const s = await signedIn('admin')
    for (const prefix of ['CASH_SALE', 'PROFORMA', 'BILL']) {
      const res = await s.call('PUT', `/invoicing/sequences/${prefix}`, { continuous: true })
      expect([prefix, res.status, res.json?.code]).toEqual([prefix, 422, 'not_continuous_series'])
      expect(await isContinuousSeries(s.orgId, prefix)).toBe(false)
    }
    // Saying "per year" of a series that is per year changes nothing and is no error.
    expect((await s.call('PUT', '/invoicing/sequences/CASH_SALE', { continuous: false })).status).toBe(200)
    // A request naming both settings is refused whole: the prefix it also named is not changed.
    const both = await s.call('PUT', '/invoicing/sequences/CASH_SALE', { displayPrefix: 'KB', continuous: true })
    expect([both.status, both.json?.code]).toEqual([422, 'not_continuous_series'])
    expect((await s.rowOf('CASH_SALE')).displayPrefix).toBe('CS')
  })

  it('is not for a role that may not configure numbering', async () => {
    const s = await signedIn('member')
    const res = await s.call('PUT', '/invoicing/sequences/SALES_DOC', { continuous: true })
    expect(res.status).toBe(403)
    expect(await isContinuousSeries(s.orgId, 'SALES_DOC')).toBe(false)
  })
})
