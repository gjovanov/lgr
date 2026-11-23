import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'
import type { PriceStep } from './documents'
import type { FiscalCapabilities } from './fiscal-devices'

/**
 * `api/src/invoicing/controllers/pos.controller.ts`, `/org/:orgId/trade/pos`: the till's sessions and its sales.
 *
 * ⚠ What opens a session, rings a sale or closes the day reaches the fiscal device: it is sent with the attempt's
 * `Idempotency-Key` (`headers`), so a retry whose answer never came gets that session, sale or close back, never a
 * second one (#155). A refusal carries its `code` (`ui-shared/cash-register/receipt-refusal` says it).
 */
const BASE = '/trade/pos/session'
type Headers = Record<string, string>

/** A till session as the routes answer it (the repository's entity). */
export interface PosSession {
  _id: string
  id: string
  sessionNumber: string
  warehouseId: string
  cashierId: string
  openedAt: string
  closedAt?: string
  status: string
  openingBalance: number
  currency: string
  totalSales: number
  transactionCount: number
  /** #473: the opening amount on the fiscal device; `pending` until the device has it. */
  deviceFloat?: { state: 'pending' | 'registered'; deviceNumber?: string; error?: string }
  fiscalStatus?: 'closed' | 'skipped' | 'failed'
  zReportNumber?: string
}

export interface PosSessionListParams {
  status?: string
  cashierId?: string
  page?: number
  size?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export async function listPosSessions(params: PosSessionListParams): Promise<ListPage & { sessions: PosSession[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

/** The body of `POST /session`, as its schema declares it. */
export interface PosSessionOpenBody {
  warehouseId: string
  openingBalance: number
  currency: string
}

/** Opens the cashier's session; a retry with its key answers the session it opened. */
export async function openPosSession(body: PosSessionOpenBody, headers: Headers): Promise<{ session: PosSession }> {
  const { data } = await httpClient.post(orgPath(BASE), body, { headers })
  return data
}

/** A line of a till sale, as the sale's schema (`SALE_BODY`) declares it. */
export interface PosSaleLine {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  discount?: number
  taxRate?: number
  taxAmount?: number
  lineTotal: number
  type?: string
  priceExplanation?: PriceStep[]
}

/** The body of `POST /session/:id/transaction`, as its schema declares it. Only a sale is rung up at the till. */
export interface PosSaleBody {
  type: 'sale' | 'return' | 'exchange'
  customerId?: string
  lines: PosSaleLine[]
  subtotal: number
  discountTotal?: number
  taxTotal?: number
  total: number
  payments: Array<{ method: string; amount: number; reference?: string }>
  changeDue?: number
}

/**
 * The sale as the till's POS row (`saleResponse`). `receiptError`: its receipt did not print, and the sale stands;
 * `stockError`: what the stock could not take.
 */
export interface PosSaleAnswer {
  transaction: {
    _id: string
    transactionNumber: string
    total: number
    changeDue?: number
    payments?: Array<{ method: string; amount: number }>
    fiscalReceiptNumber?: string
    unpNumber?: string
    fiscal?: { state?: string; mode?: string }
  }
  receiptError?: string
  stockError?: string
}

export async function ringUpSale(sessionId: string, body: PosSaleBody, headers: Headers): Promise<PosSaleAnswer> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${sessionId}/transaction`), body, { headers })
  return data
}

/** `services/biz/cash-register/session-report.ts#SessionReport`: the session's figures, as its report prints them. */
export interface SessionReport {
  sessionNumber: string
  currency: string
  counts: { sales: number; stornos: number; voided: number; fiscal: number; text: number; unprinted: number; payments?: number }
  vat: Array<{ rate: number; net: number; vat: number; gross: number }>
  total: number
  byMethod: { cash: number; card: number; other: number; cashOnDelivery?: number }
  change: number
  drawer: { opening: number; onDevice?: boolean; expected?: number; counted?: number; difference?: number }
  documents?: { first: string; last: string }
  receipts?: { first: string; last: string }
  zReportNumber?: string
  amounts?: { fiscal: number; text: number; unprinted: number }
  deviceZ?: { fmTotal?: number; turnover: Array<{ group: string; amount: number }> }
}

/** A receipt or a document that stands in the close's way, named. */
export interface UnfinishedReceipt { id: string; number?: string; invoice?: string }

/** What the close will find: what is expected per method, the report so far, and what stands in its way. */
export interface ClosePreview {
  expected: Record<string, number>
  currency: string
  report: SessionReport
  openSessionsOnWarehouse: number
  unfinishedReceipts: UnfinishedReceipt[]
  deadSales: Array<{ id: string; number: string | null; settles: boolean }>
  deadDocuments: UnfinishedReceipt[]
  fiscalDevice: { id: string; name: string; deviceNumber: string; connected: boolean } | null
}

export async function getClosePreview(sessionId: string): Promise<ClosePreview> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${sessionId}/close-preview`))
  return data
}

/** The body of `POST /session/:id/close`, as its schema declares it (`closingBalance` is the legacy form). */
export interface PosSessionCloseBody {
  closingBalance?: number
  counted?: { cash: number; card?: number; other?: number }
  notes?: string
  closeWithoutFiscal?: boolean
}

/**
 * The close: the Z-report first, and the session closed only once the device confirms (FR-9.3). `reportError`: the
 * session's report did not print after it.
 */
export interface PosSessionClosed {
  session: PosSession
  fiscalStatus: 'closed' | 'skipped'
  zReportNumber?: string
  report: SessionReport
  reportError?: string
}

export async function closePosSession(sessionId: string, body: PosSessionCloseBody, headers: Headers): Promise<PosSessionClosed> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${sessionId}/close`), body, { headers })
  return data
}

/** The report its close printed, or, while it is open, its figures so far. */
export async function getSessionReport(sessionId: string): Promise<{ report: SessionReport; printedAt: string | null; error: string | null }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${sessionId}/report`))
  return data
}

/** Prints the session's report again, on its warehouse's device. Sent no body. */
export async function printSessionReport(sessionId: string): Promise<{ printed: true }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${sessionId}/report/print`))
  return data
}

/** The device a session's reports print on, and what of the session they leave out (its text receipts). */
export interface SessionDeviceReport {
  notOnDevice: { receipts: number; amount: number | null; currency: string } | null
  device: {
    id: string; name: string; deviceNumber: string; connected: boolean
    capabilities: FiscalCapabilities
  } | null
}

export async function getSessionDeviceReport(sessionId: string): Promise<SessionDeviceReport> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${sessionId}/device-report`))
  return data
}

/** The body of `POST /session/:id/device-report`, as its schema declares it. A field left empty is sent null. */
export interface SessionDeviceReportBody {
  kind: 'x' | 'fm_date' | 'fm_number' | 'ej' | 'operator'
  startDate?: string | null
  endDate?: string | null
  startNumber?: number | string | null
  endNumber?: number | string | null
  detailed?: boolean | null
  operatorNumber?: number
}

/** A report on the session's device: an X while it is open, the fiscal memory, the journal, an operator's. No Z. */
export async function printSessionDeviceReport(sessionId: string, body: SessionDeviceReportBody): Promise<{ message: string }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${sessionId}/device-report`), body)
  return data
}
