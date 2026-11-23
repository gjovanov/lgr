import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'
import type { InvoiceDocument } from './documents'
import type { OverlappingDispatch } from '../composables/document-issue'

/**
 * `invoicing-api/src/controllers/dispatch-invoice.controller.ts`, `/org/:orgId/invoicing/sales`: the customer's invoice
 * for goods a stock note already delivered (FR-22.61, FR-22.62), the sales twin of `./bills`. Linking an invoice to its
 * notes, and the question asked before an issue, are `./issue`. A refusal carries its `code`.
 */
const BASE = '/invoicing/sales'

/** The customer's uninvoiced stock notes, then the uninvoiced ones that name no customer. No customer is a 422. */
export async function listInvoiceableDispatches(contactId: string): Promise<{ dispatches: OverlappingDispatch[] }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/invoiceable-dispatches`), { params: { contactId } })
  return data
}

/** The body of `POST /from-dispatch`, as its schema declares it: what the form had typed about the invoice so far. */
export interface SaleFromDispatchBody {
  movementIds: string[]
  /** The customer; required for a note that names none. */
  contactId?: string
  /** „Словом" is written in this language, as the invoice form writes it. */
  locale?: string
  currency?: string
  issueDate?: string
  dueDate?: string
  notes?: string
  paymentMethod?: string
}

/** A draft invoice made from the notes, linked, each line at that customer's price. */
export async function saleFromDispatch(body: SaleFromDispatchBody): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/from-dispatch`), body)
  return data
}
