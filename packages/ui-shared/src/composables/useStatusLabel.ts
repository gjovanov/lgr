import { useI18n } from 'vue-i18n'
import { computed, type Ref, type ComputedRef } from 'vue'

/**
 * Translates an invoice/proforma/credit-note/debit-note/cash-sale/bill status
 * via i18n key `invoicing.status.<status>`. Falls back to the raw key when no
 * translation exists, so unknown statuses don't render as `invoicing.status.foo`.
 */
export function useStatusLabel(
  status: Ref<string | undefined> | ComputedRef<string | undefined> | (() => string | undefined),
) {
  const { t, te } = useI18n()
  return computed(() => {
    const s = typeof status === 'function' ? status() : status.value
    if (!s) return ''
    const key = `invoicing.status.${s}`
    return te(key) ? t(key) : s
  })
}

/** One-shot variant for use inside `computed`/templates without a Ref. */
export function statusLabelOf(status: string | undefined, t: (k: string) => string, te: (k: string) => boolean): string {
  if (!status) return ''
  const key = `invoicing.status.${status}`
  return te(key) ? t(key) : status
}
