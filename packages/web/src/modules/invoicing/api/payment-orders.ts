import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** `api/src/invoicing/controllers/payment-order.controller.ts`, `/org/:orgId/invoicing/payment-order`. */
const BASE = '/invoicing/payment-order'

/** A payment order as the routes answer it (the repository's entity). The model's type is `payment` or `receipt`. */
export interface PaymentOrder {
  _id: string
  id: string
  orderNumber: string
  type: 'payment' | 'receipt'
  date?: string
  contactId: string
  bankAccountId?: string
  amount: number
  currency: string
  exchangeRate: number
  invoiceIds: string[]
  reference?: string
  description?: string
  status: string
  executedAt?: string
}

/**
 * The body of `POST /` and `PUT /:id`. Their schemas take any object (`clientCreate` / `clientUpdate` then hold it to
 * the model, FR-32.18): these are the fields the form sends. The route maps the form's `outgoing` / `incoming` to the
 * model's `payment` / `receipt` (`mapPaymentOrderBody`). A bank account left empty is not sent.
 */
export interface PaymentOrderBody {
  contactId: string
  type: string
  bankAccountId?: string
  date?: string
  amount: number
  reference?: string
  description?: string
  invoiceIds?: string[]
}

export async function createPaymentOrder(body: PaymentOrderBody): Promise<{ paymentOrder: PaymentOrder }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

export async function updatePaymentOrder(id: string, body: PaymentOrderBody): Promise<{ paymentOrder: PaymentOrder }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** A 400 when it is executed already. */
export async function executePaymentOrder(id: string): Promise<{ paymentOrder: PaymentOrder }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/execute`))
  return data
}
