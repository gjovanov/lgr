import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'
import type { InvoiceDocument } from './documents'

/**
 * `api/src/invoicing/controllers/receipt-bill.controller.ts`, `/org/:orgId/invoicing/bills`: the supplier's bill for
 * goods already received (FR-22.31, FR-22.32). The rules are `services/biz/receipt-bill.service.ts`; receiving, voiding
 * and editing such a bill stay on `./documents`. A refusal carries its `code` (and what it is about).
 */
const BASE = '/invoicing/bills'

/** A goods receipt no bill holds yet, as the list answers it. */
export interface BillableReceipt {
  id: string
  number: string
  date: string
  lineCount: number
  total: number
  /** It names no supplier, and takes the bill's (FR-22.31a). */
  noSupplier?: boolean
  /** Its notes, when it names no supplier: all there is to tell whose goods they were. */
  notes?: string
}

/** The supplier's unbilled receipts, then the unbilled ones that name no supplier. No supplier is a 422. */
export async function listBillableReceipts(contactId: string): Promise<{ receipts: BillableReceipt[] }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/billable-receipts`), { params: { contactId } })
  return data
}

/** The body of `POST /from-receipt`, as its schema declares it: what the form had typed about the bill so far. */
export interface BillFromReceiptBody {
  movementIds: string[]
  /** The supplier; required for a receipt that names none. */
  contactId?: string
  currency?: string
  reference?: string
  issueDate?: string
  dueDate?: string
  notes?: string
  paymentMethod?: string
}

/** A draft bill made from the receipts, linked, so it moves no stock. */
export async function billFromReceipt(body: BillFromReceiptBody): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/from-receipt`), body)
  return data
}

/** The body of `POST /:id/link-receipts`, as its schema declares it. */
export interface LinkReceiptsBody {
  movementIds: string[]
  /** A bill with lines is linked only when this says the receipts' lines may take their place. */
  replaceLines?: boolean
  contactId?: string
}

export async function linkReceipts(billId: string, body: LinkReceiptsBody): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${billId}/link-receipts`), body)
  return data
}
