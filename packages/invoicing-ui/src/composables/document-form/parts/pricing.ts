/**
 * FR-32.22 (#797): a line's price — resolved by the pricing chain, typed, or chosen by name — and the two prices that
 * cover the whole document: one named price for every line, and the last price the customer paid (#145). A contact
 * change resolves them all again (`reResolveLinePrices`).
 */
import { formatDate } from 'ui-shared/format'
import { ref, computed } from 'vue'
import { tierLabel } from 'config/price-tiers'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { fetchPriceOptions, type PriceOption } from 'ui-shared/composables/usePriceOptions'
import { rememberedFlag } from 'ui-shared/composables/useUserDefaults'
import { resolvesSalesPrice } from '../document-payload'
import { BASE_CHOICE, collectDocPriceChoices, mapLimit, optionForChoice, type DocPriceChoice } from '../doc-price'
import type { FormState, Line } from './state'
import type { FormProductUpdate } from './product-update'

export function useFormPricing(s: FormState, gr: FormProductUpdate) {
  const { config, t, locale, route, showSuccess, showError, showSnackbar, isEdit, form, orgUrl } = s
  const { applyGRPriceCascade } = gr

  async function resolvePriceForLine(idx: number) {
    const line = form.lines[idx]
    // A purchase document keeps the purchase price `onProductSelected` put on the line (B-10).
    if (!line?.productId || !resolvesSalesPrice(config)) return
    try {
      const params: Record<string, string> = { productId: line.productId }
      if (form.contactId) params.contactId = form.contactId
      if (line.quantity) params.quantity = String(line.quantity)
      const { data } = await httpClient.get(`${orgUrl()}/pricing/resolve`, { params })
      line.unitPrice = data.finalPrice
      line.priceExplanation = data.steps
      line.resolvedPrice = data.finalPrice
    } catch {
      /* keep existing price */
    }
  }

  /** Combobox price editor: value already known. */
  function onLinePriceChange(idx: number, price: number) {
    const line = form.lines[idx]
    if (!line) return
    line.unitPrice = price
    applyOverrideStep(line, price)
    applyGRPriceCascade(idx)
  }

  /** Plain number editor (@change): v-model already updated line.unitPrice. */
  function onLinePriceManualChange(idx: number) {
    const line = form.lines[idx]
    if (!line) return
    if (line.priceExplanation?.length) applyOverrideStep(line, line.unitPrice)
    applyGRPriceCascade(idx)
  }

  /**
   * Apply an explicitly chosen named price — from the per-line picker or the document-wide
   * choice — with a two-step explanation (base → chosen) so the trail records what was picked.
   *
   * The choice is pinned: the price combobox re-resolves on every product, contact and quantity
   * change, and used to swap a chosen „Цена 3" back to the resolved price the moment a quantity
   * was edited.
   */
  function setChosenPrice(line: Line, option: { type: string; name: string; price: number }) {
    line.unitPrice = option.price
    const steps: any[] = []
    if (option.type !== 'base') {
      steps.push({ type: 'base', label: 'Selling price', price: line.resolvedPrice ?? option.price })
    }
    steps.push({ type: option.type, label: option.name, price: option.price })
    line.priceExplanation = steps
    line.pricePinned = true
  }

  /** Explicit price-picker (PriceSelectButton) on one line. */
  function onLinePriceSelected(idx: number, option: { type: string; name: string; price: number }) {
    const line = form.lines[idx]
    if (!line || !option) return
    setChosenPrice(line, option)
    applyGRPriceCascade(idx)
  }

  // ── one price for the whole document ──
  // The user picks one of the named prices the lines' own pickers offer („Цена 3", the selling
  // price, …) and every line takes its product's price of that name. Lines whose product has no
  // such price keep theirs, and say so. Session state only: nothing about it is saved with the
  // document — the line prices and their explanations are.
  const docPriceEnabled = config.direction === 'outgoing'
  const docPriceKey = ref<string | null>(null)
  const docPriceChoices = ref<DocPriceChoice[]>([])
  const docPricePricedLines = ref(0)
  const docPriceLoading = ref(false)
  const hasPricedLines = computed(() => form.lines.some((l) => !!l.productId))

  /** A product's options for this contact and quantity — shared by every line that needs them. */
  const priceOptionsCache = new Map<string, PriceOption[]>()
  async function lineOptions(line: Line): Promise<PriceOption[]> {
    const qty = Number(line.quantity) || 1
    const cacheKey = `${line.productId}|${form.contactId || ''}|${qty}`
    const hit = priceOptionsCache.get(cacheKey)
    if (hit) return hit
    const { options } = await fetchPriceOptions(orgUrl(), line.productId, form.contactId || undefined, qty, true)
    // An empty list is also what a failed request returns: never cache it, so a retry can work.
    if (options?.length) priceOptionsCache.set(cacheKey, options)
    return options || []
  }

  /** A choice is a price NAME as the products carry it; a tier slot is drawn by its label (`config/price-tiers`). */
  function docPriceChoiceLabel(key: string): string {
    return key === BASE_CHOICE ? t('warehouse.sellingPrice') : tierLabel(key, locale.value)
  }

  const docPriceItems = computed(() => {
    const items: Array<{ title: string; value: string; subtitle?: string }> = [
      { title: t('invoicing.docPrice.auto'), value: '' },
    ]
    for (const c of docPriceChoices.value) {
      items.push({
        title: docPriceChoiceLabel(c.key),
        value: c.key,
        subtitle: t('invoicing.docPrice.coverage', { n: c.lines, total: docPricePricedLines.value }),
      })
    }
    // The current choice stays listed, so it still displays before the list has (re)loaded.
    if (docPriceKey.value && !items.some((i) => i.value === docPriceKey.value)) {
      items.push({ title: docPriceChoiceLabel(docPriceKey.value), value: docPriceKey.value })
    }
    return items
  })

  /** The prices the lines' products offer — loaded when the selector opens. */
  async function loadDocPriceChoices() {
    const lines = form.lines.filter((l) => l.productId)
    docPricePricedLines.value = lines.length
    if (!lines.length) {
      docPriceChoices.value = []
      return
    }
    docPriceLoading.value = true
    try {
      docPriceChoices.value = collectDocPriceChoices(await mapLimit(lines, 6, lineOptions))
    } finally {
      docPriceLoading.value = false
    }
  }

  /** Give one line the document-wide price; false when its product has no price by that name. */
  async function applyDocPriceToLine(line: Line): Promise<boolean> {
    const key = docPriceKey.value
    if (!key || !line.productId) return false
    const option = optionForChoice(await lineOptions(line), key)
    // The choice may have changed while the options were loading.
    if (!option || docPriceKey.value !== key) return false
    setChosenPrice(line, option)
    return true
  }

  async function applyDocPrice(key: string | null) {
    docPriceKey.value = key || null
    if (!docPriceKey.value) {
      // Back to automatic: every line resolves its own price again, as on a contact change.
      form.lines.forEach((l, i) => {
        l.pricePinned = false
        if (l.productId) void resolvePriceForLine(i) // it keeps the line's price on a failure
      })
      return
    }
    const lines = form.lines.filter((l) => l.productId)
    if (!lines.length) return
    docPriceLoading.value = true
    let applied = 0
    try {
      applied = (await mapLimit(lines, 6, applyDocPriceToLine)).filter(Boolean).length
    } finally {
      docPriceLoading.value = false
    }
    const name = docPriceChoiceLabel(docPriceKey.value)
    if (applied === lines.length) showSuccess(t('invoicing.docPrice.applied', { name, n: applied }))
    else showSnackbar(t('invoicing.docPrice.partial', { name, n: applied, total: lines.length }), 'warning', 8000)
  }

  // ── #145: the last price this customer paid ──
  // A checkbox: every line takes the unit price its product was last sold at to the selected
  // customer (`/pricing/last-prices` — issued sales invoices and cash sales, same currency, this
  // document excluded). It wins over the document-wide named price when both are on: it is the
  // more specific choice. Lines whose product was never sold to the customer keep their price,
  // and say so. The line prices and their explanation ("Last price (INV-…, date)") are what is
  // saved. FR-22.26: a proforma offers it too, and the choice is remembered per user and document
  // type — a counter that always quotes a customer's last price no longer ticks it every time.
  const lastPriceEnabled = config.docType === 'invoice' || config.docType === 'proforma' || config.docType === 'offer'
  const lastPriceMemory = rememberedFlag(`last-price:${config.docType}`)
  const useLastPrice = ref(lastPriceEnabled && lastPriceMemory.read() === true)
  const lastPriceLoading = ref(false)

  async function fetchLastPrices(productIds: string[]): Promise<Record<string, any>> {
    if (!form.contactId || !productIds.length) return {}
    const params: Record<string, string> = {
      contactId: form.contactId,
      productIds: [...new Set(productIds)].join(','),
    }
    if (form.currency) params.currency = form.currency
    if (isEdit.value) params.excludeId = route.params.id as string
    const { data } = await httpClient.get(`${orgUrl()}/pricing/last-prices`, { params })
    return data?.prices || {}
  }

  function setLastPrice(line: Line, lp: { price: number; invoiceNumber: string; issueDate: string }) {
    const date = lp.issueDate ? formatDate(lp.issueDate) : ''
    setChosenPrice(line, { type: 'contact', name: t('invoicing.lastPrice.step', { number: lp.invoiceNumber, date }), price: lp.price })
  }

  /** Give every priced line its last price. `quiet`: no toast (a contact change re-applies it). */
  async function applyLastPrices(quiet = false) {
    if (!useLastPrice.value) return
    if (!form.contactId) {
      if (!quiet) showSnackbar(t('invoicing.lastPrice.noContact'), 'warning', 6000)
      return
    }
    const lines = form.lines.filter((l) => l.productId)
    if (!lines.length) return
    const contactAtStart = form.contactId
    lastPriceLoading.value = true
    try {
      const prices = await fetchLastPrices(lines.map((l) => l.productId as string))
      // The customer, or the choice itself, may have changed while the prices were loading.
      if (form.contactId !== contactAtStart || !useLastPrice.value) return
      let applied = 0
      for (const l of lines) {
        const lp = prices[l.productId as string]
        if (lp) { setLastPrice(l, lp); applied++ }
      }
      if (quiet) return
      if (applied === lines.length) showSuccess(t('invoicing.lastPrice.applied', { n: applied }))
      else showSnackbar(t('invoicing.lastPrice.partial', { n: applied, total: lines.length }), 'warning', 8000)
    } catch (e: any) {
      if (!quiet) showError(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      lastPriceLoading.value = false
    }
  }

  /** One line, as a product is picked while the checkbox is on. */
  async function applyLastPriceToLine(line: Line) {
    if (!useLastPrice.value || !form.contactId || !line.productId) return
    try {
      const lp = (await fetchLastPrices([line.productId]))[line.productId]
      if (lp && useLastPrice.value) setLastPrice(line, lp)
    } catch { /* the line keeps the price it resolved to */ }
  }

  async function onUseLastPriceChange(on: boolean | null) {
    useLastPrice.value = !!on
    lastPriceMemory.write(useLastPrice.value)
    if (useLastPrice.value) await applyLastPrices()
    // Off: back to the prices the lines would have without it (and the document price, if any).
    else await reResolveLinePrices()
  }

  function applyOverrideStep(line: Line, price: number) {
    if (line.resolvedPrice !== undefined && price !== line.resolvedPrice && line.priceExplanation?.length) {
      const steps = line.priceExplanation.filter((s: any) => s.type !== 'override')
      steps.push({ type: 'override', label: 'User override', price })
      line.priceExplanation = steps
    }
  }

  /**
   * R6: a contact change re-resolves every line's price, explicit picks included (contact and tag
   * prices differ per contact). A document-wide price outlives the change: it is applied again on
   * top, once the lines without such a price have their new resolved one.
   */
  async function reResolveLinePrices() {
    await Promise.all(form.lines.map((l, i) => {
      if (!l?.productId) return undefined
      l.pricePinned = false
      return resolvePriceForLine(i)
    }))
    if (docPriceKey.value) await applyDocPrice(docPriceKey.value)
    // #145: the last price belongs to the customer — a new customer, a new last price.
    if (useLastPrice.value) await applyLastPrices(true)
  }

  return {
    resolvePriceForLine, onLinePriceChange, onLinePriceManualChange, onLinePriceSelected,
    docPriceEnabled, docPriceKey, docPriceItems, docPriceLoading, hasPricedLines, priceOptionsCache, loadDocPriceChoices,
    applyDocPriceToLine, applyDocPrice,
    lastPriceEnabled, useLastPrice, lastPriceLoading, applyLastPriceToLine, onUseLastPriceChange, reResolveLinePrices,
  }
}

export type FormPricing = ReturnType<typeof useFormPricing>
