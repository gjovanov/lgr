/**
 * FR-32.22 (#797): an article put on a line — picked on the line, in the picker (one or several), or from the
 * customer's ledger — and what follows: its unit, VAT and price, the document-wide and last-customer prices, a bill's
 * product update, the next blank line, and the cursor on the quantity.
 */
import { computed } from 'vue'
import type { FormState } from './state'
import type { FormPricing } from './pricing'
import type { FormProductUpdate } from './product-update'

export function useFormProducts(s: FormState, pricing: FormPricing, gr: FormProductUpdate) {
  const { config, form, emptyLine, grColumnsVisible, productPickerOpen, productPickerRowIdx, productPickerText } = s
  const { resolvePriceForLine, docPriceKey, applyDocPriceToLine, useLastPrice, applyLastPriceToLine } = pricing
  const { seedLineProductUpdate, seedUnseededLines } = gr

  function onAddLedgerLines(entries: any[]) {
    for (const entry of entries) {
      form.lines.push({
        productId: entry.productId || undefined,
        description: entry.productName || '',
        quantity: entry.quantity || 1,
        unit: 'pcs',
        unitPrice: entry.unitPrice || 0,
        discount: 0,
        taxRate: entry.taxRate || 0,
        taxAmount: 0,
        lineTotal: 0,
        accountId: undefined,
        warehouseId: entry.warehouseId || undefined,
      })
    }
    void seedUnseededLines()
  }

  async function onProductSelected(idx: number, product: any) {
    const line = form.lines[idx]
    if (!line) return
    // A price chosen for the previous product means nothing for this one…
    line.pricePinned = false
    // …nor does what was staged for its product: the line is seeded again, for this one.
    line.productUpdate = {}
    line.priceTiers = []
    line.productBase = undefined
    line.unitPrice = product[config.priceField] ?? 0
    const priceAtPick = line.unitPrice
    line.unit = product.unit || line.unit
    if (config.resetDiscountOnProductSelect) line.discount = 0
    line.taxRate = product.taxRate ?? line.taxRate
    if (line.productId) await resolvePriceForLine(idx)
    // A document-wide price covers products added after it was chosen, too.
    if (docPriceKey.value && line.productId) await applyDocPriceToLine(line)
    // …and the customer's last price (#145), which wins over it.
    if (useLastPrice.value && line.productId) await applyLastPriceToLine(line)
    if (grColumnsVisible.value && line.productId) await seedLineProductUpdate(idx, priceAtPick)
    // Selecting a product on the last row appends a fresh blank row (matches legacy UX).
    if (idx === form.lines.length - 1) form.lines.push(emptyLine())
    // FR-28.27: the quantity is what the line needs next, so the cursor goes there.
    focusLineQuantity(idx)
  }

  /**
   * After a pick the cursor goes to the line's quantity, deferred past the search closing (and a dialog handing focus
   * back). Only while the cursor is still where the pick left it — on this line, or nowhere: a user who has already
   * moved on to another field keeps it.
   */
  function focusLineQuantity(idx: number) {
    if (typeof document === 'undefined') return
    setTimeout(() => {
      const row = document.querySelectorAll('.line-table tbody tr')[idx] as HTMLElement | undefined
      const input = row?.querySelector('input[type="number"]') as HTMLInputElement | null
      if (!input || input.disabled || input.readOnly) return
      const active = document.activeElement
      if (active && active !== document.body && !row!.contains(active)) return
      input.focus()
      try { input.select() } catch { /* a number input may refuse select() */ }
    }, 200)
  }

  function onProductCleared(idx: number) {
    const line = form.lines[idx]
    if (!line) return
    line.productId = undefined
    line.priceExplanation = undefined
    line.resolvedPrice = undefined
    line.productUpdate = {}
    line.priceTiers = []
    line.productBase = undefined
  }

  function openProductPicker(idx: number, text = '') {
    productPickerRowIdx.value = idx
    productPickerText.value = text
    productPickerOpen.value = true
  }

  /** FR-28.28: the articles already on the document are marked in the dialog, not hidden from it. */
  const existingProductIds = computed(() => form.lines.map((l: any) => String(l.productId || '')).filter(Boolean))

  /** The line after `idx` that is free for an article: the blank one that follows, else a new one inserted there. */
  function lineAfter(idx: number): number {
    const next = idx + 1
    const line = form.lines[next]
    if (line && !line.productId && !line.description) return next
    form.lines.splice(next, 0, emptyLine())
    return next
  }

  /**
   * FR-28.28: several articles at once. The first goes on the line the dialog was opened from, as one pick would;
   * each of the others on the next free line. Each runs the line's own after-pick logic — price resolution, unit and
   * tax — in the order ticked. A repeated article is a line of its own, as it is when picked one at a time.
   */
  async function onProductsPicked(products: any[]) {
    let idx = productPickerRowIdx.value
    productPickerRowIdx.value = -1
    if (idx < 0 || !products.length || !form.lines[idx]) return
    for (let i = 0; i < products.length; i++) {
      if (i > 0) idx = lineAfter(idx)
      const line = form.lines[idx]
      line.productId = products[i]._id
      line.description = products[i].name
      await onProductSelected(idx, products[i])
    }
  }

  async function onProductPicked(product: any) {
    const idx = productPickerRowIdx.value
    productPickerRowIdx.value = -1
    if (idx < 0) return
    const line = form.lines[idx]
    if (!line) return
    line.productId = product._id
    line.description = product.name
    await onProductSelected(idx, product)
  }

  return {
    onAddLedgerLines, onProductSelected, onProductCleared, openProductPicker, existingProductIds, onProductsPicked,
    onProductPicked,
  }
}

export type FormProducts = ReturnType<typeof useFormProducts>
