import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse, createTestUser, createTestPOSSession } from '../helpers/factories'
import { forgetDevices, tillApp, tillWorld, type TillWorld } from '../helpers/till-world'
import { gate, until } from '../helpers/receipt-world'
import { CLOSE_LEASE_MS, expectedTotals, buildClosingBreakdown } from 'invoicing-api/src/controllers/pos.controller'
import { getPrinter } from 'fiscal/fiscal-device.service'
import { AuditLog, FiscalDevice, Org, POSSession } from 'db/models'
import type { Elysia } from 'elysia'
import type { Types } from 'mongoose'

/**
 * FR-09 (#18) — „Каса и приключване".
 *
 * The endpoint itself needs a live fiscal device to exercise end to end, so these tests pin
 * the pure arithmetic the close screen and the persisted breakdown are built from, plus the
 * concurrency guard that stops two tills from each firing their own Z-report.
 *
 * NOTE: no `.rejects` / `.resolves` anywhere — they deadlock under Bun on Windows after
 * MongoDB I/O (see CLAUDE.md Known Issues). try/catch capture instead.
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { forgetDevices(); await clearCollections() })

describe('expectedTotals (FR-9.3)', () => {
  it('adds the opening float to cash but not to card', () => {
    expect(expectedTotals({ openingBalance: 500, totalCash: 120.5, totalCard: 80, totalOther: 0 }))
      .toEqual({ cash: 620.5, card: 80, other: 0, cashOnDelivery: 0 })
  })

  it('treats a session predating totalOther as zero', () => {
    // Sessions created before FR-9.2 have no `totalOther` at all.
    expect(expectedTotals({ openingBalance: 100, totalCash: 0, totalCard: 0 }))
      .toEqual({ cash: 100, card: 0, other: 0, cashOnDelivery: 0 })
  })

  it('rounds to cents rather than carrying float noise', () => {
    expect(expectedTotals({ openingBalance: 0.1, totalCash: 0.2, totalCard: 0, totalOther: 0 }).cash).toBe(0.3)
  })
})

describe('buildClosingBreakdown (FR-9.1)', () => {
  it('produces one line per method with the signed difference', () => {
    const out = buildClosingBreakdown({ cash: 620.5, card: 80, other: 0 }, { cash: 615, card: 80 })
    expect(out).toEqual([
      { method: 'cash', expected: 620.5, counted: 615, difference: -5.5 },
      { method: 'card', expected: 80, counted: 80, difference: 0 },
      { method: 'other', expected: 0, counted: 0, difference: 0 },
    ])
  })

  it('treats an omitted method as counted zero, not as "matches expected"', () => {
    // A blank card field means "I counted nothing", which is a real shortage.
    const out = buildClosingBreakdown({ cash: 100, card: 50, other: 0 }, { cash: 100 })
    expect(out.find(l => l.method === 'card')).toEqual({ method: 'card', expected: 50, counted: 0, difference: -50 })
  })

  it('keeps the cash line first so the legacy fields map from it', () => {
    // closingBalance/expectedBalance/difference stay cash-only for the JE handler.
    expect(buildClosingBreakdown({ cash: 1, card: 2, other: 3 }, {})[0].method).toBe('cash')
  })
})

describe('close concurrency guard (FR-9.4)', () => {
  async function openSession() {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, {
      openingBalance: 500, totalCash: 120, totalCard: 80,
    })
    return { orgId, session }
  }

  it('lets exactly one of two concurrent claims through', async () => {
    const { orgId, session } = await openSession()
    const claim = () =>
      POSSession.findOneAndUpdate(
        { _id: session._id, orgId, status: 'open' },
        { $set: { status: 'closing_control' } },
        { new: true },
      ).exec()

    const [a, b] = await Promise.all([claim(), claim()])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('leaves the session claimable again after a release', async () => {
    const { orgId, session } = await openSession()
    await POSSession.findOneAndUpdate({ _id: session._id, orgId, status: 'open' }, { $set: { status: 'closing_control' } }).exec()
    // A fiscal failure puts it back to `open` so the operator can retry.
    await POSSession.updateOne({ _id: session._id, orgId }, { $set: { status: 'open', fiscalStatus: 'failed', fiscalError: 'not connected' } }).exec()

    const again = await POSSession.findOneAndUpdate(
      { _id: session._id, orgId, status: 'open' },
      { $set: { status: 'closing_control' } },
      { new: true },
    ).exec()
    expect(again).toBeTruthy()
    expect((again as any).fiscalStatus).toBe('failed')
  })

  it('will not claim an already-closed session', async () => {
    const { orgId, session } = await openSession()
    await POSSession.updateOne({ _id: session._id, orgId }, { $set: { status: 'closed' } }).exec()
    const claimed = await POSSession.findOneAndUpdate(
      { _id: session._id, orgId, status: 'open' },
      { $set: { status: 'closing_control' } },
    ).exec()
    expect(claimed).toBeNull()
  })
})

describe('a close that dies in its Z (the third read of FR-23, finding 6)', () => {
  const Z = 0x45
  const close = (w: TillWorld, body: Record<string, unknown>, key?: string, as?: string) => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, body, key, as)
  const session = (w: TillWorld): Promise<any> => POSSession.findById(w.sessionId).lean().exec()
  /** The state it leaves: claimed, its Z asked for, and nobody coming back. */
  const died = (w: TillWorld, set: Record<string, unknown> = {}) => POSSession.updateOne({ _id: w.sessionId }, {
    $set: { status: 'closing_control', closeLeaseUntil: new Date(Date.now() - 1000), closeClientKey: 'close-died-0001', closeRequestHash: 'x', ...set },
  }).exec()

  it('the claim holds a lease long enough for the device\'s turn and the Z, and a close that ends lets go of it', async () => {
    const w = await tillWorld(app)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === Z ? held.closed : undefined)
    const closing = close(w, { counted: { cash: 100 } })
    await until(async () => (await session(w)).status === 'closing_control', 'the claim')

    const lease = new Date((await session(w)).closeLeaseUntil).getTime()
    expect(lease - Date.now()).toBeGreaterThan(CLOSE_LEASE_MS - 60_000)
    expect(CLOSE_LEASE_MS).toBeGreaterThanOrEqual(330_000 + 300_000)

    // A live claim answers as it always did.
    const second = await close(w, { counted: { cash: 100 } })
    expect(second.status).toBe(400)
    expect(second.json.message).toContain('already being closed')
    expect((await session(w)).status).toBe('closing_control')

    w.sim!.beforeCommand = null
    held.open()
    expect((await closing).status).toBe(200)
    const closed = await session(w)
    expect(closed.status).toBe('closed')
    expect(closed.closeLeaseUntil).toBeUndefined()
  })

  it('a failed Z lets go of it too', async () => {
    const w = await tillWorld(app)
    w.sim!.paper = false

    expect((await close(w, { counted: { cash: 100 } })).status).toBe(503)

    const s = await session(w)
    expect(s.status).toBe('open')
    expect(s.closeLeaseUntil).toBeUndefined()
  })

  it('lapsed: the next close puts it back, says what to do, prints nothing; and closing again prints the Z', async () => {
    const w = await tillWorld(app)
    await died(w)

    const r = await close(w, { counted: { cash: 100 } })

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('close_interrupted')
    expect(r.json.message).toContain('Check the device')
    expect(r.json.message).toContain('close without a fiscal report')
    expect(w.sim!.reports).toHaveLength(0)
    const s = await session(w)
    expect(s).toMatchObject({ status: 'open', fiscalStatus: 'failed' })
    expect(s.fiscalError).toContain('may have printed')
    expect(s.closeClientKey).toBeUndefined()
    expect(s.closeLeaseUntil).toBeUndefined()
    // Written in the background (`createAuditEntry`), so it may land just after the answer.
    await until(async () => (await AuditLog.countDocuments({ orgId: w.oid, action: 'close_interrupted' })) === 1, 'the audit entry')

    const again = await close(w, { counted: { cash: 100 } })
    expect(again.status).toBe(200)
    expect(again.json.fiscalStatus).toBe('closed')
    expect(w.sim!.reports).toHaveLength(1)
    const closed = await session(w)
    expect(closed.status).toBe('closed')
    expect(closed.fiscalError).toBeUndefined()
  })

  it('its Z did print: a manager closes without a fiscal report, and a cashier cannot', async () => {
    const w = await tillWorld(app, { role: 'sales' })
    await died(w)
    expect((await close(w, { counted: { cash: 100 } })).json.code).toBe('close_interrupted')

    const cashier = await close(w, { counted: { cash: 100 }, closeWithoutFiscal: true })
    expect(cashier.status).toBe(403)
    expect((await session(w)).status).toBe('open')

    const manager = await close(w, { counted: { cash: 100 }, closeWithoutFiscal: true }, undefined, await w.tokenAs('manager'))
    expect(manager.status).toBe(200)
    expect(manager.json.fiscalStatus).toBe('skipped')
    expect(w.sim!.reports).toHaveLength(0)
  })

  it('a retry under the dead close\'s key is told at once, and never waits for it', async () => {
    const w = await tillWorld(app)
    await died(w)
    const started = Date.now()

    const r = await close(w, { counted: { cash: 100 } }, 'close-died-0001')

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('close_interrupted')
    expect(Date.now() - started).toBeLessThan(5_000)

    // The key is cleared, so the same key is a new close now.
    const again = await close(w, { counted: { cash: 100 } }, 'close-died-0001')
    expect(again.status).toBe(200)
    expect(w.sim!.reports).toHaveLength(1)
  })

  it('no lease, from before there was one: its last write says, not its status alone', async () => {
    const w = await tillWorld(app)
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closing_control' } })

    const young = await close(w, { counted: { cash: 100 } })
    expect(young.status).toBe(400)
    expect((await session(w)).status).toBe('closing_control')

    await POSSession.collection.updateOne({ _id: new POSSession.base.Types.ObjectId(w.sessionId) }, { $set: { updatedAt: new Date(Date.now() - CLOSE_LEASE_MS - 1000) } })
    const old = await close(w, { counted: { cash: 100 } })
    expect(old.json.code).toBe('close_interrupted')
    expect((await session(w)).status).toBe('open')
  })

  it('two presses at one that died: both are told, whichever won the write, and neither runs a Z', async () => {
    const w = await tillWorld(app)
    await died(w)
    const real = POSSession.findOneAndUpdate
    let inner: any
    let done = false
    ;(POSSession as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
      if (done || update?.$set?.status !== 'open') return (real as any).call(POSSession, filter, update, ...rest)
      done = true
      return {
        exec: async () => {
          inner = await close(w, { counted: { cash: 100 } })
          return (real as any).call(POSSession, filter, update, ...rest).exec()
        },
      }
    }
    let outer: any
    try {
      outer = await close(w, { counted: { cash: 100 } })
    } finally {
      ;(POSSession as any).findOneAndUpdate = real
    }

    expect(inner.json.code).toBe('close_interrupted')
    expect(outer.status).toBe(409)
    expect(outer.json.code).toBe('close_interrupted')
    expect(w.sim!.reports).toHaveLength(0)
    expect((await session(w)).status).toBe('open')
    // `createAuditEntry` is not awaited: wait for the row, as the test above does, then hold it to one.
    const interrupted = () => AuditLog.countDocuments({ orgId: w.oid, action: 'close_interrupted' })
    await until(async () => (await interrupted()) >= 1, 'the audit entry')
    expect(await interrupted()).toBe(1)
  })

  it('only who may close it can put it back', async () => {
    const w = await tillWorld(app)
    await died(w)

    // The clerk is nobody's manager here, and it is not their session.
    const stranger = await w.tokenAs('sales')
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { cashierId: w.clerk._id } })
    const r = await close(w, { counted: { cash: 100 } }, undefined, stranger)

    expect(r.status).toBe(403)
    expect((await session(w)).status).toBe('closing_control')
  })

  it('a close that comes back past its lease undoes nothing: put back since, it does not close it', async () => {
    const w = await tillWorld(app)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === Z ? held.closed : undefined)
    const first = close(w, { counted: { cash: 100 } })
    await until(async () => (await session(w)).status === 'closing_control', 'the claim')
    await until(() => w.sim!.executed.some(c => c.cmd === 0x4A), 'the Z to be under way')
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { closeLeaseUntil: new Date(Date.now() - 1000) } })

    expect((await close(w, { counted: { cash: 100 } })).json.code).toBe('close_interrupted')
    expect((await session(w)).status).toBe('open')

    w.sim!.beforeCommand = null
    held.open()
    const came = await first

    expect(came.status).toBe(500)
    expect(came.json.message).toContain('without a fiscal report')
    expect((await session(w)).status).toBe('open')
  })

  it('and closed since by someone else, it does not reopen it', async () => {
    const w = await tillWorld(app)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === Z ? held.closed : undefined)
    const first = close(w, { counted: { cash: 100 } })
    await until(async () => (await session(w)).status === 'closing_control', 'the claim')
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { closeLeaseUntil: new Date(Date.now() - 1000) } })
    expect((await close(w, { counted: { cash: 100 } })).json.code).toBe('close_interrupted')

    const second = await close(w, { counted: { cash: 90 }, closeWithoutFiscal: true })
    expect(second.status).toBe(200)

    w.sim!.beforeCommand = null
    held.open()
    expect((await first).status).toBe(500)
    expect(await session(w)).toMatchObject({ status: 'closed', closingBalance: 90 })
  })
})

describe('a close while a sale is printing on the device', () => {
  const Z_REPORT = 0x45
  const UNP = 'ED123456-0001-0000099'

  /** A session with a sale that has reached the device and not finished: the driver is printing it. */
  async function printing() {
    const w = await tillWorld(app)
    const printer = getPrinter(w.deviceId)
    await printer.openFiscalReceipt('0001', 'Иван Петров', UNP)
    return { w, printer }
  }

  it('answers 409 receipt_open, leaves the device alone, and the session open with no failure on it', async () => {
    const { w } = await printing()
    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } }, 'close-while-printing')

    expect(r.status).toBe(409)
    expect(r.json).toEqual({ code: 'receipt_open', message: 'A sale is printing on this device. Wait for it to finish, then close again.' })

    const device: any = await FiscalDevice.findById(w.deviceId).lean().exec()
    expect(device.status).toBe('online')
    const session: any = await POSSession.findById(w.sessionId).lean().exec()
    expect(session.status).toBe('open')
    expect(session.fiscalStatus).toBeUndefined()
    expect(session.fiscalError).toBeUndefined()
    expect(session.closeClientKey).toBeUndefined()
    // No Z, and the sale's receipt is still on the device.
    expect(w.sim!.executed.filter(e => e.cmd === Z_REPORT)).toHaveLength(0)
    expect(w.sim!.receipt).not.toBeNull()
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'z_report_failed' })).toBe(0)
  })

  it('closes on the next try, once the sale has finished', async () => {
    const { w, printer } = await printing()
    const close = () => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })
    expect((await close()).status).toBe(409)

    await printer.printSaleLine('Болт', 1, 12, 'Б', undefined, 20)
    await printer.printPayment('cash', 12)
    await printer.closeFiscalReceipt()

    const closed = await close()
    expect(closed.status).toBe(200)
    expect(closed.json.fiscalStatus).toBe('closed')
    expect(w.sim!.executed.filter(e => e.cmd === Z_REPORT)).toHaveLength(1)
  })

  it('every other failure stays what it was: 503 fiscal_error, the device in error, the failure on the session', async () => {
    const w = await tillWorld(app)
    w.sim!.paper = false
    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    const device: any = await FiscalDevice.findById(w.deviceId).lean().exec()
    expect(device.status).toBe('error')
    const session: any = await POSSession.findById(w.sessionId).lean().exec()
    expect(session.status).toBe('open')
    expect(session.fiscalStatus).toBe('failed')
  })

  it('#454: the device away is no device error: 503 in the org\'s language, and the device row left as it was', async () => {
    const w = await tillWorld(app)
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.locale': 'en' } }).exec()
    w.sim!.disconnected = true
    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })
    w.sim!.disconnected = false

    expect(r.status).toBe(503)
    expect(r.json).toMatchObject({ code: 'fiscal_error', away: true })
    expect(r.json.message).toStartWith('No connection to the fiscal device. The day is NOT closed.')
    const device: any = await FiscalDevice.findById(w.deviceId).lean().exec()
    expect(device.status).not.toBe('error')
    const session: any = await POSSession.findById(w.sessionId).lean().exec()
    expect(session.status).toBe('open')
    expect(session.fiscalStatus).toBe('failed')
  })

  it('#454: a Bulgarian org is answered in Bulgarian, as before', async () => {
    const w = await tillWorld(app)
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.locale': 'bg' } }).exec()
    w.sim!.paper = false
    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })
    expect(r.status).toBe(503)
    expect(r.json.message).toStartWith('Фискалното устройство върна грешка. Денят НЕ е приключен.')
  })
})

describe('session model (FR-9.1/9.2)', () => {
  it('persists the breakdown and the fiscal outcome', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)

    const breakdown = buildClosingBreakdown({ cash: 100, card: 20, other: 5 }, { cash: 98, card: 20, other: 5 })
    await POSSession.updateOne({ _id: session._id }, {
      $set: {
        status: 'closed', closingBreakdown: breakdown,
        fiscalStatus: 'closed', zReportNumber: '0042', fiscalClosedAt: new Date(),
      },
    }).exec()

    const reloaded = await POSSession.findById(session._id).lean() as any
    expect(reloaded.closingBreakdown).toHaveLength(3)
    expect(reloaded.closingBreakdown[0]).toMatchObject({ method: 'cash', expected: 100, counted: 98, difference: -2 })
    expect(reloaded.fiscalStatus).toBe('closed')
    expect(reloaded.zReportNumber).toBe('0042')
  })

  it('defaults totalOther to 0 on a new session', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)
    const reloaded = await POSSession.findById(session._id).lean() as any
    expect(reloaded.totalOther).toBe(0)
  })

  it('accumulates non-cash/card tenders into totalOther', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    const user = await createTestUser(orgId)
    const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId)

    // What the transaction route now does for a voucher payment.
    await POSSession.findByIdAndUpdate(session._id, { $inc: { totalOther: 25 } }).exec()
    const reloaded = await POSSession.findById(session._id).lean() as any
    expect(reloaded.totalOther).toBe(25)
    expect(expectedTotals(reloaded).other).toBe(25)
  })
})
