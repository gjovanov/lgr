import { describe, it, expect } from 'bun:test'
import { captureRejection } from '../helpers/capture-rejection'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import {
  FEATURE_METHODS,
  FISCAL_FEATURES,
  fiscalCapabilities,
  fiscalDriverFor,
  unsupportedReason,
  type FiscalDriver,
} from 'fiscal/capabilities'
import { fiscalFailure, FiscalNotConnectedError } from 'fiscal/errors'
import { EltradeError, EltradeFiscalPrinter, ELTRADE_MAX_OPERATORS } from 'fiscal/eltrade'
import { DatecsFiscalPrinter } from 'fiscal/datecs'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { FiscalUnsupportedError } from 'fiscal/types'
import { createPrinter, getPrinter } from 'fiscal/fiscal-device.service'
import { createBridgePrinter } from '../../../portal-api/src/websocket/fiscal-bridge'

/**
 * The capability table (`fiscal/capabilities.ts`) is what the device page believes before it
 * offers a button. These tests keep it honest: a feature is on exactly when the driver class has
 * the methods behind it, and each manufacturer × connection resolves to the class the server's
 * and the bridge's factories really build.
 */

const CLASSES: Record<FiscalDriver, { prototype: object; name: string }> = {
  eltrade: EltradeFiscalPrinter,
  datecs: DatecsFiscalPrinter,
  'datecs-bridge': WebSocketFiscalPrinter,
  'tremol-bridge': WsTremolFiscalPrinter,
}

/** A manufacturer and connection that each driver serves. */
const SERVES: Record<FiscalDriver, [string, string]> = {
  eltrade: ['eltrade', 'browser'],
  datecs: ['datecs', 'tcp'],
  'datecs-bridge': ['datecs', 'browser'],
  'tremol-bridge': ['tremol', 'browser'],
}

const MANUFACTURERS = ['datecs', 'daisy', 'tremol', 'eltrade', 'incotex']
const CONNECTIONS = ['serial', 'tcp', 'usb', 'browser', 'desktop']

describe('fiscal capabilities — in step with the driver classes', () => {
  for (const driver of Object.keys(CLASSES) as FiscalDriver[]) {
    it(`${driver}: a feature is on exactly when ${CLASSES[driver].name} has its methods`, () => {
      const [manufacturer, connection] = SERVES[driver]
      const caps = fiscalCapabilities(manufacturer, connection)
      expect(caps.driver).toBe(driver)
      for (const [feature, methods] of Object.entries(FEATURE_METHODS)) {
        const has = methods.every(m => typeof (CLASSES[driver].prototype as any)[m] === 'function')
        expect({ feature, on: caps.features[feature as keyof typeof FEATURE_METHODS] }).toEqual({ feature, on: has })
      }
      // Every feature that is off says why; none that is on does.
      for (const f of FISCAL_FEATURES) expect(!!caps.missing[f]).toBe(!caps.features[f])
    })
  }

  it('every manufacturer × connection names the class its factory builds (or none, where the server refuses)', () => {
    const send = async () => Buffer.alloc(0)
    for (const m of MANUFACTURERS) {
      for (const c of CONNECTIONS) {
        const bridged = c === 'browser' || c === 'desktop'
        let built: object | null = null
        try {
          built = bridged
            ? createBridgePrinter(m, send, 'caps-test')
            : createPrinter(m, { type: c as any, tcp: { ip: '127.0.0.1', port: 1 }, serial: { port: 'COM99', baudRate: 115200 }, usb: { path: '/dev/null' } }, 'caps-test')
        } catch {
          built = null
        }
        const driver = fiscalDriverFor(m, c)
        expect({ m, c, driver: driver && CLASSES[driver].name }).toEqual({ m, c, driver: built ? built.constructor.name : null })
        expect(fiscalCapabilities(m, c).driver).toBe(driver)
      }
    }
  })

  it('cash on delivery is on only for a driver with a payment slot for it', async () => {
    // On: the Eltrade prints it in the reserve slot.
    const sim = new EltradeSimulator()
    const eltrade = new EltradeFiscalPrinter(sim.exchange, 'caps-eltrade')
    await eltrade.openFiscalReceipt('0001', 'Op', 'ED123456-0001-0000001')
    await eltrade.printSaleLine('A', 1, 5, 'Б', undefined, 20)
    await eltrade.printPayment('cash_on_delivery', 5)
    expect(sim.receipt!.payments).toEqual([{ mode: 'R', amount: 5 }])
    expect(fiscalCapabilities('eltrade', 'tcp').features.cashOnDelivery).toBe(true)
    // The slot the page names is the slot the driver prints in, and the operators it offers are the driver's.
    expect(fiscalCapabilities('eltrade', 'tcp').cashOnDeliverySlot!.code).toBe(sim.receipt!.payments[0].mode)
    expect(fiscalCapabilities('eltrade', 'tcp').maxOperators).toBe(ELTRADE_MAX_OPERATORS)

    // Off: refused before a byte is sent.
    const sent: unknown[] = []
    const send = async (frame: Buffer) => { sent.push(frame); return Buffer.alloc(0) }
    const datecs = new DatecsFiscalPrinter({ type: 'tcp', tcp: { ip: '127.0.0.1', port: 1 } }, 'caps-datecs')
    ;(datecs as any).transport.sendCommand = async (...a: unknown[]) => { sent.push(a); return '' }
    const off: [FiscalDriver, { printPayment: (t: any, a: number) => Promise<void> }][] = [
      ['datecs', datecs],
      ['datecs-bridge', new WebSocketFiscalPrinter(send, 'caps-ws')],
      ['tremol-bridge', new WsTremolFiscalPrinter(send, 'caps-tremol')],
    ]
    for (const [driver, printer] of off) {
      const [m, c] = SERVES[driver]
      expect(fiscalCapabilities(m, c).features.cashOnDelivery).toBe(false)
      expect((await captureRejection(printer.printPayment('cash_on_delivery', 5)))?.name).toBe('FiscalUnsupportedError')
    }
    expect(sent).toEqual([])
  })
})

describe('fiscal capabilities — what the device page is told', () => {
  it('an Eltrade: X, Z and the fiscal-memory reports, 16 operators programmed but never read, COD in slot R', () => {
    for (const connection of ['browser', 'desktop', 'tcp']) {
      const caps = fiscalCapabilities('eltrade', connection)
      expect(caps.features).toMatchObject({
        zReport: true, xReport: true, fmReportByDate: true, fmReportByNumber: true, programOperator: true,
        textReceipt: true, paymentNames: true, cashOnDelivery: true,
        operatorReport: false, electronicJournal: false, readOperator: false,
      })
      expect(caps.missing).toEqual({ operatorReport: 'protocol', electronicJournal: 'protocol', readOperator: 'protocol' })
      expect(caps.maxOperators).toBe(16)
      expect(caps.cashOnDeliverySlot).toEqual({ code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ' })
    }
    expect(unsupportedReason('eltrade', 'browser', 'readOperator')).toBe('Eltrade devices cannot report their operators — program them from the device page.')
    expect(unsupportedReason('eltrade', 'browser', 'operatorReport')).toBe('The Eltrade protocol has no operator report.')
    expect(unsupportedReason('eltrade', 'browser', 'electronicJournal')).toBe('The Eltrade protocol has no electronic-journal (КЛЕН) print.')
    expect(unsupportedReason('eltrade', 'browser', 'xReport')).toBeNull()
  })

  it('a Datecs or Daisy: the Z-report only, the rest not in LGR\'s driver yet', () => {
    for (const m of ['datecs', 'daisy']) {
      for (const c of ['browser', 'tcp']) {
        const caps = fiscalCapabilities(m, c)
        expect(FISCAL_FEATURES.filter(f => caps.features[f])).toEqual(['zReport'])
        expect(new Set(Object.values(caps.missing))).toEqual(new Set(['driver']))
        expect(caps.maxOperators).toBe(0)
      }
    }
    expect(unsupportedReason('daisy', 'browser', 'xReport')).toBe("LGR's driver for this Daisy device does not support the X-report yet.")
  })

  it('a device LGR cannot open this way: nothing, and says so', () => {
    const caps = fiscalCapabilities('eltrade', 'serial')
    expect(caps.driver).toBeNull()
    expect(FISCAL_FEATURES.some(f => caps.features[f])).toBe(false)
    expect(unsupportedReason('eltrade', 'serial', 'zReport')).toBe('LGR cannot open an Eltrade device over "serial".')
    expect(fiscalCapabilities('nonesuch', 'tcp').driver).toBeNull()
  })

  it('a copy every time: a caller editing its answer cannot change the table', () => {
    const a = fiscalCapabilities('eltrade', 'tcp')
    a.features.readOperator = true
    a.cashOnDeliverySlot!.code = 'P'
    const b = fiscalCapabilities('eltrade', 'tcp')
    expect(b.features.readOperator).toBe(false)
    expect(b.cashOnDeliverySlot!.code).toBe('R')
  })
})

describe('fiscalFailure — a driver error as an HTTP answer', () => {
  it('maps every Eltrade error kind', () => {
    const kinds = {
      input: [400, 'bad_input'], busy: [409, 'receipt_open'], rejected: [409, 'device_refused'],
      protocol: [502, 'device_protocol'], unreachable: [503, 'not_connected'], timeout: [504, 'device_timeout'],
    } as const
    for (const [kind, [status, code]] of Object.entries(kinds)) {
      expect(fiscalFailure(new EltradeError('x', kind as any))).toEqual({ status, code, message: 'x' })
    }
  })

  it('a device nothing holds, an unsupported payment, and the older drivers\' plain errors', () => {
    let notConnected: unknown
    try { getPrinter('no-such-device') } catch (e) { notConnected = e }
    expect(notConnected).toBeInstanceOf(FiscalNotConnectedError)
    expect(fiscalFailure(notConnected)).toMatchObject({ status: 503, code: 'not_connected' })
    expect(fiscalFailure(new FiscalUnsupportedError('no slot'))).toMatchObject({ status: 400, code: 'unsupported' })
    expect(fiscalFailure(new Error('Fiscal device timeout'))).toMatchObject({ status: 504, code: 'device_timeout' })
    expect(fiscalFailure(new Error('Fiscal bridge disconnected'))).toMatchObject({ status: 503, code: 'not_connected' })
    expect(fiscalFailure(new Error('Invalid Datecs response: missing frame delimiters'))).toMatchObject({ status: 500, code: 'device_error' })
  })
})
