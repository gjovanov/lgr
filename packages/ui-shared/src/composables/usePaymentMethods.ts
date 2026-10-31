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
 * on the back office's cash-sale form, which passes `{ cashOnDelivery: false }`: that form settles
 * on the spot. The till offers it from its own list (2026-10-31): a fiscal receipt in the device's
 * own slot, on a session bucket of its own.
 */
/** The message key of a method's name: not every one is `pos.<method>`. */
export function paymentMethodKey(method: string): string {
  if (method === 'cash_on_delivery') return 'pos.cashOnDelivery'
  if (method === 'bank_transfer') return 'pos.bankTransfer'
  return method === 'other' ? 'common.other' : `pos.${method}`
}

export function usePaymentMethods(opts: { cashOnDelivery?: boolean } = {}) {
  const { t } = useI18n()
  return computed(() => [
    { value: 'cash',          text: t('pos.cash') },
    { value: 'card',          text: t('pos.card') },
    { value: 'bank_transfer', text: t('pos.bankTransfer') },
    ...(opts.cashOnDelivery === false ? [] : [{ value: 'cash_on_delivery', text: t('pos.cashOnDelivery') }]),
  ])
}
