/**
 * FR-32.22 (#797): the lines as a whole — the document-level tax rate and warehouse that stand for every line while
 * their columns are hidden, the pinned warehouse, the place of deal that follows the warehouse, and adding and removing
 * a line. What a line does when it is given an article is `products.ts`; its price, `pricing.ts`.
 */
import { computed, watch } from 'vue'
import type { FormState, Line } from './state'

export function useFormLines(s: FormState) {
  const {
    config, t, appStore, showSuccess, isEdit, form, warehouses, docTaxRate, docWarehouseId, userDefaultWarehouseId,
    userDefaultWhKey, isColActive, emptyLine,
  } = s

  // ── doc-level tax-rate / warehouse handling ──
  function filledFormLines(): Line[] {
    return form.lines.filter((l) => l.productId || (l.description || '').trim())
  }

  /** All filled lines share one tax rate → that rate, else null (drives "Tax Total (X%)"). */
  const uniformTaxRate = computed<number | null>(() => {
    const lines = filledFormLines()
    if (!lines.length) return null
    const rates = new Set(lines.map((l) => Number(l.taxRate) || 0))
    return rates.size === 1 ? [...rates][0] : null
  })

  function onDocTaxRateChange(rate: number | null | undefined) {
    if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return
    docTaxRate.value = Number(rate)
    for (const l of form.lines) l.taxRate = Number(rate)
  }

  function onDocWarehouseChange(whId: string | null) {
    docWarehouseId.value = whId
    for (const l of form.lines) l.warehouseId = whId || undefined
    seedPlaceOfDeal()
  }

  // ── FR-22.27 (D-7): place of deal ──
  /** An outgoing document states where the deal was made; the cash sale's own form has none. */
  const showPlaceOfDeal = config.direction === 'outgoing' && config.docType !== 'cash_sale'
  /** The place this form put there itself — replaced when the warehouse changes; a typed one is kept. */
  let autoPlace = ''

  /** Where a new document's deal is made: its warehouse's city, else the org's address. */
  function defaultPlaceOfDeal(): string {
    const wh: any = (warehouses.value as any[]).find((w: any) => w._id === docWarehouseId.value)
    // A warehouse address is an object; a few legacy ones are a single string with no city to read.
    const whCity = wh && wh.address && typeof wh.address === 'object' ? String(wh.address.city || '').trim() : ''
    if (whCity) return whCity
    const addresses: any[] = (appStore.currentOrg as any)?.addresses || []
    const orgAddress = addresses.find((a: any) => a.isDefault) || addresses[0]
    return String(orgAddress?.city || '').trim()
  }

  /** A new outgoing document starts at its default place, and follows it until the user types one. */
  function seedPlaceOfDeal() {
    if (!showPlaceOfDeal || isEdit.value) return
    if (form.placeOfTransaction && form.placeOfTransaction !== autoPlace) return
    const place = defaultPlaceOfDeal()
    form.placeOfTransaction = place
    autoPlace = place
  }
  // The org (and its address) can arrive after the form has mounted.
  watch(() => (appStore.currentOrg as any)?.addresses, () => seedPlaceOfDeal())

  const isPinnedDefaultWarehouse = computed(
    () => !!docWarehouseId.value && docWarehouseId.value === userDefaultWarehouseId.value,
  )

  /** Pin button: persist the current doc warehouse as this user's default (per org). */
  function pinDefaultWarehouse() {
    try {
      if (isPinnedDefaultWarehouse.value) {
        localStorage.removeItem(userDefaultWhKey())
        // The read falls back to the legacy `anon` pin: clear it too, or the unpinned warehouse
        // comes back on the next load.
        localStorage.removeItem(userDefaultWhKey('anon'))
        userDefaultWarehouseId.value = ''
      } else if (docWarehouseId.value) {
        localStorage.setItem(userDefaultWhKey(), docWarehouseId.value)
        userDefaultWarehouseId.value = docWarehouseId.value
        showSuccess(t('invoicing.defaultWarehouseSaved'))
      }
    } catch {
      /* private browsing — ignore */
    }
  }

  /** Derive the doc-level values from the (loaded/restored) lines: uniform → value, mixed → null. */
  function syncDocLevelFromLines() {
    const lines = filledFormLines()
    if (!lines.length) return
    const rates = new Set(lines.map((l) => Number(l.taxRate) || 0))
    docTaxRate.value = rates.size === 1 ? [...rates][0] : null
    const whs = new Set(lines.map((l) => l.warehouseId || ''))
    docWarehouseId.value = whs.size === 1 ? ([...whs][0] || null) : null
  }

  // Re-derive when the per-line column is toggled off — the lines may have diverged
  // while it was visible, and the doc-level control becomes the visible editor again.
  watch(
    () => `${isColActive('taxRate')}:${isColActive('warehouse')}`,
    () => syncDocLevelFromLines(),
  )

  // ── line operations ──
  function addLine() {
    form.lines.push(emptyLine())
  }
  function removeLine(idx: number) {
    form.lines.splice(idx, 1)
  }

  return {
    filledFormLines, uniformTaxRate, onDocTaxRateChange, onDocWarehouseChange, showPlaceOfDeal, seedPlaceOfDeal,
    isPinnedDefaultWarehouse, pinDefaultWarehouse, syncDocLevelFromLines, addLine, removeLine,
  }
}

export type FormLines = ReturnType<typeof useFormLines>
