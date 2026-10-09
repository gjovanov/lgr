import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Single source of truth for payment-method DDL options across invoicing forms.
 * Returns objects with `value` (canonical key) + `text` (translated label) so
 * v-select with `item-title="text" item-value="value"` renders correctly.
 *
 * Use with:
 *   const paymentMethods = usePaymentMethods()
 *   <v-select :items="paymentMethods" item-title="text" item-value="value" persistent-placeholder ... />
 *
 * There is no cheque: nobody pays by cheque here and no document ever used it, so the method
 * was removed outright (2026-10). Cash on delivery (наложен платеж) is offered everywhere but
 * at a till — a cash sale is paid on the spot, which is the one thing a courier payment is not;
 * pass `{ cashOnDelivery: false }` there.
 */
export function usePaymentMethods(opts: { cashOnDelivery?: boolean } = {}) {
  const { t } = useI18n()
  return computed(() => [
    { value: 'cash',          text: t('pos.cash') },
    { value: 'card',          text: t('pos.card') },
    { value: 'bank_transfer', text: t('pos.bankTransfer') },
    ...(opts.cashOnDelivery === false ? [] : [{ value: 'cash_on_delivery', text: t('pos.cashOnDelivery') }]),
  ])
}
