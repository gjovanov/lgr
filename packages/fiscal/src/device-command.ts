/**
 * One command on a fiscal device, as an API answers it, and the reports a person prints on a device.
 *
 * Two pages print them: the device page (`portal-api/fiscal-device.controller.ts`) and POS Sessions
 * (`invoicing-api/pos.controller.ts`, the device a session printed on). They live here because
 * `portal-api` imports `invoicing-api`, never the other way round, and a report asked for on either
 * page must reach the driver, and be refused, in the same way.
 *
 * ⚠ There is no Z-report here on purpose. On the device page it is its own route, for an admin or a
 * manager; from POS Sessions it does not exist: a Z runs only through a session's close, and one run
 * outside it makes the next close print zeros.
 */
import { getPrinter, isDeviceConnected } from './fiscal-device.service.js'
import { FEATURE_METHODS, fiscalCapabilities, unsupportedReason, type FiscalFeature } from './capabilities.js'
import { fiscalFailure } from './errors.js'
import type { IFiscalPrinter } from './types.js'

/** Who runs a device: its connection, its operators and its reports. */
export const FISCAL_ADMIN_ROLES = ['admin', 'manager', 'warehouse_manager']

export type Status = (code: number, body: Record<string, unknown>) => any
export type DeviceRow = { id: string; name?: string; manufacturer: string; connectionType: string }

/** Who opens a device's port, so a refusal can say what to do about it. */
const NOT_CONNECTED_HINT: Record<string, string> = {
  browser: 'connect it from the POS (Connect Printer) or from this device page, in Chrome or Edge',
  desktop: 'it connects through its LGR Desktop, which is not running or cannot reach the server',
  tcp: 'the server has not opened it yet: connect it first',
}

export interface OnDeviceOptions {
  feature?: FiscalFeature
  check?: () => string | null
  /** How the route answers for a device nothing holds; 503 `not_connected` unless it says otherwise. */
  notConnected?: (message: string) => unknown
}

/**
 * One command on a device, answered. Refused before anything is sent when the device cannot do
 * `feature` at all (400 `unsupported`, with the reason the device page shows), when `check` finds
 * the request's data wrong (400 `bad_input`) or when nothing holds the device (503). A driver's
 * failure is answered by what it was (`fiscal/errors`) — bad input 400, the device refusing 409,
 * no answer 504 — where these endpoints used to answer 500 to everything.
 */
export async function onDevice(
  status: Status,
  device: DeviceRow,
  what: string,
  opts: OnDeviceOptions,
  run: (printer: IFiscalPrinter) => Promise<unknown>,
) {
  if (opts.feature) {
    const reason = unsupportedReason(device.manufacturer, device.connectionType, opts.feature)
    if (reason) return status(400, { code: 'unsupported', feature: opts.feature, message: reason })
  }
  const bad = opts.check?.()
  if (bad) return status(400, { code: 'bad_input', message: bad })
  if (!isDeviceConnected(device.id)) {
    const message = `${what}: the device is not connected — ${NOT_CONNECTED_HINT[device.connectionType] ?? 'connect it first'}.`
    return opts.notConnected ? opts.notConnected(message) : status(503, { code: 'not_connected', message })
  }
  try {
    const printer = getPrinter(device.id)
    // The live driver is the last word: one registered under another manufacturer's row lacks it.
    const methods = opts.feature && opts.feature !== 'cashOnDelivery' ? FEATURE_METHODS[opts.feature] : []
    if (methods.some(m => typeof (printer as any)[m] !== 'function')) {
      return status(400, { code: 'unsupported', feature: opts.feature, message: `${what} is not supported by this device's driver.` })
    }
    return await run(printer)
  } catch (e) {
    const failure = fiscalFailure(e)
    return status(failure.status, { code: failure.code, message: `${what} failed: ${failure.message}` })
  }
}

/** A field a page leaves `null` (or `''`) when it is empty. */
const given = (v: unknown) => v !== null && v !== undefined && v !== ''

function periodError(start: unknown, end: unknown): string | null {
  if (!given(start) || !given(end)) return 'Enter both dates of the period.'
  const [a, b] = [new Date(String(start)), new Date(String(end))]
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return 'A date of the period is not a date.'
  if (a.getTime() > b.getTime()) return 'The period starts after it ends.'
  return null
}

function zNumbersError(start: unknown, end: unknown): string | null {
  if (!given(start) || !given(end)) return 'Enter the first and the last Z-report number.'
  const [a, b] = [Number(start), Number(end)]
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) return 'Z-report numbers are whole numbers, from 1.'
  if (a > b) return `The first Z-report number (${a}) is after the last (${b}).`
  return null
}

export const DEVICE_REPORT_KINDS = ['x', 'fm_date', 'fm_number', 'ej', 'operator'] as const
export type DeviceReportKind = typeof DEVICE_REPORT_KINDS[number]

/** A report and what it reads. A page sends `null` (or `''`) for a field left empty. */
export interface DeviceReportRequest {
  kind: DeviceReportKind
  /** `fm_date`, `ej`. */
  startDate?: string | null
  endDate?: string | null
  /** `fm_number`: the first and the last Z-report. */
  startNumber?: number | string | null
  endNumber?: number | string | null
  /** `fm_date`, `fm_number`. */
  detailed?: boolean | null
  /** `operator`: 0, or none, is every operator. */
  operatorNumber?: number
}

export interface DeviceReportOptions {
  /** Written once the report has printed, under the route's own entity. */
  audit: (action: string, entityName: string) => void
  notConnected?: OnDeviceOptions['notConnected']
}

/** Print one report on a device, answered as `onDevice` answers. */
export function printDeviceReport(status: Status, device: DeviceRow, report: DeviceReportRequest, opts: DeviceReportOptions) {
  const on = (what: string, spec: Pick<OnDeviceOptions, 'feature' | 'check'>, run: (printer: IFiscalPrinter) => Promise<unknown>) =>
    onDevice(status, device, what, { ...spec, notConnected: opts.notConnected }, run)

  switch (report.kind) {
    case 'x':
      return on('X-Report', { feature: 'xReport' }, async (printer) => {
        const result = await printer.printDailyXReport!()
        opts.audit('x_report', `X-Report on ${device.name}`)
        return { xReport: result }
      })
    case 'operator': {
      const max = fiscalCapabilities(device.manufacturer, device.connectionType).maxOperators
      const n = report.operatorNumber
      return on('Operator report', {
        feature: 'operatorReport',
        check: () => (n === undefined || (Number.isInteger(n) && n >= 0 && n <= max) ? null : `Operators on this device are numbered 1–${max} (0 is all of them).`),
      }, async (printer) => {
        await printer.printOperatorReport!(n)
        opts.audit('operator_report', `Operator report on ${device.name}`)
        return { message: 'Operator report printed' }
      })
    }
    case 'fm_date':
      return on('FM report', {
        feature: 'fmReportByDate',
        check: () => periodError(report.startDate, report.endDate),
      }, async (printer) => {
        await printer.printFiscalMemoryReportByDate!(new Date(String(report.startDate)), new Date(String(report.endDate)), !!report.detailed)
        opts.audit('fm_report', `FM report (by_date) on ${device.name}`)
        return { message: 'Fiscal memory report printed' }
      })
    case 'fm_number':
      return on('FM report', {
        feature: 'fmReportByNumber',
        check: () => zNumbersError(report.startNumber, report.endNumber),
      }, async (printer) => {
        await printer.printFiscalMemoryReportByNumber!(Number(report.startNumber), Number(report.endNumber), !!report.detailed)
        opts.audit('fm_report', `FM report (by_number) on ${device.name}`)
        return { message: 'Fiscal memory report printed' }
      })
    case 'ej':
      return on('EJ report', {
        feature: 'electronicJournal',
        check: () => periodError(report.startDate, report.endDate),
      }, async (printer) => {
        await printer.printEJReport!(new Date(String(report.startDate)), new Date(String(report.endDate)))
        opts.audit('ej_report', `EJ report on ${device.name}`)
        return { message: 'Electronic journal report printed' }
      })
  }
}
