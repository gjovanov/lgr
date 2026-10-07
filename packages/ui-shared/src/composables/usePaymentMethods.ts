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
 * `check` (Чек) is no longer offered: nobody pays by cheque here, and users asked for it to go.
 * The server still accepts it, so a document that already carries it keeps its label — pass
 * `current` (the field's value) and the option comes back for that document only, instead of
 * the select rendering the raw key.
 */
export function usePaymentMethods(current?: () => string | null | undefined) {
  const { t } = useI18n()
  return computed(() => {
    const methods = [
      { value: 'cash',          text: t('pos.cash') },
      { value: 'card',          text: t('pos.card') },
      { value: 'bank_transfer', text: t('pos.bankTransfer') },
    ]
    if (current?.() === 'check') methods.push({ value: 'check', text: t('pos.check') })
    return methods
  })
}
