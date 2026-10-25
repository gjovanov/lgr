import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useInvoicingExport, type CompanionDoc } from 'ui-shared/composables/useInvoicingExport'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaymentMethods } from 'ui-shared/composables/usePaymentMethods'
import { fetchPriceOptions, type PriceOption } from 'ui-shared/composables/usePriceOptions'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useInvoiceLineColumns } from 'ui-shared/composables/useInvoiceLineColumns'
import { upsertAmountInWords } from 'config/amount-in-words'
import { useGRColumns } from 'ui-shared/composables/useGRColumns'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { jwtUserId } from 'ui-shared/composables/useStorageIdentity'
import type { FormAction, SmartButtonDef, StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import type { DocumentTypeConfig } from './types'
import {
  buildPayload as buildPayloadPure,
  buildProductUpdates,
  computeTotals,
  lineAmounts,
  linesFromRelatedInvoice,
  MAX_PRICE_TIERS,
  resolvesSalesPrice,
  round2,
  type DocumentFormState,
} from './document-payload'
import {
  BASE_CHOICE,
  collectDocPriceChoices,
  mapLimit,
  optionForChoice,
  type DocPriceChoice,
} from './doc-price'

export interface BeforeCreateResult {
  /** true → the composable proceeds to POST; false → the hook took over (e.g. opened a dialog). */
  proceed: boolean
}

export interface UseDocumentFormOptions {
  /** Create-mode interceptor (cash sale stock check). Receives the built payload; may open a
   *  dialog and return { proceed:false } to suspend, then later call `submitCreate(extra)`. */
  onBeforeCreate?: (payload: Record<string, any>) => Promise<BeforeCreateResult> | BeforeCreateResult
}

type Line = Record<string, any>

/** Concrete (non-optional) shape of the reactive form so template bindings are well-typed. */
interface DocFormReactive {
  contactId: string
  supplierInvoiceNumber: string
  relatedInvoiceId: string
  issueDate: string
  dueDate: string
  validUntil: string
  paymentMethod: string
  currency: string
  exchangeRate: number
  notes: string
  terms: string
  footer: string
  reason: string
  preparedBy: string
  placeOfTransaction: string
  billingAddress: { street: string; city: string; state: string; postalCode: string; country: string }
  tags: string[]
  lines: Line[]
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}
function plusDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().split('T')[0]
}
function plusMonths(n: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + n)
  return d.toISOString().split('T')[0]
}
function emptyBillingAddress() {
  return { street: '', city: '', state: '', postalCode: '', country: '' }
}

export function useDocumentForm(config: DocumentTypeConfig, opts: UseDocumentFormOptions = {}) {
  const { t } = useI18n()
  const route = useRoute()
  const router = useRouter()
  const appStore = useAppStore()
  const { showSuccess, showError, showSnackbar } = useSnackbar()
  const { formatCurrency } = useCurrency()

  const vatRates = computed(() => appStore.currentOrg?.settings?.taxConfig?.vatRates ?? [])
  const defaultVatRate = computed(() => appStore.currentOrg?.settings?.taxConfig?.defaultVatRate ?? 0)
  const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
  const localeCode = computed(
    () => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[appStore.locale] || 'en-US',
  )

  const isEdit = computed(() => !!route.params.id)

  // ── refs / collections ──
  const formRef = ref<any>()
  const loading = ref(false)
  const loadingContacts = ref(false)
  const contacts = ref<any[]>([])
  const warehouses = ref<{ _id: string; name: string }[]>([])
  const invoices = ref<{ _id: string; invoiceNumber: string }[]>([])

  const invoiceStatus = ref('draft')
  const invoiceNumber = ref('')
  const invoiceData = ref<any>(null)
  const peekedNumber = ref('')

  const ledgerDialog = ref(false)
  const productPickerOpen = ref(false)
  const productPickerRowIdx = ref(-1)
  const importDialogOpen = ref(false)

  // ── line columns ──
  const columnPickerOpen = ref(false)
  const {
    selected: selectedCols,
    availableColumns: availableLineColumns,
    activeColumns: activeLineColumns,
    entries: lineColumnEntries,
    toggle: toggleCol,
    move: moveCol,
    reorder: reorderCol,
    selectAll: selectAllCols,
    selectNone: selectNoCols,
    resetDefaults: resetColDefaults,
  } = useInvoiceLineColumns(config.docType, {
    // From the session token, not `appStore.user`: that is null on a fresh load until `/auth/me`
    // answers, and the preference would be read under `anon` meanwhile.
    userId: jwtUserId,
    orgId: () => appStore.currentOrg?.id,
  })
  const isColActive = (key: string) => selectedCols.value.includes(key)
  const { uomOptions } = useProductUnits()

  // ── GR product-update columns (purchase bills only) ──
  const withProductUpdate = ref(false)
  const grColumnPickerOpen = ref(false)
  const grCategories = ref<Array<{ _id: string; name: string }>>([])
  const {
    selected: grSelectedCols,
    activeColumns: grActiveColumns,
    toggle: grToggleCol,
    selectAll: grSelectAllCols,
    selectNone: grSelectNoCols,
    resetDefaults: grResetColDefaults,
  } = useGRColumns({
    userId: jwtUserId,
    orgId: () => appStore.currentOrg?.id,
  })
  const grColumnsVisible = computed(() => !!config.supportsProductUpdate && withProductUpdate.value)

  // ── doc-level single-value controls (used while the per-line column is hidden) ──
  // null docTaxRate = mixed/unset (label shows placeholder); picking a value applies to all lines.
  const docTaxRate = ref<number | null>(null)
  const docWarehouseId = ref<string | null>(null)
  const userDefaultWarehouseId = ref('')

  /**
   * The pinned warehouse is the user's, per org. The user comes from the session token: the app
   * store's `user` is null on a fresh page load until `/auth/me` answers, and this is read during
   * the form's first load, so it used to look under `anon` and the pin silently did not load.
   */
  function userDefaultWhKey(userId = jwtUserId()) {
    return `lgr:default-wh:${userId}:${appStore.currentOrg?.id || 'no-org'}`
  }
  function loadUserDefaultWarehouse(): string {
    try {
      // A pin saved while the user was still unknown sits under `anon`: keep honouring it until
      // the user pins again.
      return localStorage.getItem(userDefaultWhKey()) || localStorage.getItem(userDefaultWhKey('anon')) || ''
    } catch {
      return ''
    }
  }

  // ── form state (normalised — collapses form.date / form.issueDate) ──
  function emptyLine(): Line {
    return {
      description: '',
      quantity: 1,
      unit: 'pcs',
      unitPrice: 0,
      discount: 0,
      taxRate: docTaxRate.value ?? defaultVatRate.value,
      taxAmount: 0,
      lineTotal: 0,
      accountId: undefined,
      warehouseId: docWarehouseId.value || undefined,
      // GR-with-update extras (populated only when the toggle is ON)
      productUpdate: {},
      priceTiers: [],
    }
  }

  const form = reactive<DocFormReactive>({
    contactId: '',
    supplierInvoiceNumber: '',
    relatedInvoiceId: '',
    issueDate: todayStr(),
    dueDate: config.secondaryDate === 'dueDate' ? plusMonths(1) : '',
    validUntil: config.secondaryDate === 'validUntil' ? plusDays(config.validUntilDefaultDays || 30) : '',
    paymentMethod: config.paymentMethodDefault || 'cash',
    currency: baseCurrency.value,
    exchangeRate: 1,
    notes: '',
    terms: '',
    footer: '',
    reason: '',
    // Signature footer: author defaults to the logged-in user; imported docs carry the OCR name.
    preparedBy: '',
    placeOfTransaction: '',
    billingAddress: emptyBillingAddress(),
    tags: [],
    lines: [emptyLine()],
  })

  const selectedContact = computed(() => contacts.value.find((c: any) => c._id === form.contactId) || null)

  // A cash sale is paid at the till, so cash on delivery is not one of its choices.
  const paymentMethods = usePaymentMethods({ cashOnDelivery: config.docType !== 'cash_sale' })

  // The notes textarea binds to either `notes` or `reason` depending on the doc type.
  const notesModel = computed<string>({
    get: () => ((form as any)[config.notesFieldModel] as string) || '',
    set: (v: string) => {
      ;(form as any)[config.notesFieldModel] = v
    },
  })

  // ── pending changes ──
  const { markSaved, tryRestore, snapshot: snapshotPending } = usePendingChanges({
    appId: 'invoicing',
    entityType: config.pendingEntityType,
    icon: config.pendingIcon,
    getFormData: () => ({ ...form, lines: [...form.lines] }),
    getPreviewFields: () => [
      { label: 'Date', value: form.issueDate || '' },
      { label: 'Currency', value: form.currency || '' },
    ],
    setFormData: (data) => Object.assign(form, data),
    isEdit: () => isEdit.value,
    entityId: () => route.params.id as string,
  })

  const rules = { required: (v: string) => !!v || t('validation.required') }

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

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
  }

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
  }

  /**
   * Merge an imported document (single-file PDF import) into THIS open form.
   *
   * Nothing was persisted server-side — the user reviewed a field diff and this applies
   * the subset they kept. Three things are deliberate:
   *  - lines are built directly, never through `onProductSelected`, which would overwrite
   *    the document's own price with the catalog price and append a blank row;
   *  - every imported line is marked `loaded` so `PriceCombobox` treats its price as a
   *    historical fact instead of re-resolving it the moment a productId appears;
   *  - `syncDocLevelFromLines()` runs afterwards, or the doc-level tax-rate/warehouse
   *    controls keep showing the values from before the import.
   */
  async function applyImportedDocument(payload: {
    fields: Record<string, any>
    lines: any[]
    lineMode: 'replace' | 'append' | 'keep'
  }) {
    for (const [k, v] of Object.entries(payload.fields || {})) {
      if (v === undefined || v === null || v === '') continue
      ;(form as any)[k] = v
    }
    // The matched counterparty is rarely on the autocomplete's currently loaded page, and
    // an unloaded id renders as a blank field.
    if (payload.fields?.contactId) await ensureSelectedContactLoaded(payload.fields.contactId)

    if (payload.lineMode !== 'keep' && payload.lines?.length) {
      const mapped: Line[] = payload.lines.map((l: any) => ({
        productId: l.productId || undefined,
        description: l.description || '',
        quantity: Number(l.quantity) || 0,
        unit: l.unit || 'pcs',
        unitPrice: Number(l.unitPrice) || 0,
        discount: Number(l.discount) || 0,
        taxRate: Number(l.taxRate) || 0,
        taxAmount: Number(l.taxAmount) || 0,
        lineTotal: Number(l.lineTotal) || 0,
        accountId: undefined,
        warehouseId: l.warehouseId || undefined,
        orderRef: l.orderRef || undefined,
        // Original OCR wording — persisted, and what supplier alias learning trains on.
        sourceText: l.sourceText || undefined,
        resolvedPrice: Number(l.unitPrice) || undefined,
        productUpdate: {},
        priceTiers: [],
        loaded: true,
      }))
      const kept = payload.lineMode === 'append' ? filledFormLines() : []
      form.lines = [...kept, ...mapped, emptyLine()]
    }

    syncDocLevelFromLines()
    showSuccess(t('docImport.applied'))
  }

  async function onProductSelected(idx: number, product: any) {
    const line = form.lines[idx]
    if (!line) return
    // A price chosen for the previous product means nothing for this one.
    line.pricePinned = false
    line.unitPrice = product[config.priceField] ?? 0
    line.unit = product.unit || line.unit
    if (config.resetDiscountOnProductSelect) line.discount = 0
    line.taxRate = product.taxRate ?? line.taxRate
    if (line.productId) await resolvePriceForLine(idx)
    // A document-wide price covers products added after it was chosen, too.
    if (docPriceKey.value && line.productId) await applyDocPriceToLine(line)
    // …and the customer's last price (#145), which wins over it.
    if (useLastPrice.value && line.productId) await applyLastPriceToLine(line)
    if (grColumnsVisible.value && line.productId) await seedLineProductUpdate(idx)
    // Selecting a product on the last row appends a fresh blank row (matches legacy UX).
    if (idx === form.lines.length - 1) form.lines.push(emptyLine())
  }

  function onProductCleared(idx: number) {
    const line = form.lines[idx]
    if (!line) return
    line.productId = undefined
    line.priceExplanation = undefined
    line.resolvedPrice = undefined
  }

  function openProductPicker(idx: number) {
    productPickerRowIdx.value = idx
    productPickerOpen.value = true
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

  function docPriceChoiceLabel(key: string): string {
    return key === BASE_CHOICE ? t('warehouse.sellingPrice') : key
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
        if (l.productId) resolvePriceForLine(i)
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
  // and say so. Session state, like the document price: the line prices and their explanation
  // ("Last price (INV-…, date)") are what is saved.
  const lastPriceEnabled = config.docType === 'invoice'
  const useLastPrice = ref(false)
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
    const date = lp.issueDate ? new Date(lp.issueDate).toLocaleDateString(localeCode.value) : ''
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

  // ── GR product-update helpers (purchase bills only) ──
  function setGRField(line: Line, field: string, value: any) {
    if (!line.productUpdate) line.productUpdate = {}
    line.productUpdate[field] = value === '' ? undefined : value
  }

  function setGRTierPrice(line: Line, i: number, val: any) {
    if (!Array.isArray(line.priceTiers)) line.priceTiers = []
    while (line.priceTiers.length <= i) {
      line.priceTiers.push({ name: `Price ${line.priceTiers.length + 1}`, percent: 0, finalPrice: 0, manualOverride: false, contactIds: [], tags: [] })
    }
    const n = Number(val)
    if (!Number.isFinite(n)) return
    line.priceTiers[i].finalPrice = n
    line.priceTiers[i].manualOverride = true // direct edit overrides the cascade
  }

  /** Load the full product and stage its current fields + tiers on the line (padded to 10 slots). */
  async function seedLineProductUpdate(idx: number) {
    const line = form.lines[idx]
    if (!line?.productId) return
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product/${line.productId}`)
      const p = data.product || data
      line.productUpdate = {
        type: p.type,
        categoryId: p.categoryId || undefined,
        unit: p.unit,
        purchasePrice: p.purchasePrice ?? 0,
        sellingPrice: p.sellingPrice ?? 0,
        taxRate: p.taxRate ?? 0,
      }
      const existing = (p.priceTiers || []).map((t: any) => ({
        name: t.name || '',
        percent: Number(t.percent) || 0,
        finalPrice: Number(t.finalPrice) || 0,
        manualOverride: !!t.manualOverride,
        contactIds: (t.contactIds || []).map((id: any) => String(id)),
        tags: t.tags || [],
      }))
      while (existing.length < MAX_PRICE_TIERS) {
        existing.push({ name: `Price ${existing.length + 1}`, percent: 0, finalPrice: Number(p.sellingPrice) || 0, manualOverride: false, contactIds: [], tags: [] })
      }
      line.priceTiers = existing.slice(0, MAX_PRICE_TIERS)
    } catch { /* keep defaults if fetch fails */ }
  }

  async function fetchGRCategories() {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product-category`, { params: { size: 0 } })
      grCategories.value = data.productCategories || []
    } catch { /* */ }
  }

  /** When the bill's unit price (= purchase price) changes, recompute non-overridden tiers
   *  from their percent and mirror the purchase price into the staged product update. */
  function applyGRPriceCascade(idx: number) {
    const line = form.lines[idx]
    if (!line || !grColumnsVisible.value) return
    const purchase = Number(line.unitPrice) || 0
    if (!purchase) return
    for (const t of (line.priceTiers || [])) {
      if (!t.manualOverride) t.finalPrice = +(purchase * (1 + (t.percent || 0) / 100)).toFixed(4)
    }
    setGRField(line, 'purchasePrice', purchase)
  }

  // Toggling ON seeds any line that has a product but no staged update yet (covers edit
  // mode for draft AND received bills) and lazily loads the category options.
  watch(withProductUpdate, async (on) => {
    if (!on || !config.supportsProductUpdate) return
    if (!grCategories.value.length) fetchGRCategories()
    const idxs = form.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.productId && (!l.productUpdate || Object.keys(l.productUpdate).length === 0))
      .map(({ i }) => i)
    await Promise.all(idxs.map(seedLineProductUpdate))
  })

  // ── contact change (R6: re-resolve for ALL types; invoice also captures billing) ──
  function captureBilling(contactId: string) {
    const contact = contacts.value.find((c: any) => c._id === contactId)
    if (!contact || !contact.addresses || contact.addresses.length === 0) return
    const billingAddr =
      contact.addresses.find((a: any) => a.type === 'billing' && a.isDefault) ||
      contact.addresses.find((a: any) => a.type === 'billing') ||
      contact.addresses.find((a: any) => a.isDefault) ||
      contact.addresses[0]
    if (billingAddr) {
      form.billingAddress.street = billingAddr.street || ''
      form.billingAddress.city = billingAddr.city || ''
      form.billingAddress.state = billingAddr.state || ''
      form.billingAddress.postalCode = billingAddr.postalCode || ''
      form.billingAddress.country = billingAddr.country || ''
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

  function onContactChange(contactId?: string) {
    const id = contactId ?? form.contactId
    if (config.captureBillingAddress && id) captureBilling(id)
    // Tag and contact prices differ per contact: options fetched for the previous one are stale.
    priceOptionsCache.clear()
    if (config.reResolveOnChange || docPriceKey.value || useLastPrice.value) void reResolveLinePrices()
    // Narrow the related-invoice candidates to the newly chosen contact.
    if (config.showRelatedInvoice) fetchInvoices()
  }

  function onContactCreated(contact: any) {
    contacts.value.push(contact)
    form.contactId = contact._id || contact.id
    onContactChange(form.contactId)
  }

  // ── related-invoice autofill (credit / debit) ──
  if (config.relatedInvoiceAutofill) {
    watch(
      () => form.relatedInvoiceId,
      async (newId) => {
        if (!newId || isEdit.value) return
        try {
          const { data } = await httpClient.get(`${orgUrl()}/invoices/${newId}`)
          const invoice = data.invoice
          if (invoice?.lines?.length) {
            form.lines = linesFromRelatedInvoice(invoice.lines)
            // The doc-level tax-rate / warehouse controls show what the copied lines carry.
            syncDocLevelFromLines()
          }
        } catch {
          /* */
        }
      },
    )
  }

  // ── status pipeline (i18n) ──
  // Carry the i18n KEYS (not resolved strings) so EntityFormShell resolves them in the render
  // path (`{{ $t(step) }}`) — that re-runs on locale change, unlike a pre-resolved string array
  // which only refreshes on remount.
  const statusDef = computed<StatusDef | undefined>(() => {
    if (!isEdit.value) return undefined
    const steps = config.status.map((s) => s.i18n)
    const matchIdx = config.status.findIndex((s) => s.match.includes(invoiceStatus.value))
    const idx = matchIdx >= 0 ? matchIdx : 0
    return { steps, current: steps[idx] }
  })

  // ── actions ──
  /**
   * Import is offered exactly where Save is: the merge is pointless on a document the user
   * cannot then save, and the `draft-only` gate below already encodes that rule for issued
   * sales invoices and cash sales.
   */
  const importAction: FormAction = {
    label: t('docImport.importFile'),
    color: 'secondary',
    variant: 'outlined',
    icon: 'mdi-file-upload-outline',
    handler: () => { importDialogOpen.value = true },
  }

  /** #171: the cash sale this invoice was issued for — its lines are that sale's, so no import. */
  const cashSaleRef = computed<{ cashSaleId: string; number: string; issueDate: string } | null>(() => invoiceData.value?.cashSaleRef || null)

  const formActions = computed<FormAction[]>(() => {
    const save: FormAction = { label: t('common.save'), color: 'primary', handler: onSave, loading: loading.value }
    if (cashSaleRef.value) return invoiceStatus.value === 'draft' ? [save] : []
    if (!isEdit.value) return [save, importAction]
    if (config.editSaveGate === 'draft-only' && invoiceStatus.value !== 'draft') return []
    return [save, importAction]
  })

  const smartButtons = computed<SmartButtonDef[]>(() => {
    if (!config.showSmartButtons || !invoiceData.value) return []
    const btns: SmartButtonDef[] = []
    if (invoiceData.value.journalEntryId) {
      btns.push({ label: 'Journal Entry', value: 1, icon: 'mdi-book-open-variant', to: '/accounting/journal-entries' })
    }
    const payments = invoiceData.value.payments || []
    if (payments.length > 0) {
      const totalPaid = payments.reduce((s: number, p: any) => s + (p.amount || 0), 0)
      btns.push({ label: 'Payments', value: fmtCurrency(totalPaid), icon: 'mdi-cash-multiple' })
    }
    const transferIds = invoiceData.value.pendingTransferIds || []
    if (transferIds.length > 0) {
      btns.push({ label: 'Deliveries', value: transferIds.length, icon: 'mdi-truck-delivery', to: '/movements' })
    }
    return btns
  })

  // ── export ──
  const showExportDialog = ref(false)
  /**
   * Free text printed under the number block. Kept outside `form` (it is edited from the
   * export panel, not from the field grid) but stored with the document all the same, so a
   * reprint months later carries the same note: saved with the payload, and by the print
   * request itself when the user types it and goes straight to Print.
   */
  const printNote = ref('')
  /**
   * Free text printed in the "Допълнителна информация" block of the two companion documents
   * (декларация за съответствие / приемо-предавателен протокол). Same lifecycle as
   * `printNote` — stored with the document, so every later reprint of either companion
   * repeats it — but a separate field: the companion forms have their own layout and the
   * invoice's header note has no place on them.
   */
  const companionNote = ref('')
  const { loading: exportLoading, exportOne } = useInvoicingExport(() => appStore.orgUrl())
  async function onExportSingle(o: {
    format: 'xlsx' | 'pdf'
    mode: 'compact' | 'detailed'
    columns?: string[]
    companions?: string[]
  }) {
    const id = route.params.id as string
    if (!id) return
    const base = invoiceNumber.value || id
    // The document itself, then one file per ticked companion. Sequential so the browser
    // treats them as user-initiated downloads rather than a popup burst.
    const jobs: Array<{ name: string; doc?: CompanionDoc }> = [{ name: base }]
    for (const c of o.companions || []) {
      jobs.push({ name: `${base}-${c}`, doc: c as CompanionDoc })
    }
    try {
      for (const job of jobs) {
        // The note belongs to the document itself; companion forms have their own layout.
        await exportOne(id, job.name, o.format, o.mode, o.columns, appStore.locale, job.doc, job.doc ? undefined : printNote.value)
      }
      showExportDialog.value = false
      showSuccess(t('export.success'))
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    }
  }

  // ── persistence ──
  function buildPayload(): Record<string, any> {
    const p = buildPayloadPure(form as unknown as DocumentFormState, config)
    // Purchase bills with the toggle ON also carry the staged product-master updates.
    if (grColumnsVisible.value) p.productUpdates = buildProductUpdates(form.lines)
    // Auto amount-in-words ("Словом") on outgoing documents, in the user's UI language,
    // refreshed on every save (replaces any prior line, never stacks). Writes into the
    // notes field and mirrors it back onto the form so an immediate re-save is stable.
    if (config.direction === 'outgoing') {
      const key = config.notesFieldModel
      const words = upsertAmountInWords(
        (form as any)[key] || '',
        totals.value.total,
        totals.value.subtotal,
        form.currency || baseCurrency.value,
        appStore.locale,
      )
      ;(form as any)[key] = words
      p[key] = words
    }
    // Stored with the document so every later print repeats it; an empty box clears it.
    p.printNote = printNote.value.trim()
    p.companionNote = companionNote.value.trim()
    return p
  }

  async function validate(): Promise<boolean> {
    if (!formRef.value) return true
    const { valid } = await formRef.value.validate()
    return valid
  }

  const createAttempt = createIdempotentAction()

  async function persist(payload: Record<string, any>) {
    loading.value = true
    try {
      if (isEdit.value) await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
      // #155: an unanswered save keeps its key, so saving again returns the document it made
      // (a cash sale is issued and moves stock on create) instead of making a second one.
      else await createAttempt.run(payload, headers => httpClient.post(`${orgUrl()}/invoices`, payload, { headers }))
      markSaved()
      showSuccess(t(config.successKey))
      router.push({ name: config.listRouteName })
    } catch (e: any) {
      showError(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      loading.value = false
    }
  }

  async function onSave() {
    const ok = await validate()
    if (!ok) return
    const payload = buildPayload()
    if (!isEdit.value && opts.onBeforeCreate) {
      loading.value = true
      let res: BeforeCreateResult
      try {
        res = await opts.onBeforeCreate(payload)
      } catch {
        res = { proceed: true } // mirror legacy: a failed pre-check proceeds anyway
      }
      if (!res || !res.proceed) {
        loading.value = false
        return
      }
    }
    await persist(payload)
  }

  /** Low-level create used by hooks after a suspended `onBeforeCreate` (e.g. transfer confirm). */
  async function submitCreate(extra?: Record<string, any>) {
    const payload = { ...buildPayload(), ...(extra || {}) }
    await persist(payload)
  }

  // ── data loading ──
  async function fetchContacts(search?: string) {
    loadingContacts.value = true
    try {
      const params: Record<string, any> = { ...(config.contactFetchParams || {}), size: 20 }
      if (search) params.search = search
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params })
      contacts.value = data.contacts || []
      // A filtered result may drop the currently selected contact — keep it resolvable.
      if (form.contactId) await ensureSelectedContactLoaded(form.contactId)
    } catch {
      /* */
    } finally {
      loadingContacts.value = false
    }
  }

  let contactSearchTimer: ReturnType<typeof setTimeout> | null = null
  function onContactSearch(text: string) {
    // Vuetify echoes the selected item's title into the search box — not a user query.
    if (selectedContact.value && text === selectedContact.value.companyName) return
    if (contactSearchTimer) clearTimeout(contactSearchTimer)
    contactSearchTimer = setTimeout(() => fetchContacts(text || undefined), 300)
  }

  // ── contact picker dialog (wide server-searched table, mirrors the product picker) ──
  const contactPickerOpen = ref(false)
  function onContactPicked(c: any) {
    const id = c?._id || c?.id
    if (!id) return
    if (!contacts.value.some((x: any) => x._id === id)) contacts.value = [{ ...c, _id: id }, ...contacts.value]
    form.contactId = id
    onContactChange(id)
  }

  /** Ensure the invoice's selected contact is in the picker list even when it falls outside the
   * (paginated / type-filtered) contact fetch — otherwise the autocomplete shows the raw id and the
   * party block shows "—". Fetches the full contact (with addresses + tax numbers) by id. */
  async function ensureSelectedContactLoaded(rawContactId: any) {
    const id = rawContactId?._id || rawContactId
    if (!id) return
    if (contacts.value.some((c: any) => c._id === id)) return
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact/${id}`)
      const c = data.contact
      if (c) { c._id = c._id || c.id; contacts.value = [c, ...contacts.value] }
    } catch {
      // Fallback to the invoice's populated contact (name only) so the picker isn't blank.
      if (rawContactId && typeof rawContactId === 'object' && rawContactId.companyName) {
        contacts.value = [{ ...rawContactId, _id: id }, ...contacts.value]
      }
    }
  }

  async function fetchWarehouses() {
    try {
      // The endpoint paginates with size=10 by default — request all for the per-line DDL.
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } })
      warehouses.value = data.warehouses || []
    } catch {
      /* */
    }
  }

  /**
   * Server-searched candidates for the related-invoice picker (credit/debit notes).
   * Only issued invoices from the SAME side qualify (mirrors the backend 422 rules), and
   * the list narrows to the chosen contact once one is selected.
   */
  async function fetchInvoices(search?: string) {
    try {
      const params: Record<string, any> = {
        type: 'invoice',
        direction: config.direction,
        status: 'sent,received,partially_paid,paid,overdue',
        size: 20,
      }
      if (search) params.search = search
      if (form.contactId) params.contactId = form.contactId
      const { data } = await httpClient.get(`${orgUrl()}/invoices`, { params })
      invoices.value = data.invoices || []
      // A filtered result may drop the currently selected invoice — keep it resolvable.
      if (form.relatedInvoiceId) await ensureSelectedRelatedInvoiceLoaded(form.relatedInvoiceId)
    } catch {
      /* */
    }
  }

  let relatedSearchTimer: ReturnType<typeof setTimeout> | null = null
  function onRelatedInvoiceSearch(text: string) {
    // Vuetify echoes the selected item's title into the search box — not a user query.
    const selected = invoices.value.find((i: any) => i._id === form.relatedInvoiceId)
    if (selected && text === selected.invoiceNumber) return
    if (relatedSearchTimer) clearTimeout(relatedSearchTimer)
    relatedSearchTimer = setTimeout(() => fetchInvoices(text || undefined), 300)
  }

  async function ensureSelectedRelatedInvoiceLoaded(id: string) {
    if (!id || invoices.value.some((i: any) => i._id === id)) return
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${id}`)
      if (data.invoice) invoices.value = [data.invoice, ...invoices.value]
    } catch {
      /* */
    }
  }

  async function fetchPeekedNumber() {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/peek-next`, { params: config.peekParams })
      peekedNumber.value = data.next || ''
    } catch {
      /* keep empty */
    }
  }

  function mapLoadedLine(l: any): Line {
    return {
      productId: l.productId || undefined,
      description: l.description || '',
      quantity: l.quantity || 1,
      unit: l.unit || 'pcs',
      unitPrice: l.unitPrice || 0,
      discount: l.discount || 0,
      taxRate: l.taxRate || 0,
      taxAmount: l.taxAmount || 0,
      lineTotal: l.lineTotal || 0,
      accountId: l.accountId || undefined,
      warehouseId: l.warehouseId || undefined,
      priceExplanation: l.priceExplanation || undefined,
      orderRef: l.orderRef || undefined,
      sourceText: l.sourceText || undefined,
      cashSaleLineId: l.cashSaleLineId || undefined,
      resolvedPrice: l.unitPrice || undefined,
      productUpdate: {},
      priceTiers: [],
      // Marks the line as loaded from a persisted document — the price combobox must
      // not overwrite its historical price with the currently-resolved one.
      loaded: true,
    }
  }

  async function loadDocument() {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${route.params.id}`)
      const inv = data.invoice
      invoiceStatus.value = inv.status || 'draft'
      invoiceNumber.value = inv.invoiceNumber || ''
      invoiceData.value = inv
      form.contactId = inv.contactId?._id || inv.contactId || ''
      // Persisted in `reference`; the legacy key is read first for any document that
      // predates the fix (it was never actually stored, but costs nothing to honour).
      form.supplierInvoiceNumber = inv.supplierInvoiceNumber || inv.reference || ''
      form.relatedInvoiceId = inv.relatedInvoiceId || ''
      form.issueDate = inv.issueDate?.split('T')[0] || inv.date?.split('T')[0] || ''
      form.dueDate = inv.dueDate?.split('T')[0] || ''
      // A proforma's validity is stored as its dueDate (B-11): the model has no validUntil.
      form.validUntil = config.secondaryDate === 'validUntil' ? form.dueDate : ''
      form.currency = inv.currency || baseCurrency.value
      form.exchangeRate = inv.exchangeRate || 1
      form.paymentMethod = inv.paymentMethod || config.paymentMethodDefault
      form.notes = inv.notes || ''
      // The print note is stored with the document, so it comes back on every later print.
      printNote.value = inv.printNote || ''
      companionNote.value = inv.companionNote || ''
      form.terms = inv.terms || ''
      form.footer = inv.footer || ''
      form.reason = inv.reason || ''
      form.preparedBy = inv.preparedBy || ''
      form.placeOfTransaction = inv.placeOfTransaction || ''
      form.tags = inv.tags || []
      if (config.captureBillingAddress) {
        form.billingAddress = inv.billingAddress
          ? {
              street: inv.billingAddress.street || '',
              city: inv.billingAddress.city || '',
              state: inv.billingAddress.state || '',
              postalCode: inv.billingAddress.postalCode || '',
              country: inv.billingAddress.country || '',
            }
          : emptyBillingAddress()
      }
      form.lines = (inv.lines || []).map(mapLoadedLine)
      syncDocLevelFromLines()
      await ensureSelectedContactLoaded(inv.contactId)
      if (form.relatedInvoiceId) await ensureSelectedRelatedInvoiceLoaded(form.relatedInvoiceId)
      // What was just loaded is the clean state. The composable's own snapshot runs on a 500 ms
      // timer from mount, so a slower load used to count as an edit: leaving an untouched
      // document asked to keep "unsaved changes".
      snapshotPending()
    } catch {
      /* */
    }
  }

  onMounted(async () => {
    const tasks: Promise<any>[] = [fetchContacts(), fetchWarehouses()]
    if (config.showRelatedInvoice) tasks.push(fetchInvoices())
    await Promise.all(tasks)
    userDefaultWarehouseId.value = loadUserDefaultWarehouse()
    if (tryRestore()) {
      syncDocLevelFromLines()
      return
    }
    if (!isEdit.value) {
      // Seed doc-level controls: org default VAT rate; user default WH → org default WH.
      docTaxRate.value = defaultVatRate.value
      const userWh = userDefaultWarehouseId.value
      const candidate =
        (userWh && warehouses.value.some((w) => w._id === userWh) ? userWh : '') ||
        (warehouses.value as any[]).find((w: any) => w.isDefault)?._id ||
        null
      if (candidate) onDocWarehouseChange(candidate)
      fetchPeekedNumber()
    }
    if (isEdit.value) await loadDocument()
  })

  // R7 fix: a single number computed for the read-only field (edit shows the real number,
  // create shows the peeked next number). The legacy forms bound a non-existent
  // `form.invoiceNumber` → blank in edit mode.
  const documentNumber = computed(() => invoiceNumber.value || peekedNumber.value)

  return {
    // config passthrough
    config,
    // identity / status
    isEdit,
    route,
    invoiceStatus,
    invoiceNumber,
    invoiceData,
    cashSaleRef,
    documentNumber,
    statusDef,
    // collections
    contacts,
    warehouses,
    invoices,
    loadingContacts,
    selectedContact,
    // refs
    formRef,
    loading,
    rules,
    ledgerDialog,
    productPickerOpen,
    productPickerRowIdx,
    columnPickerOpen,
    importDialogOpen,
    applyImportedDocument,
    // form
    form,
    notesModel,
    // columns
    selectedCols,
    availableLineColumns,
    activeLineColumns,
    lineColumnEntries,
    toggleCol,
    moveCol,
    reorderCol,
    selectAllCols,
    selectNoCols,
    resetColDefaults,
    isColActive,
    // GR product-update (purchase bills)
    withProductUpdate,
    grColumnPickerOpen,
    grColumnsVisible,
    grSelectedCols,
    grActiveColumns,
    grToggleCol,
    grSelectAllCols,
    grSelectNoCols,
    grResetColDefaults,
    grCategories,
    setGRField,
    setGRTierPrice,
    uomOptions,
    paymentMethods,
    vatRates,
    defaultVatRate,
    // totals / format
    subtotal,
    discountTotal,
    taxBase,
    taxTotal,
    documentTotal,
    computeLineTotal,
    computeLineSubtotal,
    uniformTaxRate,
    // doc-level single-value controls
    docTaxRate,
    docWarehouseId,
    onDocTaxRateChange,
    onDocWarehouseChange,
    pinDefaultWarehouse,
    isPinnedDefaultWarehouse,
    fmtCurrency,
    baseCurrency,
    localeCode,
    // actions / line ops
    formActions,
    smartButtons,
    addLine,
    removeLine,
    onAddLedgerLines,
    onProductSelected,
    onProductCleared,
    openProductPicker,
    onProductPicked,
    resolvePriceForLine,
    onLinePriceChange,
    onLinePriceManualChange,
    onLinePriceSelected,
    // one price for the whole document
    docPriceEnabled,
    docPriceKey,
    docPriceItems,
    docPriceLoading,
    hasPricedLines,
    loadDocPriceChoices,
    applyDocPrice,
    // #145: the customer's last price
    lastPriceEnabled,
    useLastPrice,
    lastPriceLoading,
    onUseLastPriceChange,
    onContactChange,
    onContactCreated,
    onContactSearch,
    contactPickerOpen,
    onContactPicked,
    onRelatedInvoiceSearch,
    // export
    showExportDialog,
    printNote,
    companionNote,
    exportLoading,
    onExportSingle,
    // persistence
    buildPayload,
    onSave,
    submitCreate,
    // misc
    orgUrl,
    appStore,
  }
}
