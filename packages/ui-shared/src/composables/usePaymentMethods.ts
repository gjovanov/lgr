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
 */
export function usePaymentMethods() {
  const { t } = useI18n()
  return computed(() => [
    { value: 'cash',          text: t('pos.cash') },
    { value: 'card',          text: t('pos.card') },
    { value: 'bank_transfer', text: t('pos.bankTransfer') },
    { value: 'check',         text: t('pos.check') },
  ])
}
