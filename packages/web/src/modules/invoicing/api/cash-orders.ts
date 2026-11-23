import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** `invoicing-api/src/controllers/cash-order.controller.ts`, `/org/:orgId/invoicing/cash-order`. */
const BASE = '/invoicing/cash-order'

/** A cash order as the routes answer it (the repository's entity). */
export interface CashOrder {
  _id: string
  id: string
  orderNumber: string
  type: 'receipt' | 'disbursement'
  date?: string
  party?: string
  contactId?: string
  amount: number
  currency: string
  description?: string
  accountId?: string
  counterAccountId?: string
}

/**
 * The body of `POST /` and `PUT /:id`. Their schemas take any object (`clientCreate` / `clientUpdate` then hold it to
 * the model, FR-32.18): these are the model's fields the form sends. An account left empty is not sent.
 */
export interface CashOrderBody {
  type: string
  party?: string
  date?: string
  amount: number
  accountId?: string
  counterAccountId?: string
  description?: string
}

export async function createCashOrder(body: CashOrderBody): Promise<{ cashOrder: CashOrder }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

export async function updateCashOrder(id: string, body: CashOrderBody): Promise<{ cashOrder: CashOrder }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

export async function deleteCashOrder(id: string): Promise<{ success: true }> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}
