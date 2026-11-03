import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, reconnect, type TillWorld } from '../helpers/till-world'
import { clerkSale, gate, until } from '../helpers/receipt-world'
import { AuditLog, FiscalDevice, Invoice, POSSession } from 'db/models'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { deviceTurn } from 'fiscal/device-turn'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerOpeningFloat } from 'services/biz/cash-register/opening-float'
import { SESSION_REPORT_LABELS, formatSessionReport } from 'services/biz/cash-register/session-report'
import { requestHash } from 'services/biz/hot-path-key'

/**
 * #473 — a session's opening amount reaches its fiscal device. Н-18 чл. 33 ал. 1 names the „начална сума"
 * among what is registered as „служебно въведени", and чл. 31 ал. 3 refuses a cash storno above what the
 * device holds. Until now no driver had the command, and neither did the simulator, so the Z read 0 and no
 * storno path had ever met that refusal.
 *
 * The world's own session opens on 100, so the clerk's is what these tests watch: 50 unless it says.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const SERVICE_CASH = 0x46
const OPEN_FISCAL = 0x90
const OPEN_TEXT = 0x26
const TOTAL = 0x35
const Z = 0x45

const opening = (w: TillWorld, openingBalance = 50, key?: string) =>
  w.call('POST', '/trade/pos/session', { warehouseId: String(w.warehouse._id), openingBalance, currency: 'EUR' }, key, w.clerkToken)
const idOf = (r: { json: any }) => String(r.json.session.id ?? r.json.session._id)
const floatOf = async (id: string) => ((await POSSession.findById(id).lean().exec()) as any)?.deviceFloat
const docOf = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>
/** Where in the device's day a command landed. */
const atCommand = (w: TillWorld, cmd: number, data?: string) => w.sim!.executed.findIndex(c => c.cmd === cmd && (data === undefined || c.data === data))
const clerkCloses = (w: TillWorld, id: string, body: Record<string, unknown> = { counted: { cash: 50 } }) =>
  w.call('POST', `/trade/pos/session/${id}/close`, body, undefined, w.clerkToken)

/** The device goes away, the clerk opens, and it comes back: a session that owes it. */
async function owedSession(w: TillWorld, amount = 50): Promise<string> {
  unregisterPrinter(w.deviceId)
  const opened = await opening(w, amount)
  expect(opened.status).toBe(200)
  reconnect(w)
  return idOf(opened)
}

describe('at the open', () => {
  it('goes to the device as service cash, and the session says so', async () => {
    const w = await tillWorld(app)

    expect(w.sim!.serviceSlips).toEqual([100])
    expect({ cash: w.sim!.cash, serviceIn: w.sim!.serviceIn }).toEqual({ cash: 100, serviceIn: 100 })
    expect(w.session.deviceFloat).toMatchObject({ state: 'registered', deviceNumber: 'ED123456' })
    expect(w.session.deviceFloat.registeredAt).toBeTruthy()
    expect(w.session.deviceFloat.serviceInBefore).toBeUndefined()
    expect(w.session.deviceFloat.error).toBeUndefined()
    await until(async () => (await AuditLog.countDocuments({ orgId: w.oid, action: 'service_cash_in' })) === 1, 'the audit entry')
  })

  it('a second session on the device adds its own', async () => {
    const w = await tillWorld(app)
    await opening(w)
    expect(w.sim!.serviceSlips).toEqual([100, 50])
    expect(w.sim!.serviceIn).toBe(150)
  })

  it('a retried open sends nothing more', async () => {
    const w = await tillWorld(app)
    const first = await opening(w, 50, 'open-key-0001')
    const again = await opening(w, 50, 'open-key-0001')
    expect(idOf(again)).toBe(idOf(first))
    expect(w.sim!.serviceSlips).toEqual([100, 50])
  })

  it('a device that is not fiscalized takes it too: an A3 did', async () => {
    const w = await tillWorld(app)
    w.sim!.unfiscalizedUnit = true
    expect((await opening(w)).json.session.deviceFloat.state).toBe('registered')
    expect(w.sim!.serviceSlips).toEqual([100, 50])
  })

  it('no amount: nothing owed, nothing sent', async () => {
    const w = await tillWorld(app)
    expect((await opening(w, 0)).json.session.deviceFloat).toBeUndefined()
    expect(atCommand(w, SERVICE_CASH)).toBe(-1)
  })

  it('no device in the warehouse: nothing owed', async () => {
    const w = await tillWorld(app, { device: false })
    expect(w.session.deviceFloat).toBeUndefined()
  })

  it('a device whose driver has no such command: nothing owed, nothing sent', async () => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    expect((await opening(w)).json.session.deviceFloat).toBeUndefined()
    expect(atCommand(w, SERVICE_CASH)).toBe(-1)
  })

  it('a session from before this existed owes nothing, whatever it opened with', async () => {
    const w = await tillWorld(app)
    await POSSession.updateOne({ _id: w.sessionId }, { $unset: { deviceFloat: 1 } }).exec()
    const before = w.sim!.serviceSlips.length
    expect((await w.sell(1)).status).toBe(200)
    expect(w.sim!.serviceSlips).toHaveLength(before)
  })

  it('a device held by a long Z does not hold the open: it stays owed, and goes with the next document', async () => {
    const w = await tillWorld(app)
    const hold = gate()
    const held = deviceTurn(w.deviceId, () => hold.closed)
    const started = Date.now()

    const opened = await opening(w)

    expect(opened.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(opened.json.session.deviceFloat.state).toBe('pending')
    hold.open()
    await held

    expect((await clerkSale(w, idOf(opened))).status).toBe(200)
    expect(await floatOf(idOf(opened))).toMatchObject({ state: 'registered' })
    expect(w.sim!.serviceSlips).toEqual([100, 50])
  }, 30_000)
})

describe('with the device away at the open', () => {
  it('the open goes through, says so, and the device is told nothing', async () => {
    const w = await tillWorld(app)
    unregisterPrinter(w.deviceId)
    const opened = await opening(w)
    expect(opened.status).toBe(200)
    expect(opened.json.session.deviceFloat).toMatchObject({ state: 'pending' })
    expect(opened.json.session.deviceFloat.registeredAt).toBeUndefined()
    expect(w.sim!.serviceSlips).toEqual([100])
  })

  it('it goes first in the next sale\'s turn, before the counter is read, so its slip is no print of the sale', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    const before = w.sim!.lastDocNumber

    const sold = await clerkSale(w, id)

    expect(sold.status).toBe(200)
    expect(sold.json.receiptError).toBeUndefined()
    expect(w.sim!.serviceSlips).toEqual([100, 50])
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBeLessThan(atCommand(w, OPEN_FISCAL))
    const doc = await docOf(sold.json.transaction.id)
    expect(doc.register.fiscal).toMatchObject({ state: 'printed', counterBefore: before + 1 })
    expect(Number(doc.register.fiscal.receiptNo)).toBe(before + 2)
    expect(await floatOf(id)).toMatchObject({ state: 'registered', deviceNumber: 'ED123456' })
  })

  it('a text receipt takes it first too', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    w.sim!.unfiscalizedUnit = true

    const sold = await clerkSale(w, id)

    expect(sold.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'text' })
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBeLessThan(atCommand(w, OPEN_TEXT))
    expect(await floatOf(id)).toMatchObject({ state: 'registered' })
  })

  it('and a storno: the refund it pays may be why the device needs it', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    const paidByCard = (await w.sell(2, { method: 'card' })).json.transaction.id
    const id = await owedSession(w, 24)

    const reversed = await w.call('POST', `/trade/pos/session/${id}/storno`, {
      originalTransactionId: paidByCard, reason: 'customer_return', payments: [{ method: 'cash', amount: 24 }],
    }, undefined, w.clerkToken)

    expect(reversed.status).toBe(200)
    expect(await floatOf(id)).toMatchObject({ state: 'registered' })
    expect(w.sim!.receipts.filter(r => r.kind === 'storno' && !r.voided)).toHaveLength(1)
    expect(w.sim!.cash).toBe(0)
  })

  it('a print that died first is judged first: the slip does not make it read as printed', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    const body = w.saleBody(1)
    const key = 'crash-key-0473'
    // What the route leaves when the process dies between the counter's record and the device.
    const sold: any = await docOf((await w.sell(1)).json.transaction.id)
    const { _id, completedAt, ...rest } = sold
    const inserted = await Invoice.collection.insertOne({
      ...rest,
      invoiceNumber: 'CS-2026-90473', clientKey: key, requestHash: requestHash(`pos.sale:${id}`, body),
      leaseUntil: new Date(Date.now() - 1000),
      register: {
        ...rest.register, sessionId: POSSession.base.Types.ObjectId.createFromHexString(id), unp: 'ED123456-0002-0000473',
        operatorCode: '0002', sessionTotalsApplied: false, movementId: undefined,
        fiscal: { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber },
      },
    } as any)

    const retried = await w.call('POST', `/trade/pos/session/${id}/transaction`, body, key, w.clerkToken)

    expect(retried.status).toBe(200)
    const doc = await docOf(String(inserted.insertedId))
    expect(doc.register.fiscal.state).toBe('printed')
    expect(await floatOf(id)).toMatchObject({ state: 'registered' })
  })
})

describe('over a line that loses answers', () => {
  /** The bridge goes between the read and the amount, or just after the amount. */
  function droppingAtTheAmount(w: TillWorld, when: 'before' | 'after') {
    let seen = 0
    w.sim!.beforeCommand = (cmd) => {
      if (cmd !== SERVICE_CASH || ++seen !== 2) return
      if (when === 'after') w.sim!.dropAfter = SERVICE_CASH
      else throw new Error('Bridge disconnected')
    }
  }

  it('the amount arrived and the answer did not: the next turn reads that, and no second slip prints', async () => {
    const w = await tillWorld(app)
    droppingAtTheAmount(w, 'after')

    const opened = await opening(w)

    expect(opened.status).toBe(200)
    expect(opened.json.session.deviceFloat).toMatchObject({ state: 'pending', deviceNumber: 'ED123456', serviceInBefore: 100 })
    expect(w.sim!.serviceSlips).toEqual([100, 50])
    reconnect(w)

    expect((await clerkSale(w, idOf(opened))).status).toBe(200)

    expect(w.sim!.serviceSlips).toEqual([100, 50])
    expect(await floatOf(idOf(opened))).toMatchObject({ state: 'registered' })
  })

  it('the amount never arrived: the next turn sends it', async () => {
    const w = await tillWorld(app)
    droppingAtTheAmount(w, 'before')
    const opened = await opening(w)
    expect(w.sim!.serviceSlips).toEqual([100])
    expect(opened.json.session.deviceFloat.state).toBe('pending')
    reconnect(w)

    await clerkSale(w, idOf(opened))

    expect(w.sim!.serviceSlips).toEqual([100, 50])
    expect(await floatOf(idOf(opened))).toMatchObject({ state: 'registered' })
  })

  it('a Z since then cleared what arrived, so that day is owed it again', async () => {
    const w = await tillWorld(app)
    droppingAtTheAmount(w, 'after')
    const opened = await opening(w)
    reconnect(w)
    expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })).status).toBe(200)
    expect(w.sim!.serviceIn).toBe(0)

    await clerkSale(w, idOf(opened))

    expect(w.sim!.serviceIn).toBe(50)
    expect(await floatOf(idOf(opened))).toMatchObject({ state: 'registered' })
  })

  it('an attempt on a device that is gone says nothing about the one that replaced it', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    await POSSession.updateOne({ _id: id }, { $set: { 'deviceFloat.deviceNumber': 'ED999999', 'deviceFloat.serviceInBefore': 0 } }).exec()
    const before = w.sim!.serviceSlips.length

    await clerkSale(w, id)

    expect(w.sim!.serviceSlips).toHaveLength(before + 1)
    expect(await floatOf(id)).toMatchObject({ state: 'registered', deviceNumber: 'ED123456' })
  })

  it('two sessions refused at the open: the slip one of them sends later is not taken for the other\'s', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    w.sim!.nonFiscalOpen = true
    const theirs = idOf(await opening(w, 50))
    expect((await floatOf(theirs)).serviceInBefore).toBeUndefined()
    // The cashier's own session owes more, and its next sale sends it first.
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { openingBalance: 60, deviceFloat: { state: 'pending' } } }).exec()
    expect((await w.sell(1)).status).toBe(200)
    expect(w.sim!.serviceSlips).toEqual([60])

    await clerkSale(w, theirs)

    expect(w.sim!.serviceSlips).toEqual([60, 50])
    expect(await floatOf(theirs)).toMatchObject({ state: 'registered' })
  })

  it('one the device would not print for want of paper leaves nothing to prove either', async () => {
    const w = await tillWorld(app)
    w.sim!.paper = false
    const opened = await opening(w)
    expect(opened.json.session.deviceFloat.state).toBe('pending')
    expect(opened.json.session.deviceFloat.error).toBeTruthy()
    expect(opened.json.session.deviceFloat.serviceInBefore).toBeUndefined()
  })

  it('a slip another session sends while this one waits for its proof is not taken for this one', async () => {
    const w = await tillWorld(app)
    droppingAtTheAmount(w, 'before')
    const theirs = idOf(await opening(w))
    expect(await floatOf(theirs)).toMatchObject({ state: 'pending', serviceInBefore: 100 })
    reconnect(w)
    // The cashier's own session owes as much again, and its next sale sends it first.
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { openingBalance: 50, deviceFloat: { state: 'pending' } } }).exec()
    expect((await w.sell(1)).status).toBe(200)
    expect(w.sim!.serviceSlips).toEqual([100, 50])
    expect(await floatOf(theirs)).toMatchObject({ state: 'pending', serviceInBefore: 150 })

    await clerkSale(w, theirs)

    expect(w.sim!.serviceSlips).toEqual([100, 50, 50])
    expect(await floatOf(theirs)).toMatchObject({ state: 'registered' })
  })
})

describe('what stops it stops nothing else', () => {
  it('refused over a receipt left open: owed, with the reason, and the next document clears that and sends it', async () => {
    const w = await tillWorld(app)
    w.sim!.nonFiscalOpen = true

    const opened = await opening(w)

    expect(opened.status).toBe(200)
    expect(opened.json.session.deviceFloat.state).toBe('pending')
    expect(opened.json.session.deviceFloat.error).toContain('refused')
    expect(w.sim!.serviceSlips).toEqual([100])

    const sold = await clerkSale(w, idOf(opened))

    expect(sold.json.transaction.fiscal.state).toBe('printed')
    expect(w.sim!.serviceSlips).toEqual([100, 50])
    expect(await floatOf(idOf(opened))).toMatchObject({ state: 'registered' })
    expect((await floatOf(idOf(opened))).error).toBeUndefined()
  })

  it('a device that will not answer it still prints the sale, and is not marked in error', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    w.sim!.beforeCommand = (cmd) => { if (cmd === SERVICE_CASH) throw new Error('Serial read timeout — no answer from the device') }

    const sold = await clerkSale(w, id)

    expect(sold.status).toBe(200)
    expect(sold.json.transaction.fiscal.state).toBe('printed')
    expect(await floatOf(id)).toMatchObject({ state: 'pending' })
    expect((await floatOf(id)).error).toContain('no response')
    expect(((await FiscalDevice.findById(w.deviceId).lean().exec()) as any).status).not.toBe('error')
  })

  it('never throws, and leaves a session that owes nothing alone', async () => {
    const w = await tillWorld(app)
    const untouched = {
      deviceNumber: 'ED123456',
      readServiceCash: async () => { throw new Error('asked') },
      moveServiceCash: async () => { throw new Error('asked') },
    }
    await registerOpeningFloat(untouched, w.sessionId)
    await registerOpeningFloat(untouched, undefined)
    await registerOpeningFloat({ deviceNumber: 'ED123456' }, w.sessionId)
    expect((await floatOf(w.sessionId)).error).toBeUndefined()
  })

  it('a session being closed gets nothing from a document, which lands past its Z; its own close sends it', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    await POSSession.updateOne({ _id: id }, { $set: { status: 'closing_control' } }).exec()
    const asked: string[] = []
    const watched = {
      deviceNumber: 'ED123456',
      readServiceCash: async () => { asked.push('read'); return { serviceIn: 0 } },
      moveServiceCash: async () => { asked.push('move'); return { accepted: true } },
    }

    await registerOpeningFloat(watched, id)
    expect(asked).toEqual([])

    await registerOpeningFloat(watched, id, { closing: true })
    expect(asked).toEqual(['read', 'move'])
    expect(await floatOf(id)).toMatchObject({ state: 'registered' })
  })
})

describe('the close', () => {
  it('a float still owed goes before the Z, the last that can show it', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)

    const closed = await clerkCloses(w, id)

    expect(closed.status).toBe(200)
    expect(closed.json.fiscalStatus).toBe('closed')
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBeGreaterThan(-1)
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBeLessThan(atCommand(w, Z, '0'))
    expect(closed.json.report.drawer.onDevice).toBe(true)
  })

  it('a float that went at the open does not go again, and the Z clears the device', async () => {
    const w = await tillWorld(app)
    expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })).status).toBe(200)
    expect(w.sim!.serviceSlips).toEqual([100])
    expect({ cash: w.sim!.cash, serviceIn: w.sim!.serviceIn }).toEqual({ cash: 0, serviceIn: 0 })
  })

  it('with the device busy past what the open waits, the float waits for it as the Z does, and goes first', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    const hold = gate()
    const held = deviceTurn(w.deviceId, () => hold.closed)
    setTimeout(() => hold.open(), 6_000)

    const closed = await clerkCloses(w, id)
    await held

    expect(closed.status).toBe(200)
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBeGreaterThan(-1)
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBeLessThan(atCommand(w, Z, '0'))
    expect(closed.json.report.drawer.onDevice).toBe(true)
  }, 30_000)

  it('an answer lost at the close: its second look reads the device before the Z, and no second slip prints', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    // Every answer to the amount is lost, its retransmits' included. The reads, and the line, stay up.
    const sim = w.sim!
    const isAmount = (frame: Uint8Array) => frame[3] === SERVICE_CASH && !(frame.length === 11 && frame[4] === 0x30)
    registerPrinter(w.deviceId, new EltradeFiscalPrinter(async (frame: Uint8Array) => {
      const answer = await sim.exchange(frame)
      if (isAmount(frame)) throw new Error('Serial read timeout — no answer from the device')
      return answer
    }, w.deviceId))

    const closed = await clerkCloses(w, id)

    expect(closed.status).toBe(200)
    expect(w.sim!.serviceSlips).toEqual([100, 50])
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBeLessThan(atCommand(w, Z, '0'))
    expect(closed.json.report.drawer.onDevice).toBe(true)
  })

  it('a refused Z does not send it twice on the next close', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)
    let failed = false
    w.sim!.beforeCommand = (cmd) => {
      if (cmd === Z && !failed) { failed = true; throw new Error('Bridge disconnected') }
    }

    expect((await clerkCloses(w, id)).status).toBe(503)
    expect(await floatOf(id)).toMatchObject({ state: 'registered' })
    reconnect(w)
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'online' } }).exec()

    expect((await clerkCloses(w, id)).status).toBe(200)
    expect(w.sim!.serviceSlips.filter(a => a === 50)).toHaveLength(1)
  })

  it('closed past a device that never came back: the report says the float is not on it', async () => {
    const w = await tillWorld(app)
    unregisterPrinter(w.deviceId)
    const id = idOf(await opening(w))

    const closed = await clerkCloses(w, id, { counted: { cash: 50 }, closeWithoutFiscal: true })

    expect(closed.status).toBe(200)
    expect(closed.json.report.drawer.onDevice).toBe(false)
    expect(formatSessionReport(closed.json.report, 'bg')).toContain(` ${SESSION_REPORT_LABELS.bg.notOnDevice}`)
    expect(await floatOf(id)).toMatchObject({ state: 'pending' })

    // ⚠ And it stays there. A document that outlives its session prints after the Z, on the next day.
    const asked: string[] = []
    const watched = {
      deviceNumber: 'ED123456',
      readServiceCash: async () => { asked.push('read'); return { serviceIn: 0 } },
      moveServiceCash: async () => { asked.push('move'); return { accepted: true } },
    }
    await registerOpeningFloat(watched, id)
    await registerOpeningFloat(watched, id, { closing: true })
    expect(asked).toEqual([])
    expect(await floatOf(id)).toMatchObject({ state: 'pending' })
  })

  it('closed without its Z, with the device right there: a person chose to leave the device out, so the float stays out', async () => {
    const w = await tillWorld(app)
    const id = await owedSession(w)

    const closed = await clerkCloses(w, id, { counted: { cash: 50 }, closeWithoutFiscal: true })

    expect(closed.status).toBe(200)
    expect(atCommand(w, SERVICE_CASH, '50.00')).toBe(-1)
    expect(closed.json.report.drawer.onDevice).toBe(false)
  })

  it('a report from a session that owed nothing prints as it always did', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 0 } })
    expect(closed.json.report.drawer.onDevice).toBeUndefined()
    expect(formatSessionReport(closed.json.report, 'en').join('\n')).not.toContain(SESSION_REPORT_LABELS.en.notOnDevice)
  })

  it('every label fits the till\'s 28 characters, with its line\'s indent', () => {
    for (const labels of Object.values(SESSION_REPORT_LABELS)) expect(labels.notOnDevice.length + 1).toBeLessThanOrEqual(28)
  })
})

describe('a refund meets the cash on the device (Н-18 чл. 31 ал. 3)', () => {
  const cashRefund = (w: TillWorld, saleId: string, reason = 'customer_return') =>
    w.storno(saleId, undefined, { reason, payments: [{ method: 'cash', amount: 24 }] })

  it('above what it holds: refused, nothing reversed, the sale as it was, and the operator told why it may be', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    const saleId = (await w.sell(2, { method: 'card' })).json.transaction.id
    const stock = (await w.stock()).quantity

    const refused = await cashRefund(w, saleId)

    expect(refused.status).toBe(503)
    expect(refused.json.code).toBe('fiscal_error')
    expect(refused.json.message).toContain('чл. 31 ал. 3')
    expect(w.sim!.receipt).toBeNull()
    const stornos = w.sim!.receipts.filter(r => r.kind === 'storno')
    expect(stornos).toHaveLength(1)
    expect(stornos[0].voided).toBe(true)
    expect((await w.stock()).quantity).toBe(stock)
    expect((await POSSession.findById(w.sessionId).lean().exec() as any).totalReturns).toBe(0)
    const sale = await docOf(saleId)
    expect(sale.register.stornoState ?? 'none').toBe('none')
    expect(sale.register.stornoedBy ?? []).toEqual([])
    // A device that said no is a device in working order, and the next sale goes straight through.
    expect(((await FiscalDevice.findById(w.deviceId).lean().exec()) as any).status).toBe('online')
    expect((await w.sell(1)).json.transaction.fiscal.state).toBe('printed')
  })

  it('refused, and then the device says no more: nobody knows what it holds, so it is marked after all', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    const saleId = (await w.sell(2, { method: 'card' })).json.transaction.id
    let refused = false
    w.sim!.beforeCommand = (cmd) => {
      if (refused) throw new Error('Bridge disconnected')
      refused = cmd === TOTAL
    }

    await cashRefund(w, saleId)

    expect(refused).toBe(true)
    expect(((await FiscalDevice.findById(w.deviceId).lean().exec()) as any).status).toBe('error')
  })

  it('out of paper at the same step is a fault, and no refund rule: no hint, and the device is marked', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    const saleId = (await w.sell(2, { method: 'card' })).json.transaction.id
    w.sim!.beforeCommand = (cmd) => { if (cmd === TOTAL) w.sim!.paper = false }

    const failed = await cashRefund(w, saleId)

    expect(failed.status).toBe(503)
    expect(failed.json.message).not.toContain('чл. 31')
    expect(((await FiscalDevice.findById(w.deviceId).lean().exec()) as any).status).toBe('error')
  })

  it('the float pays it', async () => {
    const w = await tillWorld(app, { openingBalance: 24 })
    const saleId = (await w.sell(2, { method: 'card' })).json.transaction.id
    expect((await cashRefund(w, saleId)).status).toBe(200)
    expect(w.sim!.cash).toBe(0)
  })

  it('an operator\'s error is the exception ал. 3 makes', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    const saleId = (await w.sell(2, { method: 'card' })).json.transaction.id
    expect((await cashRefund(w, saleId, 'operator_error')).status).toBe(200)
  })

  it('the day\'s own cash sales pay it: a refused refund is not an empty drawer\'s rule, it is the device\'s', async () => {
    const w = await tillWorld(app, { openingBalance: 0 })
    const saleId = (await w.sell(2)).json.transaction.id
    expect(w.sim!.cash).toBe(24)
    expect((await w.storno(saleId)).status).toBe(200)
    expect(w.sim!.cash).toBe(0)
  })
})
