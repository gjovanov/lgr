import { httpClient } from 'ui-shared/composables/useHttpClient'
import type { ClockHeld } from 'config/fiscal-clock'
import { orgPath, type ListPage } from './org-path'

/**
 * `api/src/controllers/fiscal-device.controller.ts`, `/org/:orgId/fiscal/device`: the org's fiscal devices.
 *
 * ⚠ A report, an operator or a payment name is a command to the device (FR-24.50: the route runs where the device is
 * held). Each sends exactly the body its schema declares; the Z-report also runs through a session's close.
 */
const BASE = '/fiscal/device'

export type FiscalManufacturer = 'datecs' | 'daisy' | 'tremol' | 'eltrade' | 'incotex'
export type FiscalConnectionType = 'serial' | 'tcp' | 'usb' | 'browser' | 'desktop'

/** Where a device is reached. Only someone who runs the devices is sent them (`sanitizeDevice`). */
export interface FiscalConnectionParams {
  port?: string
  baudRate?: number
  ip?: string
  tcpPort?: number
  usbPath?: string
  bridgeDesktopId?: string
}

/** What a device's driver can do (`fiscal/capabilities#FiscalCapabilities`), from its manufacturer and connection. */
export interface FiscalCapabilities {
  /** The driver that serves the device, or null when LGR cannot open it this way. */
  driver: string | null
  features: Record<string, boolean>
  /** Why each feature that is off is off. */
  missing: Record<string, 'protocol' | 'driver' | 'no_driver'>
  /** Operators are numbered 1..maxOperators; 0 when they cannot be programmed. */
  maxOperators: number
  /** The payment slot cash on delivery prints in, and the name the device page gives it. */
  cashOnDeliverySlot?: { code: string; name: string }
}

/** A fiscal device as the routes answer it (the repository's entity). */
export interface FiscalDevice {
  _id: string
  id: string
  deviceNumber: string
  name: string
  manufacturer: FiscalManufacturer
  connectionType: FiscalConnectionType
  connectionParams?: FiscalConnectionParams
  warehouseId: string
  status: string
  isActive: boolean
  capabilities: FiscalCapabilities
  /** #450: a clock step the server would not take alone. */
  clockHeld?: ClockHeld | null
}

/** A row of the list: and whether a bridge holds it right now, and through which till. */
export interface FiscalDeviceRow extends FiscalDevice {
  connected: boolean
  bridgedBy?: string
  /** What its status last said (FR-23). */
  fiscalized?: boolean
}

export interface FiscalDeviceListParams {
  /** `'true'` or `'false'`: the route compares the text. */
  isActive?: 'true' | 'false'
  warehouseId?: string
  page?: number
  /** 0 is every device. */
  size?: number
}

export async function listFiscalDevices(params: FiscalDeviceListParams): Promise<ListPage & { fiscalDevices: FiscalDeviceRow[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

/** A missing device is a 404. */
export async function getFiscalDevice(id: string): Promise<{ fiscalDevice: FiscalDevice }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

/** The body of `POST /`, as its schema declares it. */
export interface FiscalDeviceCreateBody {
  deviceNumber: string
  name: string
  manufacturer: FiscalManufacturer
  connectionType: FiscalConnectionType
  connectionParams?: FiscalConnectionParams
  /** Required: the model's, so a device's warehouse is never `null` (422). */
  warehouseId: string
  workstationId?: string
  /** The form's Active switch; unsaid, the device is active. */
  isActive?: boolean
}

export async function createFiscalDevice(body: FiscalDeviceCreateBody): Promise<{ fiscalDevice: FiscalDevice }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

/**
 * The body of `PUT /:id`, as its schema declares it. ⚠ A field it does not name is dropped, and the route answers 200.
 * No `deviceNumber`: it is fixed once the device is created, and the route refuses a different one (422
 * `device_number_immutable`).
 */
export interface FiscalDeviceUpdateBody {
  name?: string
  manufacturer?: FiscalManufacturer
  connectionType?: FiscalConnectionType
  connectionParams?: FiscalConnectionParams
  warehouseId?: string
  workstationId?: string
  isActive?: boolean
  /** The model's enum. ⚠ `error` stops sales on a device no bridge holds (503) until it is cleared. */
  status?: FiscalDeviceStatus
}

/** A device's stored status (`db/models/fiscal-device.model`): the last thing its bridge, or a page, recorded. */
export type FiscalDeviceStatus = 'online' | 'offline' | 'error'

export async function updateFiscalDevice(id: string, body: FiscalDeviceUpdateBody): Promise<{ fiscalDevice: FiscalDevice }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/**
 * The status a page saw, written for the device list (a courtesy: the bridge records online and offline on its own).
 * The PUT stores it (it was dropped with a 200 until FR-32.24 found it, §11), for whoever holds `devices.edit`.
 */
export async function recordFiscalDeviceStatus(id: string, status: FiscalDeviceStatus): Promise<{ fiscalDevice: FiscalDevice }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), { status })
  return data
}

/** The device's own status, read from it. */
export async function readFiscalDeviceStatus(id: string): Promise<{ deviceStatus: Record<string, unknown> }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}/status`))
  return data
}

/** #450: sets the device's clock from the verified time. A step it will not take alone is a 409 `clock_unconfirmed`. */
export async function syncFiscalDeviceTime(id: string, body: { confirm?: boolean }): Promise<{ message: string; serverTime: string; stepMs: number; verified: boolean }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/sync-time`), body)
  return data
}

/** An X-report: the day as it stands. Sent no body. */
export async function printXReport(id: string): Promise<{ message: string }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/x-report`))
  return data
}

/** A Z-report. With sessions open on its warehouse, a 409 `sessions_open` names them until `confirmed`. */
export async function printZReport(id: string, body: { confirmed?: boolean }): Promise<{ zReport: unknown }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/z-report`), body)
  return data
}

export async function printOperatorReport(id: string, body: { operatorNumber?: number }): Promise<{ message: string }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/operator-report`), body)
  return data
}

/** The body of `POST /:id/fm-report`, as its schema declares it. A field left empty is sent as the page holds it. */
export interface FmReportBody {
  type: 'by_date' | 'by_number'
  startDate?: string | null
  endDate?: string | null
  startNumber?: number | string | null
  endNumber?: number | string | null
  detailed?: boolean | null
}

export async function printFmReport(id: string, body: FmReportBody): Promise<{ message: string }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/fm-report`), body)
  return data
}

export async function printEjReport(id: string, body: { startDate?: string | null; endDate?: string | null }): Promise<{ message: string }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/ej-report`), body)
  return data
}

/** ⚠ On an Eltrade the password authenticates the change: three wrong ones lock the device. */
export async function programOperator(id: string, body: { operatorNumber: number; name: string; password: string }): Promise<{ message: string }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/program-operator`), body)
  return data
}

export async function readOperator(id: string, body: { operatorNumber: number }): Promise<{ operator: { name?: string; password?: string } }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/read-operator`), body)
  return data
}

/** A payment slot and the name the device prints for it (Eltrade 55h). */
export interface PaymentName { code: string; name: string }

export async function readPaymentNames(id: string): Promise<{ paymentNames: PaymentName[] }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}/payment-names`))
  return data
}

/** ⚠ Admin only: the name prints on every receipt paid through the slot. */
export async function namePaymentSlot(id: string, body: PaymentName): Promise<{ paymentName: PaymentName }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/payment-names`), body)
  return data
}
