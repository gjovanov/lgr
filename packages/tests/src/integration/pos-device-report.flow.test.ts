import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestFiscalDevice } from '../helpers/factories'
import { AuditLog, FiscalDevice } from 'db/models'
import { ELTRADE_CMD } from 'fiscal/eltrade'
import { getPrinter, registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'

/**
 * POS Sessions: a device's reports, per session.
 *
 * `POST /trade/pos/session/:id/device-report` prints on the session's device: the one its close
 * used, once it is closed, and until then its warehouse's, found the way its close finds it. It is
 * the device page's implementation (`fiscal/device-command`) behind the device page's roles.
 * ⚠ There is no Z: a Z runs only through the close, and one run from here makes the next close print
 * zeros.
 *
 * Each case asserts both halves, as the device page's own tests do: the answer AND what reached the
 * device. A refusal sends nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const extra: string[] = []
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => {
  for (const id of extra.splice(0)) unregisterPrinter(id)
  forgetDevices()
  await clearCollections()
})

const REPORT = (w: TillWorld, id = w.sessionId) => `/trade/pos/session/${id}/device-report`
const report = (w: TillWorld, body: unknown, as?: string) => w.call('POST', REPORT(w), body, undefined, as)
const reports = (w: TillWorld) => w.sim!.reports.map(r => [r.cmd, r.data])
const close = (w: TillWorld, cash = 100) => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash } })

/** The audit row an action left; createAuditEntry does not wait for its write. */
async function audited(w: TillWorld, action: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const row = await AuditLog.findOne({ orgId: w.oid, action }).lean().exec()
    if (row) return row
    await new Promise(r => setTimeout(r, 25))
  }
  return null
}

describe('every kind of report', () => {
  it('an X, on the open session: 45h "2", and the day stays open', async () => {
    const w = await tillWorld(app)
    const r = await report(w, { kind: 'x' })
    expect(r.status).toBe(200)
    expect(r.json.xReport.reportNumber).toBe('0012')
    expect(reports(w)).toEqual([[ELTRADE_CMD.DAILY_REPORT, '2']])
    expect(w.sim!.closure).toBe(12)
  })

  it('the fiscal memory by date: short 4Fh, detailed 5Eh, in the device\'s DDMMYY', async () => {
    const w = await tillWorld(app)
    const period = { startDate: '2026-10-01', endDate: '2026-10-31' }
    expect((await report(w, { kind: 'fm_date', ...period })).status).toBe(200)
    expect((await report(w, { kind: 'fm_date', ...period, detailed: true })).status).toBe(200)
    expect(reports(w)).toEqual([
      [ELTRADE_CMD.SHORT_FM_REPORT_BY_DATE, '011026,311026'],
      [ELTRADE_CMD.DETAILED_FM_REPORT_BY_DATE, '011026,311026'],
    ])
  })

  it('the fiscal memory by Z number: short 5Fh, detailed 49h, NNNN,NNNN', async () => {
    const w = await tillWorld(app)
    expect((await report(w, { kind: 'fm_number', startNumber: 3, endNumber: 12 })).status).toBe(200)
    expect((await report(w, { kind: 'fm_number', startNumber: 12, endNumber: 12, detailed: true })).status).toBe(200)
    expect(reports(w)).toEqual([
      [ELTRADE_CMD.SHORT_FM_REPORT_BY_NUMBER, '0003,0012'],
      [ELTRADE_CMD.DETAILED_FM_REPORT_BY_NUMBER, '0012,0012'],
    ])
  })

  it('the electronic journal and the operator report, on a device that has them', async () => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    const calls: any[] = []
    registerPrinter(w.deviceId, {
      printEJReport: async (from: Date, to: Date) => { calls.push(['ej', from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]) },
      printOperatorReport: async (n?: number) => { calls.push(['operator', n]) },
    } as any)
    expect((await report(w, { kind: 'ej', startDate: '2026-10-01', endDate: '2026-10-02' })).status).toBe(200)
    expect((await report(w, { kind: 'operator', operatorNumber: 3 })).status).toBe(200)
    expect((await report(w, { kind: 'operator' })).status).toBe(200)
    expect(calls).toEqual([['ej', '2026-10-01', '2026-10-02'], ['operator', 3], ['operator', undefined]])
  })

  it('leaves an audit row naming the session', async () => {
    const w = await tillWorld(app)
    await report(w, { kind: 'fm_number', startNumber: 1, endNumber: 2 })
    const row = await audited(w, 'fm_report')
    expect(row).toMatchObject({ module: 'pos', entityType: 'pos_session', operatorCode: '0001' })
    expect(String(row.entityId)).toBe(w.sessionId)
    expect(row.entityName).toContain('Eltrade A3')
  })

  it('there is no Z: the schema refuses the kind, and the day stays open', async () => {
    const w = await tillWorld(app)
    const r = await report(w, { kind: 'z' })
    expect(r.status).toBe(422)
    expect(w.sim!.reports).toHaveLength(0)
    expect(w.sim!.closure).toBe(12)
  })
})

describe('what a device cannot do: 400 with the reason, nothing sent', () => {
  it('an Eltrade has no electronic journal and no operator report', async () => {
    const w = await tillWorld(app)
    const before = w.sim!.frames
    for (const body of [{ kind: 'ej', startDate: '2026-10-01', endDate: '2026-10-02' }, { kind: 'operator' }]) {
      const r = await report(w, body)
      expect({ status: r.status, code: r.json.code }).toEqual({ status: 400, code: 'unsupported' })
      expect(r.json.message).toContain('Eltrade')
    }
    expect(w.sim!.frames).toBe(before)
  })

  it('the capability is asked first: an unsupported report on a device nothing holds says so', async () => {
    const w = await tillWorld(app)
    forgetDevices()
    const r = await report(w, { kind: 'ej', startDate: '2026-10-01', endDate: '2026-10-02' })
    expect({ status: r.status, code: r.json.code }).toEqual({ status: 400, code: 'unsupported' })
  })

  it('bad input is 400 with what to correct, and nothing sent', async () => {
    const w = await tillWorld(app)
    const before = w.sim!.frames
    for (const body of [
      { kind: 'fm_date', startDate: '', endDate: null },
      { kind: 'fm_date', startDate: '2026-10-31', endDate: '2026-10-01' },
      { kind: 'fm_number', startNumber: null, endNumber: 12 },
      { kind: 'fm_number', startNumber: 12, endNumber: 3 },
    ]) {
      const r = await report(w, body)
      expect({ status: r.status, code: r.json.code }).toEqual({ status: 400, code: 'bad_input' })
    }
    expect(w.sim!.frames).toBe(before)
  })
})

describe('whose device it prints on', () => {
  it('an open session: its warehouse\'s, the connected one when there are two', async () => {
    const w = await tillWorld(app)
    await createTestFiscalDevice(w.oid, w.warehouse._id as any, { name: 'A dead one', deviceNumber: 'ED000001', manufacturer: 'eltrade', status: 'offline' } as any)
    expect((await report(w, { kind: 'x' })).status).toBe(200)
    expect(reports(w)).toHaveLength(1)
    const { json } = await w.call('GET', REPORT(w))
    expect(json.device).toMatchObject({ name: 'Eltrade A3', deviceNumber: 'ED123456', connected: true })
  })

  it('a closed session: the device its close used, even with another on the warehouse now', async () => {
    const w = await tillWorld(app)
    expect((await close(w)).status).toBe(200)
    // The warehouse has moved on to another device, connected; the session's is the one it closed on.
    const next = await createTestFiscalDevice(w.oid, w.warehouse._id as any, { name: 'Каса 2', deviceNumber: 'ED000002', manufacturer: 'tremol', status: 'online' } as any)
    registerPrinter(String(next._id), { printFiscalMemoryReportByNumber: async () => { throw new Error('printed on the wrong device') } } as any)
    extra.push(String(next._id))

    const r = await report(w, { kind: 'fm_number', startNumber: 13, endNumber: 13 })

    expect(r.status).toBe(200)
    expect(reports(w).at(-1)).toEqual([ELTRADE_CMD.SHORT_FM_REPORT_BY_NUMBER, '0013,0013'])
    expect((await w.call('GET', REPORT(w))).json.device.name).toBe('Eltrade A3')
  })

  it('an X is for an open session only: its day is the device\'s day as it stands', async () => {
    const w = await tillWorld(app)
    expect((await close(w)).status).toBe(200)
    const before = w.sim!.reports.length
    const r = await report(w, { kind: 'x' })
    expect({ status: r.status, code: r.json.code }).toEqual({ status: 409, code: 'session_not_open' })
    expect(w.sim!.reports).toHaveLength(before)
  })

  it('a closed session with no device names none', async () => {
    const w = await tillWorld(app, { device: false })
    expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })).status).toBe(200)
    expect((await w.call('GET', REPORT(w))).json.device).toBeNull()
    const r = await report(w, { kind: 'fm_date', startDate: '2026-10-01', endDate: '2026-10-02' })
    expect({ status: r.status, code: r.json.code }).toEqual({ status: 409, code: 'fiscal_device_not_connected' })
  })

  it('a session of another org is not found', async () => {
    const w = await tillWorld(app)
    const other = await tillWorld(app)
    const r = await w.call('POST', REPORT(w, other.sessionId), { kind: 'x' })
    expect(r.status).toBe(404)
    expect(other.sim!.reports).toHaveLength(0)
  })
})

describe('when the device cannot print it', () => {
  it('nothing holds it: 409, and the page can say so before anyone tries', async () => {
    const w = await tillWorld(app)
    forgetDevices()
    const r = await report(w, { kind: 'x' })
    expect({ status: r.status, code: r.json.code }).toEqual({ status: 409, code: 'fiscal_device_not_connected' })
    expect(r.json.message).toContain('not connected')
    expect((await w.call('GET', REPORT(w))).json.device).toMatchObject({ connected: false, capabilities: { driver: 'eltrade' } })
    expect(await audited(w, 'x_report')).toBeNull()
  })

  it('no device on the warehouse: 409', async () => {
    const w = await tillWorld(app, { device: false })
    const r = await report(w, { kind: 'x' })
    expect({ status: r.status, code: r.json.code }).toEqual({ status: 409, code: 'fiscal_device_not_connected' })
  })

  it('the driver\'s own errors, through fiscalFailure: a sale printing 409, no paper 409, no answer 504', async () => {
    const w = await tillWorld(app)
    const printer = getPrinter(w.deviceId)
    await printer.openFiscalReceipt('0001', 'Иван Петров', 'ED123456-0001-0000099')
    const busy = await report(w, { kind: 'x' })
    expect({ status: busy.status, code: busy.json.code }).toEqual({ status: 409, code: 'receipt_open' })
    expect(w.sim!.receipt).not.toBeNull()
    await printer.cancelFiscalReceipt!()

    w.sim!.paper = false
    const out = await report(w, { kind: 'x' })
    expect({ status: out.status, code: out.json.code }).toEqual({ status: 409, code: 'device_refused' })
    w.sim!.paper = true

    w.sim!.silent = true
    const gone = await report(w, { kind: 'x' })
    expect({ status: gone.status, code: gone.json.code }).toEqual({ status: 504, code: 'device_timeout' })
    // Nothing printed: no audit row, and the device is not marked as anything by a report.
    expect(await audited(w, 'x_report')).toBeNull()
    expect((await FiscalDevice.findById(w.deviceId).lean().exec() as any).status).toBe('online')
  }, 30_000)
})

describe('who may', () => {
  it('admin, manager and warehouse manager; a warehouse manager holds no pos.write and still may', async () => {
    const w = await tillWorld(app)
    for (const role of ['admin', 'manager', 'warehouse_manager']) {
      const r = await report(w, { kind: 'x' }, await w.tokenAs(role))
      expect({ role, status: r.status }).toEqual({ role, status: 200 })
      const menu = await w.call('GET', REPORT(w), undefined, undefined, await w.tokenAs(role))
      expect({ role, status: menu.status }).toEqual({ role, status: 200 })
    }
    expect(reports(w)).toHaveLength(3)
  })

  it('not a cashier, nor anyone else: 403, and nothing reaches the device', async () => {
    const w = await tillWorld(app)
    const before = w.sim!.frames
    for (const role of ['sales', 'accountant', 'member', 'nra_auditor']) {
      const r = await report(w, { kind: 'x' }, await w.tokenAs(role))
      expect({ role, status: r.status }).toEqual({ role, status: 403 })
      const menu = await w.call('GET', REPORT(w), undefined, undefined, await w.tokenAs(role))
      expect({ role, status: menu.status }).toEqual({ role, status: 403 })
    }
    expect(w.sim!.frames).toBe(before)
  })

  it('an anonymous caller: 401', async () => {
    const w = await tillWorld(app)
    const res = await app.handle(new Request(`http://localhost/org/${w.orgId}${REPORT(w)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'x' }),
    }))
    expect(res.status).toBe(401)
    expect(w.sim!.reports).toHaveLength(0)
  })
})
