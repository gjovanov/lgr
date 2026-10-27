import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestFiscalDevice, createTestOrg } from '../helpers/factories'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { numberingController } from '../../../portal-api/src/controllers/numbering.controller'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { AuditLog, Invoice, OrgHome } from 'db/models'

/**
 * The fiscal device as a witness to the legal series (FR-20.51, AC 49): while legal numbering waits
 * for the last numbers issued at the site, each active device of the org is asked for its last
 * document, beside the last fiscal receipt this database recorded on it. Evidence for the person:
 * shown, and kept in the audit with their reading, never a lock or a floor by itself.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const extra: string[] = []

beforeAll(async () => {
  await setupTestDB()
  app = tillApp().use(numberingController) as unknown as Elysia
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  forgetDevices()
  for (const id of extra.splice(0)) unregisterPrinter(id)
  await clearCollections()
}, 30_000)

/** Legal numbering waits here, as after a restore. */
const freeze = (w: TillWorld) => OrgHome.create({ orgId: w.oid, home: 'global', seriesFrozen: { since: new Date(), reason: 'restored' } })
const evidence = async (w: TillWorld) => {
  const r = await w.call('GET', '/numbering/last-numbers')
  expect(r.status).toBe(200)
  return r.json
}

/** A device of the org, connected here through `printer` (or not at all). */
async function device(w: TillWorld, deviceNumber: string, printer?: object, extraFields: Record<string, unknown> = {}) {
  const d = await createTestFiscalDevice(w.oid, w.warehouse._id, { name: deviceNumber, deviceNumber, manufacturer: 'tremol', connectionType: 'browser', status: 'online', ...extraFields } as any)
  if (printer) {
    registerPrinter(String(d._id), printer as any)
    extra.push(String(d._id))
  }
  return d
}

describe('the fiscal device as a witness (FR-20.51, AC 49)', () => {
  it('while numbering waits, a device\'s last document is shown beside the last receipt this database recorded on it', async () => {
    const w = await tillWorld(app)
    expect((await w.sell(1)).status).toBe(200)
    expect((await w.sell(1)).status).toBe(200)
    // Another org's receipt on a device of the same number is not this org's evidence.
    const other = await createTestOrg()
    await Invoice.collection.insertOne({
      orgId: other._id, type: 'cash_sale', direction: 'outgoing', invoiceNumber: 'CS-OTHER-1',
      register: { fiscalDeviceNumber: 'ED123456', fiscalReceiptNumber: '0000999', printedAt: new Date(Date.now() + 60_000) },
    } as any)

    // Numbering open: nothing is asked of the device.
    const quiet = w.sim!.frames
    const open = await evidence(w)
    expect(open.frozen).toBe(false)
    expect(open.devices).toEqual([])
    expect(w.sim!.frames).toBe(quiet)

    await freeze(w)
    let [d] = (await evidence(w)).devices
    expect(d).toMatchObject({ deviceNumber: 'ED123456', reading: { state: 'read', lastDocument: 102 }, recorded: { receiptNo: '0000102' }, since: 0 })
    expect(d.recorded.unp).toMatch(/^ED123456-0001-\d{7}$/)
    expect(d.recorded.number).toMatch(/\d/)

    // The device printed what this database did not record: a report, a text receipt. It says so.
    w.sim!.lastDocNumber += 2
    ;[d] = (await evidence(w)).devices
    expect(d).toMatchObject({ reading: { lastDocument: 104 }, recorded: { receiptNo: '0000102' }, since: 2 })

    // The database went back past its last receipt: the device is a further step ahead of it.
    await Invoice.deleteOne({ orgId: w.oid, 'register.fiscalReceiptNumber': '0000102' })
    ;[d] = (await evidence(w)).devices
    expect(d).toMatchObject({ recorded: { receiptNo: '0000101' }, since: 3 })
  })

  it('a device that cannot say, one not connected here, one that fails and one that does not answer: each says so', async () => {
    const w = await tillWorld(app)
    await device(w, 'TR000001', { getStatus: async () => ({ connected: true }) })
    await device(w, 'DT000002')
    await device(w, 'ED000003', { getLastReceiptNumber: async () => { throw new Error('paper out') } })
    await device(w, 'ED000004', { getLastReceiptNumber: () => new Promise(() => {}) })
    await device(w, 'ED000005', { getLastReceiptNumber: async () => 7 }, { isActive: false, deactivatedAt: new Date() })
    await freeze(w)

    const t0 = Date.now()
    const byNumber = Object.fromEntries((await evidence(w)).devices.map((d: any) => [d.deviceNumber, d]))
    expect(Date.now() - t0).toBeLessThan(9_000)
    expect(Object.keys(byNumber).sort()).toEqual(['DT000002', 'ED000003', 'ED000004', 'ED123456', 'TR000001'])
    expect(byNumber.TR000001).toMatchObject({ reading: { state: 'unsupported' }, recorded: null, since: null })
    expect(byNumber.DT000002).toMatchObject({ reading: { state: 'not_connected' }, since: null })
    expect(byNumber.ED000003).toMatchObject({ reading: { state: 'error', error: 'paper out' }, since: null })
    expect(byNumber.ED000004.reading.state).toBe('error')
    expect(byNumber.ED000004.reading.error).toContain('no answer')
    // Nothing printed on the till's own device yet: what it says stands alone.
    expect(byNumber.ED123456).toMatchObject({ reading: { state: 'read', lastDocument: 100 }, recorded: null, since: null })
  }, 20_000)

  it('recording the last numbers keeps what the devices said in its audit entry, and opens numbering', async () => {
    const w = await tillWorld(app)
    expect((await w.sell(1)).status).toBe(200)
    await freeze(w)
    w.sim!.lastDocNumber += 1
    const { series } = await evidence(w)

    const saved = await w.call('POST', '/numbering/last-numbers', { series: series.map((s: any) => ({ prefix: s.prefix, year: s.year, last: s.last })) })
    expect(saved.status).toBe(200)
    expect(((await OrgHome.findOne({ orgId: w.oid }).lean()) as any).seriesFrozen).toBeUndefined()

    const audit: any = await AuditLog.findOne({ orgId: w.oid, entityType: 'sequence' }).lean()
    expect(audit.changes.find((c: any) => c.field === 'fiscal device ED123456: last document')).toMatchObject({ oldValue: '0000101', newValue: 102 })
    // The person's numbers are there as before.
    expect(audit.changes.some((c: any) => /^UNP-ED123456 /.test(c.field))).toBe(true)

    // Open again: the device is not asked.
    expect((await evidence(w)).devices).toEqual([])
  })
})
