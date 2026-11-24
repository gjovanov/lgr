/**
 * FR-32.22 (#797): the document's totals, a line's amounts, and money as the form shows it. All of it is computed by
 * the pure `document-payload.ts`, from the same rounded parts the payload carries.
 */
import { computed } from 'vue'
import { computeTotals, lineAmounts, round2 } from '../document-payload'
import type { FormState, Line } from './state'

export function useFormTotals(s: FormState) {
  const { config, form, baseCurrency, localeCode, formatCurrency } = s

  // ── totals + formatting ──
  const totals = computed(() => computeTotals(form.lines, config))
  const subtotal = computed(() => totals.value.subtotal)
  const discountTotal = computed(() => totals.value.discountTotal)
  const taxTotal = computed(() => totals.value.taxTotal)
  const documentTotal = computed(() => totals.value.total)

  /** What VAT is charged on: the subtotal less the line discounts, from the same rounded parts as the total. */
  const taxBase = computed(() => round2(totals.value.subtotal) - round2(totals.value.discountTotal))

  function computeLineTotal(l: Line): number {
    return lineAmounts(l, config.line.hasDiscount).total
  }
  /**
   * The line's net amount for the lineSubtotal column: qty × unit price LESS the line discount,
   * before tax. It showed qty × unit price, so a discounted line displayed its pre-discount
   * amount as the line's value — what users asked to have fixed.
   */
  function computeLineSubtotal(l: Line): number {
    return lineAmounts(l, config.line.hasDiscount).taxable
  }
  function fmtCurrency(amount: number): string {
    return formatCurrency(amount, form.currency || baseCurrency.value, localeCode.value)
  }

  return { totals, subtotal, discountTotal, taxTotal, documentTotal, taxBase, computeLineTotal, computeLineSubtotal, fmtCurrency }
}

export type FormTotals = ReturnType<typeof useFormTotals>
