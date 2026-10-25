import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

/**
 * What „Преобразувай във фактура" says, on the client order and the supplier order alike.
 *
 * Convert invoices only what can be dispatched now (FR-22.5): a reservation on a supplier order
 * counts only up to what that order has delivered. The rest stays reserved, and the API names
 * it (`waiting`) — said here, or an invoice short of the order would look like a mistake. When
 * nothing has arrived at all the API answers 422 `awaiting_receipt` with the orders and the
 * quantity, so the message is in the user's language rather than the API's English.
 */

interface Waiting {
  orderNumber?: string
  quantity: number
}

export function useConversionFeedback() {
  const { t } = useI18n()
  const { showSnackbar, showSuccess, showError } = useSnackbar()

  const ordersOf = (list: Array<{ orderNumber?: string } | string>) =>
    [...new Set(list.map((x) => (typeof x === 'string' ? x : x.orderNumber)).filter(Boolean))].join(', ')

  function converted(data: { invoice: { invoiceNumber: string }; waiting?: Waiting[] }) {
    const number = data.invoice.invoiceNumber
    const waiting = data.waiting || []
    if (!waiting.length) {
      showSuccess(t('invoicing.invoiceCreatedFromOrder', { number }))
      return
    }
    const quantity = waiting.reduce((s, w) => s + (Number(w.quantity) || 0), 0)
    showSnackbar(t('invoicing.invoiceCreatedRestWaiting', { number, quantity, orders: ordersOf(waiting) }), 'info', 8000)
  }

  function failed(e: any) {
    const body = e?.response?.data
    if (body?.code === 'awaiting_receipt') {
      showError(t('invoicing.convertAwaitingReceipt', { quantity: body.quantity, orders: ordersOf(body.orders || []) }))
      return
    }
    showError(body?.message || t('common.operationFailed'))
  }

  return { converted, failed }
}
