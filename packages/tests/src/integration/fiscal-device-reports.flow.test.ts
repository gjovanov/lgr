/**
 * The device page's endpoints on an Eltrade — every report, the operators, the payment types —
 * through the API, against `EltradeSimulator` (the protocol document as a device).
 *
 * Each case asserts both halves: the HTTP answer the page shows AND what reached the device. A
 * refusal (wrong role, bad input, a feature the device does not have) must send nothing; a device
 * that cannot do what it was asked answers with what went wrong — 409 when it refused, 503 when
 * nothing holds it, 504 when it does not answer — never the blanket 500 these endpoints gave.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { PERMISSIONS } from 'config/constants'
import { AuditLog, FiscalDevice } from 'db/models'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'
import { EltradeFiscalPrinter, ELTRADE_CMD } from 'fiscal/eltrade'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { forgetClockVerification } from 'fiscal/clock'

let app: Elysia
const registered: string[] = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(fiscalDeviceController)
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  for (const id of registered.splice(0)) unregisterPrinter(id)
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const USER_ID = '000000000000000000000001'
const token = (orgId: string, role: string) =>
  (signer as any).decorator.jwt.sign({ id: USER_ID, orgId, role, permissions: [...PERMISSIONS], ownRecordsModules: [] })

type Role = 'admin' | 'manager' | 'warehouse_manager' | 'member'

/** An org with one device, connected (the default) to a simulated Eltrade. */
async function world(opts: { manufacturer?: string; connectionType?: string; connected?: boolean } = {}) {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, wh._id, {
    name: 'Каса 1', deviceNumber: 'ED123456', manufacturer: opts.manufacturer ?? 'eltrade',
    connectionType: opts.connectionType ?? 'browser', status: 'online',
  } as any)
  const orgId = String(org._id)
  const deviceId = String(device._id)
  const sim = new EltradeSimulator()
  const printer = new EltradeFiscalPrinter(sim.exchange, deviceId)
  if (opts.connected !== false && (opts.manufacturer ?? 'eltrade') === 'eltrade') {
    registerPrinter(deviceId, printer)
    registered.push(deviceId)
  }

  async function call(method: string, path: string, body?: unknown, role: Role = 'admin') {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/fiscal/device/${deviceId}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token(orgId, role)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  return { orgId, deviceId, sim, printer, call }
}

/** The audit row an action left; createAuditEntry does not wait for its write. */
async function audited(orgId: string, action: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const row = await AuditLog.findOne({ orgId, action }).lean().exec()
    if (row) return row
    await new Promise(r => setTimeout(r, 25))
  }
  return null
}

describe('the device and what it can do', () => {
  test('GET /:id and the list carry the Eltrade capabilities, connected or not', async () => {
    const w = await world({ connected: false })
    const one = await w.call('GET', '')
    expect(one.status).toBe(200)
    const caps = one.json.fiscalDevice.capabilities
    expect(caps.driver).toBe('eltrade')
    expect(caps.features).toMatchObject({ xReport: true, zReport: true, fmReportByDate: true, fmReportByNumber: true, programOperator: true, paymentNames: true, cashOnDelivery: true, readOperator: false, operatorReport: false, electronicJournal: false })
    expect(caps.missing).toEqual({ readOperator: 'protocol', operatorReport: 'protocol', electronicJournal: 'protocol' })
    expect(caps.maxOperators).toBe(16)
    expect(caps.cashOnDeliverySlot).toEqual({ code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ' })

    const list = await app.handle(new Request(`http://localhost/org/${w.orgId}/fiscal/device`, {
      headers: { authorization: `Bearer ${await token(w.orgId, 'member')}` },
    }))
    const { fiscalDevices } = await list.json() as any
    expect(fiscalDevices).toHaveLength(1)
    expect(fiscalDevices[0].capabilities.maxOperators).toBe(16)
    expect(fiscalDevices[0].connectionParams).toBeUndefined() // still stripped for a member
  })

  test('Read Status reads the device and marks it online', async () => {
    const w = await world()
    const r = await w.call('GET', '/status', undefined, 'member')
    expect(r.status).toBe(200)
    expect(r.json.deviceStatus).toMatchObject({ connected: true, serialNumber: 'ED123456', fiscalMemoryNumber: '44123456', fiscalized: true, paperPresent: true })
    expect((await FiscalDevice.findById(w.deviceId).lean().exec() as any).status).toBe('online')
  })
})

describe('every report an Eltrade has', () => {
  test('X-report: 45h "2", the day stays open', async () => {
    const w = await world()
    const r = await w.call('POST', '/x-report', undefined, 'warehouse_manager')
    expect(r.status).toBe(200)
    expect(r.json.xReport.reportNumber).toBe('0012')
    expect(w.sim.reports).toEqual([{ cmd: ELTRADE_CMD.DAILY_REPORT, data: '2' }])
    expect(w.sim.closure).toBe(12)
    expect(await audited(w.orgId, 'x_report')).toBeTruthy()
  })

  test('Z-report: 45h "0", the day closes; a warehouse manager may not, and sends nothing', async () => {
    const w = await world()
    const refused = await w.call('POST', '/z-report', undefined, 'warehouse_manager')
    expect(refused.status).toBe(403)
    expect(w.sim.frames).toBe(0)

    const r = await w.call('POST', '/z-report', undefined, 'manager')
    expect(r.status).toBe(200)
    expect(r.json.zReport.reportNumber).toBe('0013')
    expect(w.sim.reports).toEqual([{ cmd: ELTRADE_CMD.DAILY_REPORT, data: '0' }])
    expect(w.sim.closure).toBe(13)
  })

  test('fiscal memory by date: short 4Fh, detailed 5Eh, in the device\'s DDMMYY', async () => {
    const w = await world()
    const short = await w.call('POST', '/fm-report', { type: 'by_date', startDate: '2026-07-01', endDate: '2026-07-31', detailed: false })
    const detailed = await w.call('POST', '/fm-report', { type: 'by_date', startDate: '2026-07-01', endDate: '2026-07-31', detailed: true })
    expect([short.status, detailed.status]).toEqual([200, 200])
    expect(w.sim.reports).toEqual([
      { cmd: ELTRADE_CMD.SHORT_FM_REPORT_BY_DATE, data: '010726,310726' },
      { cmd: ELTRADE_CMD.DETAILED_FM_REPORT_BY_DATE, data: '010726,310726' },
    ])
  })

  test('fiscal memory by number: short 5Fh, detailed 49h, NNNN,NNNN', async () => {
    const w = await world()
    const short = await w.call('POST', '/fm-report', { type: 'by_number', startNumber: 3, endNumber: 12, detailed: false })
    // An emptied-then-typed number field can arrive as a string.
    const detailed = await w.call('POST', '/fm-report', { type: 'by_number', startNumber: '1', endNumber: '12', detailed: true })
    expect([short.status, detailed.status]).toEqual([200, 200])
    expect(w.sim.reports).toEqual([
      { cmd: ELTRADE_CMD.SHORT_FM_REPORT_BY_NUMBER, data: '0003,0012' },
      { cmd: ELTRADE_CMD.DETAILED_FM_REPORT_BY_NUMBER, data: '0001,0012' },
    ])
    expect(await audited(w.orgId, 'fm_report')).toBeTruthy()
  })

  test('a member may print none of them', async () => {
    const w = await world()
    for (const [path, body] of [['/x-report'], ['/z-report'], ['/fm-report', { type: 'by_number', startNumber: 1, endNumber: 2 }]] as const) {
      expect((await w.call('POST', path, body, 'member')).status).toBe(403)
    }
    expect(w.sim.frames).toBe(0)
  })
})

describe('what an Eltrade does not have: 400 with the reason, nothing sent', () => {
  test('reading an operator, the operator report, the electronic journal', async () => {
    const w = await world()
    const read = await w.call('POST', '/read-operator', { operatorNumber: 1 })
    expect(read.status).toBe(400)
    expect(read.json).toMatchObject({ code: 'unsupported', feature: 'readOperator', message: 'Eltrade devices cannot report their operators — program them from the device page.' })
    const opReport = await w.call('POST', '/operator-report', { operatorNumber: 0 })
    expect(opReport.status).toBe(400)
    expect(opReport.json).toMatchObject({ code: 'unsupported', message: 'The Eltrade protocol has no operator report.' })
    const ej = await w.call('POST', '/ej-report', { startDate: '2026-07-01', endDate: '2026-07-31' })
    expect(ej.status).toBe(400)
    expect(ej.json).toMatchObject({ code: 'unsupported', message: 'The Eltrade protocol has no electronic-journal (КЛЕН) print.' })
    expect(w.sim.frames).toBe(0)
  })

  test('a Datecs on a bridge: only the Z-report — the rest is refused before the device is asked', async () => {
    const w = await world({ manufacturer: 'datecs' })
    const sent: unknown[] = []
    registerPrinter(w.deviceId, new WebSocketFiscalPrinter(async (f) => { sent.push(f); return Buffer.alloc(0) }, w.deviceId))
    registered.push(w.deviceId)
    const caps = (await w.call('GET', '')).json.fiscalDevice.capabilities
    expect(caps.driver).toBe('datecs-bridge')
    const x = await w.call('POST', '/x-report')
    expect(x.status).toBe(400)
    expect(x.json.message).toBe("LGR's driver for this Datecs device does not support the X-report yet.")
    for (const [method, path, body] of [
      ['POST', '/fm-report', { type: 'by_date', startDate: '2026-07-01', endDate: '2026-07-31' }],
      ['POST', '/program-operator', { operatorNumber: 1, password: '1234', name: 'Иван' }],
      ['GET', '/payment-names', undefined],
      ['POST', '/payment-names', { code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ' }],
    ] as const) {
      const r = await w.call(method, path, body)
      expect({ path, status: r.status, code: r.json.code }).toEqual({ path, status: 400, code: 'unsupported' })
    }
    expect(sent).toEqual([])
  })

  test('a device LGR cannot open this way at all', async () => {
    const w = await world({ connectionType: 'serial', connected: false })
    const r = await w.call('POST', '/x-report')
    expect(r.status).toBe(400)
    expect(r.json.message).toBe('LGR cannot open an Eltrade device over "serial".')
  })
})

describe('operators 1–16', () => {
  test('programs operator 16 with its name and password; audited', async () => {
    const w = await world()
    const r = await w.call('POST', '/program-operator', { operatorNumber: 16, password: '123456', name: 'Иван, Петров' })
    expect(r.status).toBe(200)
    expect(w.sim.operators[16]).toEqual({ name: 'Иван Петров', password: '123456' })
    expect((await audited(w.orgId, 'program_operator'))?.entityName).toBe('Program operator #16 on Каса 1')
  })

  test('operator 17, a malformed password or an empty name: 400, and nothing reaches the device', async () => {
    const w = await world()
    const bad = [
      [{ operatorNumber: 17, password: '1234', name: 'Иван' }, 'Operators on this device are numbered 1–16.'],
      [{ operatorNumber: 0, password: '1234', name: 'Иван' }, 'Operators on this device are numbered 1–16.'],
      [{ operatorNumber: 2, password: '12ab', name: 'Иван' }, 'Eltrade operator passwords are 4–8 digits'],
      [{ operatorNumber: 2, password: '1234', name: '   ' }, "Enter the operator's name"],
    ] as const
    for (const [body, message] of bad) {
      const r = await w.call('POST', '/program-operator', body)
      expect({ status: r.status, code: r.json.code }).toEqual({ status: 400, code: 'bad_input' })
      expect(r.json.message).toContain(message)
    }
    expect(w.sim.frames).toBe(0)
  })

  test('a wrong password is the device refusing: 409, and the name stays', async () => {
    const w = await world()
    expect((await w.call('POST', '/program-operator', { operatorNumber: 3, password: '1111', name: 'Мария' })).status).toBe(200)
    const r = await w.call('POST', '/program-operator', { operatorNumber: 3, password: '2222', name: 'Друга' })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('device_refused')
    expect(r.json.message).toContain('not allowed in the current state of the device')
    expect(w.sim.operators[3].name).toBe('Мария')
  })

  test('a member cannot program an operator', async () => {
    const w = await world()
    expect((await w.call('POST', '/program-operator', { operatorNumber: 1, password: '1234', name: 'X' }, 'member')).status).toBe(403)
    expect(w.sim.frames).toBe(0)
  })
})

describe('payment types (55h) and cash on delivery', () => {
  test('reads the 11 names, with the LGR payment each slot carries', async () => {
    const w = await world()
    const r = await w.call('GET', '/payment-names', undefined, 'manager')
    expect(r.status).toBe(200)
    expect(r.json.paymentNames.map((p: any) => p.code)).toEqual(['P', 'N', 'C', 'D', 'I', 'J', 'K', 'L', 'M', 'Q', 'R'])
    expect(r.json.paymentNames.at(-1)).toEqual({ code: 'R', name: 'РЕЗЕРВ', type: 'cash_on_delivery' })
  })

  test('an admin names the reserve slot „НАЛОЖЕН ПЛАТЕЖ"; audited with the name it replaced', async () => {
    const w = await world()
    const r = await w.call('POST', '/payment-names', { code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ' })
    expect(r.status).toBe(200)
    expect(r.json.paymentName).toEqual({ code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ', type: 'cash_on_delivery' })
    expect(w.sim.paymentNames.R).toBe('НАЛОЖЕН ПЛАТЕЖ')
    const row = await audited(w.orgId, 'program_payment_name')
    expect(row?.entityName).toBe('Payment type R on Каса 1')
    expect(row?.changes?.map((c: any) => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue })))
      .toEqual([{ field: 'paymentName.R', oldValue: 'РЕЗЕРВ', newValue: 'НАЛОЖЕН ПЛАТЕЖ' }])
  })

  test('only an admin names one: a manager gets 403 and nothing is sent', async () => {
    const w = await world()
    const r = await w.call('POST', '/payment-names', { code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ' }, 'manager')
    expect(r.status).toBe(403)
    expect(w.sim.frames).toBe(0)
    expect(w.sim.paymentNames.R).toBe('РЕЗЕРВ')
  })

  test('a slot that does not exist, a name too long or empty: 400, nothing sent', async () => {
    const w = await world()
    for (const body of [{ code: 'X', name: 'КАРТА' }, { code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ С ДОСТАВКА' }, { code: 'R', name: ' ' }]) {
      const r = await w.call('POST', '/payment-names', body)
      expect({ status: r.status, code: r.json.code }).toEqual({ status: 400, code: 'bad_input' })
    }
    expect(w.sim.frames).toBe(0)
  })
})

describe('validation: a friendly 400, never the schema\'s 422', () => {
  test('the page\'s empty number fields (null), reversed and impossible ranges', async () => {
    const w = await world()
    const cases = [
      [{ type: 'by_number', startNumber: null, endNumber: null, detailed: false }, 'Enter the first and the last Z-report number.'],
      [{ type: 'by_number', startNumber: '', endNumber: 5 }, 'Enter the first and the last Z-report number.'],
      [{ type: 'by_number', startNumber: 12, endNumber: 3 }, 'The first Z-report number (12) is after the last (3).'],
      [{ type: 'by_number', startNumber: 0, endNumber: 3 }, 'Z-report numbers are whole numbers, from 1.'],
      [{ type: 'by_number', startNumber: 1.5, endNumber: 3 }, 'Z-report numbers are whole numbers, from 1.'],
      [{ type: 'by_number', startNumber: 'abc', endNumber: 3 }, 'Z-report numbers are whole numbers, from 1.'],
      [{ type: 'by_number', startNumber: 1, endNumber: 10000 }, 'from 1 to 9999'],
      [{ type: 'by_date', startDate: '', endDate: null }, 'Enter both dates of the period.'],
      [{ type: 'by_date', startDate: 'not-a-date', endDate: '2026-07-31' }, 'A date of the period is not a date.'],
      [{ type: 'by_date', startDate: '2026-07-31', endDate: '2026-07-01' }, 'The period starts after it ends.'],
    ] as const
    for (const [body, message] of cases) {
      const r = await w.call('POST', '/fm-report', body)
      expect({ body, status: r.status, code: r.json?.code }).toEqual({ body, status: 400, code: 'bad_input' })
      expect(r.json.message).toContain(message)
    }
    expect(w.sim.frames).toBe(0)
  })
})

describe('the device\'s own state: 409, 503, 504 — never a blanket 500', () => {
  test('out of paper: every report is the device refusing (409), and the day stays open', async () => {
    const w = await world()
    w.sim.paper = false
    for (const [path, body] of [
      ['/x-report'], ['/z-report'],
      ['/fm-report', { type: 'by_date', startDate: '2026-07-01', endDate: '2026-07-31' }],
      ['/fm-report', { type: 'by_number', startNumber: 1, endNumber: 2, detailed: true }],
    ] as const) {
      const r = await w.call('POST', path, body)
      expect({ path, status: r.status, code: r.json.code }).toEqual({ path, status: 409, code: 'device_refused' })
      expect(r.json.message).toContain('out of paper')
    }
    expect(w.sim.reports).toEqual([])
    expect(w.sim.closure).toBe(12)
  })

  test('a sale in progress: the report is refused (409 receipt_open) and the sale\'s receipt is untouched', async () => {
    const w = await world()
    await w.printer.openFiscalReceipt('0001', 'Оператор', 'ED123456-0001-0000001')
    await w.printer.printSaleLine('Болт М8', 2, 12, 'Б', undefined, 20)
    await w.printer.printPayment('cash', 5)
    for (const path of ['/x-report', '/z-report']) {
      const r = await w.call('POST', path)
      expect({ path, status: r.status, code: r.json.code }).toEqual({ path, status: 409, code: 'receipt_open' })
      expect(r.json.message).toContain('A sale is printing on this device')
    }
    expect(w.sim.receipt).toMatchObject({ sales: [{ text: 'Болт М8', amount: 24 }], payments: [{ mode: 'P', amount: 5 }] })
    expect(w.sim.receipts).toEqual([])
    expect(w.sim.closure).toBe(12)
  })

  test('a sale\'s receipt nothing will finish (the bridge dropped mid-sale): the Z voids it and closes the day', async () => {
    const w = await world()
    // The sale printed through a driver that is gone: a reconnect registers a NEW one, which
    // never opened this receipt.
    const gone = new EltradeFiscalPrinter(w.sim.exchange, w.deviceId)
    await gone.openFiscalReceipt('0001', 'Оператор', 'ED123456-0001-0000001')
    await gone.printSaleLine('Болт М8', 2, 12, 'Б', undefined, 20)
    const r = await w.call('POST', '/z-report', undefined, 'manager')
    expect(r.status).toBe(200)
    expect(r.json.zReport.reportNumber).toBe('0013')
    expect(w.sim.closure).toBe(13)
    expect(w.sim.receipt).toBeNull()
    expect(w.sim.receipts).toEqual([expect.objectContaining({ voided: true, sales: [expect.objectContaining({ text: 'Болт М8' })] })])
  })

  test('a service receipt left open on the device: the X closes it, then prints', async () => {
    const w = await world()
    w.sim.nonFiscalOpen = true
    const r = await w.call('POST', '/x-report')
    expect(r.status).toBe(200)
    expect(r.json.xReport.reportNumber).toBe('0012')
    expect(w.sim.nonFiscalOpen).toBe(false)
    expect(w.sim.reports).toEqual([{ cmd: ELTRADE_CMD.DAILY_REPORT, data: '2' }])
  })

  test('nothing holds the device: 503', async () => {
    const w = await world({ connected: false })
    for (const [path, body] of [['/x-report'], ['/z-report'], ['/sync-time', { confirm: true }], ['/program-operator', { operatorNumber: 1, password: '1234', name: 'X' }]] as const) {
      const r = await w.call('POST', path, body)
      expect({ path, status: r.status, code: r.json.code }).toEqual({ path, status: 503, code: 'not_connected' })
    }
    expect((await w.call('GET', '/payment-names')).status).toBe(503)
  })

  test('a bridge that went away mid-command: 503; a device that never answers: 504', async () => {
    const w = await world({ connected: false })
    registerPrinter(w.deviceId, new EltradeFiscalPrinter(async () => { throw new Error('Fiscal bridge disconnected') }, w.deviceId))
    registered.push(w.deviceId)
    const gone = await w.call('POST', '/x-report')
    expect({ status: gone.status, code: gone.json.code }).toEqual({ status: 503, code: 'not_connected' })

    const silent = await world()
    silent.sim.silent = true
    const r = await silent.call('POST', '/x-report')
    expect({ status: r.status, code: r.json.code }).toEqual({ status: 504, code: 'device_timeout' })
    expect(r.json.message).toContain('main menu')
  })

  test('setting the clock on the Eltrade: unconfirmed is 409 with the device\'s time; confirmed, the device is set', async () => {
    forgetClockVerification() // another file may have verified the server clock
    const w = await world()
    const asked = await w.call('POST', '/sync-time', {}, 'manager')
    expect(asked.status).toBe(409)
    expect(asked.json).toMatchObject({ code: 'clock_unconfirmed', deviceTime: '2026-07-15T09:00:00.000Z' })
    expect(w.sim.executed.some(e => e.cmd === ELTRADE_CMD.SET_DATE_TIME)).toBe(false)

    const set = await w.call('POST', '/sync-time', { confirm: true }, 'manager')
    expect(set.status).toBe(200)
    expect(Math.abs(w.sim.clock.getTime() - Date.now())).toBeLessThan(60_000)
    expect((await w.call('POST', '/sync-time', { confirm: true }, 'warehouse_manager')).status).toBe(403)
  })

  test('an unknown device is 404, before anything else', async () => {
    const w = await world()
    const res = await app.handle(new Request(`http://localhost/org/${w.orgId}/fiscal/device/000000000000000000000000/x-report`, {
      method: 'POST', headers: { authorization: `Bearer ${await token(w.orgId, 'admin')}` },
    }))
    expect(res.status).toBe(404)
  })
})
