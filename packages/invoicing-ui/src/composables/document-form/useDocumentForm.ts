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
import { cascadePurchasePrice, needsSeed, productsForSeed, seedFromProduct, setProductField, setTierPrice } from 'ui-shared/composables/gr-product-update'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { jwtUserId } from 'ui-shared/composables/useStorageIdentity'
import { rememberedFlag, rememberedSetting } from 'ui-shared/composables/useUserDefaults'
import { readPrintSettings, writePrintSettings, type PrintSettings } from '../print-settings'
import { appHref } from 'ui-shared/nav/navigate'
import type { FormAction, SmartButtonDef, StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import type { DocumentTypeConfig } from './types'
import { useDocumentIssue } from '../useDocumentIssue'
import { receiptOverlapOf, type ReceiptOverlap } from '../receipt-overlap'
import {
  buildPayload as buildPayloadPure,
  buildProductUpdates,
  computeTotals,
  lineAmounts,
  linesFromRelatedInvoice,
  copyOfDocument,
  noteFromInvoice,
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
  /**
   * A new document was just created as `id`, and the form is about to move onto its edit route.
   * The view keeps the form mounted for that move (`useDocumentRouteKey#adopt`): it is the same
   * document, and the form may still be issuing or printing it.
   */
  onCreated?: (id: string) => void
  /**
   * Fields the view adds to a NEW document's payload, on every create path (FR-21.31: the cash
   * sale's `receipt`, when it joins its author's open session and is to print on its device).
   */
  extraPayload?: () => Record<string, any>
}

export type { PrintSettings }

/** Statuses of a document that stands issued: a note can correct it (the API's own rule). */
const CORRECTABLE = ['sent', 'received', 'partially_paid', 'paid', 'overdue']

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
  /**
   * „С актуализация на продукт" starts ON, and is remembered per user and org under its own key
   * (the receipt form remembers its own switch, `gr-with-update`). ON is safe on a bill opened and
   * saved untouched: the payload carries only what the user changed on a line's product
   * (`ui-shared/composables/gr-product-update.ts`).
   */
  const billUpdateMemory = config.supportsProductUpdate ? rememberedFlag('bill-with-update') : null
  const withProductUpdate = ref(!!config.supportsProductUpdate && billUpdateMemory?.read() !== false)
  function onWithProductUpdateChange(on: boolean | null) {
    withProductUpdate.value = !!on
    billUpdateMemory?.write(!!on)
  }
  /**
   * FR-22 D-2: a bill made from goods receipts updates no product. Its receipts brought the goods in
   * at their costs, and receiving it carries its prices forward (`applyLinkedBillPrices`). It shows
   * no switch and no product columns, and its payload carries no updates (the server refuses them).
   */
  const receiptLinked = computed(() => String(invoiceData.value?.stockSource?.marker || '').startsWith('movement:'))
  /**
   * The currency of a bill that cannot update its products, or ''. A product's prices are kept in
   * the org's currency and nothing converts, so the server refuses such an update and the form
   * offers none, and says why.
   */
  const foreignBillCurrency = computed(() => (
    config.supportsProductUpdate && !receiptLinked.value && form.currency && form.currency !== baseCurrency.value
      ? form.currency
      : ''
  ))
  const productUpdateOffered = computed(() => !!config.supportsProductUpdate && !receiptLinked.value && !foreignBillCurrency.value)
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
  const grColumnsVisible = computed(() => productUpdateOffered.value && withProductUpdate.value)

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
    paymentMethod: config.paymentMethodOnCreate ?? (config.paymentMethodDefault || 'cash'),
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

  /**
   * FR-22.26: the payment method this user last saved a document of this type with — where a new
   * one starts. A counter that takes cards all day picked „С карта" on every invoice. Nothing
   * remembered yet: the type's own default, as before. A till's method is fixed, and not chosen.
   */
  const payMethodMemory = config.paymentMethodMode === 'fixed' ? null : rememberedSetting<string>(`pay-method:${config.docType}`)
  function rememberedPaymentMethod(): string | null {
    const m = payMethodMemory?.read()
    if (typeof m !== 'string') return null
    return m === '' || paymentMethods.value.some((p) => p.value === m) ? m : null
  }

  // The notes textarea binds to either `notes` or `reason` depending on the doc type.
  const notesModel = computed<string>({
    get: () => ((form as any)[config.notesFieldModel] as string) || '',
    set: (v: string) => {
      ;(form as any)[config.notesFieldModel] = v
    },
  })

  // ── pending changes ──
  const { markSaved, markClean: markCleanPending, isDirty: formDiffersFromStored, tryRestore } = usePendingChanges({
    appId: 'invoicing',
    entityType: config.pendingEntityType,
    icon: config.pendingIcon,
    getFormData: () => ({ ...form, lines: [...form.lines] }),
    getPreviewFields: () => [
      { label: 'Date', value: form.issueDate || '' },
      { label: 'Currency', value: form.currency || '' },
    ],
    setFormData: (data) => {
      Object.assign(form, data)
      // A draft from before a typed price was pinned: its trail says the person set this price.
      for (const l of form.lines) if (l.priceExplanation?.some((s: any) => s.type === 'override')) l.pricePinned = true
    },
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
    await seedUnseededLines()
    showSuccess(t('docImport.applied'))
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
  // and say so. The line prices and their explanation ("Last price (INV-…, date)") are what is
  // saved. FR-22.26: a proforma offers it too, and the choice is remembered per user and document
  // type — a counter that always quotes a customer's last price no longer ticks it every time.
  const lastPriceEnabled = config.docType === 'invoice' || config.docType === 'proforma'
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

  // ── GR product-update helpers (purchase bills only) ──
  // What a line stages, its base and what reaches the product: `ui-shared/composables/gr-product-update.ts`.
  function setGRField(line: Line, field: string, value: any) {
    setProductField(line, field, value)
  }

  /** A price typed into a tier's column: the tier of that NAME on the line's product. */
  function setGRTierPrice(line: Line, tierName: string, val: any) {
    setTierPrice(line, tierName, val)
  }

  async function fetchProductForSeed(id: string): Promise<any | null> {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product/${id}`)
      return data.product || data
    } catch {
      return null
    }
  }

  /** Load the line's product and stage its current fields and tiers on the line, with their base. */
  async function seedLineProductUpdate(idx: number, priceAtPick?: number) {
    const line = form.lines[idx]
    if (!line?.productId) return
    const productId = String(line.productId)
    const priceBefore = priceAtPick ?? line.unitPrice
    const product = await fetchProductForSeed(productId)
    // The line may have been given another product while this one loaded.
    if (!product || String(line.productId) !== productId) return
    Object.assign(line, seedFromProduct(product, productId))
    // A price typed while the product loaded is its new purchase price, as if typed after.
    if (line.unitPrice !== priceBefore) cascadePurchasePrice(line, line.unitPrice)
  }

  /**
   * Seed every line that names a product and stages nothing yet: a loaded bill, an import, lines
   * from the ledger or a copy, the switch turned on. All of a bill's articles are read at once.
   */
  async function seedUnseededLines() {
    if (!grColumnsVisible.value) return
    const pending = form.lines.filter(needsSeed)
    if (!pending.length) return
    const products = await productsForSeed(async (ids) => {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product`, { params: { ids: ids.join(','), size: ids.length } })
      return data.products || []
    }, [...new Set(pending.map((l) => String(l.productId)))])
    for (const line of pending) {
      const p = products.get(String(line.productId))
      // Staged meanwhile (a product picked again while these loaded): that line keeps its own.
      if (p && needsSeed(line)) Object.assign(line, seedFromProduct(p, String(line.productId)))
    }
  }

  async function fetchGRCategories() {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product-category`, { params: { size: 0 } })
      grCategories.value = data.productCategories || []
    } catch { /* */ }
  }

  /**
   * The bill's unit price is the article's new purchase price: staged on the line's product, with
   * the tiers that follow the purchase price moved along (`cascadePurchasePrice` says which do).
   */
  function applyGRPriceCascade(idx: number) {
    const line = form.lines[idx]
    if (!line || !grColumnsVisible.value) return
    cascadePurchasePrice(line, line.unitPrice)
  }

  // The columns appearing (the switch turned on, the bill back in the org's currency) seed the
  // lines that name a product and stage nothing yet, and load the category options.
  watch(grColumnsVisible, async (on) => {
    if (!on) return
    if (!grCategories.value.length) fetchGRCategories()
    await seedUnseededLines()
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
  /** The invoice `prefillFromInvoice` already copied: the watcher below must not copy it again. */
  let prefilledFrom = ''
  if (config.relatedInvoiceAutofill) {
    watch(
      () => form.relatedInvoiceId,
      async (newId) => {
        if (!newId || isEdit.value) return
        if (newId === prefilledFrom) {
          prefilledFrom = ''
          return
        }
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

  /**
   * FR-22.21: a note opened from the invoice it corrects (`?relatedInvoiceId=` — „Кредитно
   * известие" / „Дебитно известие" on the invoice) starts as that invoice: its customer, the
   * invoice itself, its currency and method, and its lines as they were sold. The user then keeps
   * what is returned or charged. The customer is set without `onContactChange`, whose price
   * re-resolution would replace the prices the invoice charged.
   */
  async function prefillFromInvoice(id: string) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${id}`)
      const invoice = data.invoice
      if (!invoice) return
      const note = noteFromInvoice(invoice)
      form.contactId = note.contactId
      await ensureSelectedContactLoaded(invoice.contactId)
      if (note.currency) form.currency = note.currency
      form.exchangeRate = note.exchangeRate
      if (note.paymentMethod) form.paymentMethod = note.paymentMethod
      form.lines = note.lines as Line[]
      prefilledFrom = note.relatedInvoiceId
      if (!invoices.value.some((i: any) => i._id === note.relatedInvoiceId)) {
        invoices.value = [{ ...invoice, _id: invoice._id || invoice.id }, ...invoices.value]
      }
      form.relatedInvoiceId = note.relatedInvoiceId
      syncDocLevelFromLines()
      // The related-invoice candidates narrow to this customer, as a pick of the customer does.
      void fetchInvoices()
    } catch {
      /* The user picks the invoice by hand, as before. */
    }
  }

  /**
   * FR-22.24 — „Копирай" (`?copyOf=`): a new draft that starts as another document of this form
   * (`copyOfDocument` says what comes along). Dated today, numbered when it is saved. A copied
   * note keeps the invoice it corrects, and its own lines rather than that invoice's.
   */
  async function prefillFromCopy(id: string) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${id}`)
      const source = data.invoice
      if (!source) return
      const copy = copyOfDocument(source)
      form.contactId = copy.contactId
      await ensureSelectedContactLoaded(source.contactId)
      if (copy.currency) form.currency = copy.currency
      form.exchangeRate = copy.exchangeRate
      if (config.paymentMethodMode !== 'fixed') form.paymentMethod = copy.paymentMethod
      form.notes = copy.notes
      form.terms = copy.terms
      form.footer = copy.footer
      form.reason = copy.reason
      form.tags = copy.tags
      if (copy.placeOfTransaction) form.placeOfTransaction = copy.placeOfTransaction
      if (config.captureBillingAddress && copy.billingAddress) form.billingAddress = { ...copy.billingAddress } as any
      form.lines = [...(copy.lines as Line[]), emptyLine()]
      if (config.showRelatedInvoice && copy.relatedInvoiceId) {
        prefilledFrom = copy.relatedInvoiceId
        form.relatedInvoiceId = copy.relatedInvoiceId
        await ensureSelectedRelatedInvoiceLoaded(copy.relatedInvoiceId)
      }
      syncDocLevelFromLines()
      await seedUnseededLines()
    } catch {
      /* A blank form, as „Нов" opens. */
    }
  }

  /**
   * FR-22.47 — „Продай" on an article (`?productId=`): a new document whose first line is that
   * article, filled through `onProductSelected` exactly as picking it on the line fills it: its
   * unit and VAT, the price the pricing chain resolves (the purchase price on a purchase document,
   * B-10), the document-wide and last-customer prices when those are on, and the next blank line.
   * It runs after the form's own defaults, so the line sits in the document's warehouse. An article
   * that cannot be read leaves the blank form „Нов" opens.
   */
  async function prefillFromProduct(id: string) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product/${encodeURIComponent(id)}`)
      const product = data?.product
      const line = form.lines[0]
      if (!product || !line) return
      line.productId = String(product._id || product.id)
      line.description = product.name
      await onProductSelected(0, { ...product, _id: line.productId })
    } catch {
      /* A blank form, as „Нов" opens. */
    }
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
  /**
   * FR-21 §11: an issued sales invoice that is no cash sale's yet can be attached to the cash sale
   * of its day — for one entered before the till export brought that sale in.
   */
  const attachDialogOpen = ref(false)
  const attachable = computed(() => {
    // One that moves no stock already can only be a till day's, repaired by hand (`salesAnalysis:`).
    const marker = invoiceData.value?.stockSource?.marker
    return isEdit.value && config.docType === 'invoice' && config.direction === 'outgoing' && !cashSaleRef.value
      && ['sent', 'paid', 'partially_paid', 'overdue'].includes(invoiceStatus.value)
      && (!marker || String(marker).startsWith('salesAnalysis:'))
  })
  async function onAttached(invoice: any) {
    showSuccess(t('invoicing.cashSaleInvoice.attachDone', { number: invoice?.cashSaleRef?.number || '' }))
    await loadDocument()
  }

  /** A document the form issues itself: every outgoing one but the cash sale, issued as it is saved. */
  const issuable = config.direction === 'outgoing' && config.docType !== 'cash_sale'
  /** Not issued yet: a new document, or a draft. */
  const isDraftDoc = computed(() => !isEdit.value || invoiceStatus.value === 'draft')
  /** FR-22.21: an issued invoice can be corrected by a credit or a debit note. */
  const correctable = computed(() =>
    isEdit.value && (config.docType === 'invoice' || config.docType === 'purchase_invoice') && CORRECTABLE.includes(invoiceStatus.value),
  )
  /** FR-22.22: a proforma becomes an invoice once — and not after it was voided. */
  const convertible = computed(() => config.docType === 'proforma' && !['converted', 'voided', 'cancelled'].includes(invoiceStatus.value))

  const formActions = computed<FormAction[]>(() => {
    const save: FormAction = { label: t('common.save'), color: 'primary', handler: onSave, loading: loading.value, save: true }
    const outlinedSave: FormAction = { ...save, variant: 'outlined' }
    const notes: FormAction[] = correctable.value
      ? [
          { label: t('invoicing.docType.credit_note'), icon: 'mdi-file-undo', variant: 'outlined', handler: () => openNote('credit_note') },
          { label: t('invoicing.docType.debit_note'), icon: 'mdi-file-plus-outline', variant: 'outlined', handler: () => openNote('debit_note') },
        ]
      : []
    if (cashSaleRef.value) return invoiceStatus.value === 'draft' ? [save] : notes
    // FR-22.33: a bill that is not received yet is saved and received in one action — the
    // primary one, so it comes first; plain Save keeps a draft.
    if (config.saveAndReceive && isDraftDoc.value) {
      const receive: FormAction = {
        label: t('invoicing.saveAndReceive'), color: 'primary', icon: 'mdi-package-down', handler: onSaveAndReceive, loading: receiving.value, primary: true,
      }
      return [receive, outlinedSave, importAction]
    }
    const convert: FormAction | null = convertible.value
      ? { label: t('invoicing.convertToInvoice'), icon: 'mdi-swap-horizontal', variant: 'outlined', handler: onConvert, loading: converting.value }
      : null
    // FR-22.17/.18: a document not issued yet is issued from its own form. „Издай и печатай"
    // finishes the job, so it is the primary action and comes first. „Издай" saves first when the
    // form holds anything unsaved, and says so.
    if (issuable && isDraftDoc.value) {
      const busy = issuing.value
      return [
        { label: t('invoicing.issueFlow.issueAndPrint'), color: 'primary', icon: 'mdi-printer-check', handler: () => issueFromForm(true), loading: busy && issuingWithPrint.value, disabled: busy && !issuingWithPrint.value, primary: true },
        { label: t(isDirtyNow.value ? 'invoicing.issueFlow.saveAndIssue' : 'invoicing.issueFlow.issue'), color: 'primary', variant: 'outlined', icon: 'mdi-send-check', handler: () => issueFromForm(false), loading: busy && !issuingWithPrint.value, disabled: busy && issuingWithPrint.value },
        outlinedSave,
        ...(convert ? [convert] : []),
        importAction,
      ]
    }
    if (!isEdit.value) return [save, importAction]
    // Issued: what it can still change, and what follows from it.
    const issued: FormAction[] = []
    if (convert) issued.push({ ...convert, color: 'primary', variant: 'flat', primary: true })
    if (config.editSaveGate !== 'draft-only') issued.push(issued.length ? outlinedSave : save)
    issued.push(...notes)
    if (attachable.value) {
      issued.push({ label: t('invoicing.cashSaleInvoice.attach'), icon: 'mdi-link-variant', variant: 'outlined', handler: () => { attachDialogOpen.value = true } })
    }
    if (config.editSaveGate !== 'draft-only') issued.push(importAction)
    return issued
  })

  /**
   * B-13: each button opens what it counts, in the app that has it. The invoicing SPA has no
   * journal-entry or movement routes, so a router `to` led nowhere; these are cross-app links.
   * What has been paid is in the totals card — a payment has no page to open.
   */
  const smartButtons = computed<SmartButtonDef[]>(() => {
    if (!config.showSmartButtons || !invoiceData.value) return []
    const btns: SmartButtonDef[] = []
    const journalEntryId = invoiceData.value.journalEntryId
    if (journalEntryId) {
      btns.push({
        label: t('invoicing.smart.journalEntry'),
        value: 1,
        icon: 'mdi-book-open-variant',
        href: appHref('accounting', `/accounting/journal-entries/${journalEntryId}/edit`),
      })
    }
    const transferIds: string[] = (invoiceData.value.pendingTransferIds || []).map(String)
    if (transferIds.length > 0) {
      btns.push({
        label: t('invoicing.smart.transfers'),
        value: transferIds.length,
        icon: 'mdi-truck-delivery',
        // A transfer records no link back to its invoice, so several open the transfers list.
        href: appHref('inventory', transferIds.length === 1 ? `/inventory/movements/${transferIds[0]}` : '/inventory/movements?type=transfer'),
      })
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

  /** FR-22.20: where a print starts — the user's last print settings (`../print-settings`). */
  const lastPrint = ref<PrintSettings>(readPrintSettings())

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
      // What the user printed with is where the next print starts.
      const settings: PrintSettings = { format: o.format, mode: o.mode, columns: o.columns?.length ? [...o.columns] : lastPrint.value.columns }
      lastPrint.value = settings
      writePrintSettings(settings)
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    }
  }

  /**
   * FR-22.20 — „Печат": the document in one click, with the user's last settings. The options
   * dialog stays one click further away (`onPrintOptions`). #4.13: a document that is new or holds
   * unsaved edits is saved first — what prints is what is stored.
   */
  async function onPrint() {
    if (!(await saveIfNeeded())) return
    await onExportSingle({ ...lastPrint.value, companions: [] })
  }

  /** „Печат…": the print options (format, columns, companion documents), after saving the same way. */
  async function onPrintOptions() {
    if (!(await saveIfNeeded())) return
    showExportDialog.value = true
  }

  // ── „Стокова разписка": the goods a supplier bill booked ──
  /** The receipts the bill booked (`GET /invoices/:id`); the print is offered when there are some. */
  const stockReceipts = computed<Array<{ id: string; number: string; date: string; warehouseName: string }>>(
    () => (config.direction === 'incoming' && invoiceData.value?.stockMovements) || [],
  )
  const { loading: stockReceiptLoading, exportOne: exportStockReceipt } = useInvoicingExport(() => appStore.orgUrl())

  /**
   * One section per receipt the bill booked. It prints what was booked, not what the form holds, so
   * nothing is saved first: no edit on the form changes a receipt.
   */
  async function onPrintStockReceipt() {
    const id = route.params.id as string
    if (!id || !stockReceipts.value.length) return
    try {
      await exportStockReceipt(id, `${invoiceNumber.value || id}-stock-receipt`, 'pdf', 'detailed', undefined, appStore.locale, 'stock_receipt')
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    }
  }

  /** Bumped when the form takes a fresh clean state, so `isDirtyNow` reads it again. */
  const cleanTick = ref(0)
  /** The print notes as stored: they live outside `form`, which the pending-changes snapshot covers. */
  const storedNotes = { printNote: '', companionNote: '' }
  /** The form differs from what is stored — always, for a document not saved yet. */
  const isDirtyNow = computed(() => {
    void cleanTick.value
    if (!isEdit.value) return true
    return formDiffersFromStored()
      || printNote.value !== storedNotes.printNote
      || companionNote.value !== storedNotes.companionNote
  })
  /** What the form shows now is what is stored (it was just loaded); an edit from here is unsaved. */
  function markClean() {
    storedNotes.printNote = printNote.value
    storedNotes.companionNote = companionNote.value
    markCleanPending()
    cleanTick.value++
  }

  // ── persistence ──
  function buildPayload(): Record<string, any> {
    const p = buildPayloadPure(form as unknown as DocumentFormState, config)
    // A purchase bill with the switch on carries what its lines change on their products, and only
    // that: a bill saved untouched updates no product and takes the plain save path.
    if (grColumnsVisible.value) {
      const updates = buildProductUpdates(form.lines)
      if (updates.length) p.productUpdates = updates
    }
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
    // FR-22.27: the place of deal is a field of its own on an outgoing document, so a cleared one
    // is saved as cleared (the shared builder sends it only when set).
    if (showPlaceOfDeal) p.placeOfTransaction = (form.placeOfTransaction || '').trim()
    return p
  }

  async function validate(): Promise<boolean> {
    if (!formRef.value) return true
    const { valid } = await formRef.value.validate()
    return valid
  }

  const createAttempt = createIdempotentAction()

  /**
   * FR-22.16: saving keeps the user on the document, as stored — a new one moves onto its own edit
   * route. Save used to return to the list, so every next step (issue, print, a note) began by
   * finding the document again. A cash sale is the exception: it is issued as it is saved, and its
   * journal is where the next one starts (FR-21 owns that screen; FR-22.58 plans „Запази и нова").
   */
  const staysOnSave = config.docType !== 'cash_sale'

  /**
   * Save the payload. The document's id, or null when nothing was saved (the reason was shown).
   * `quiet`: no "saved" message — the save is a step of a longer action that reports itself.
   */
  async function persist(payload: Record<string, any>, persistOpts: { quiet?: boolean } = {}): Promise<string | null> {
    loading.value = true
    try {
      let id = route.params.id ? String(route.params.id) : ''
      const created = !isEdit.value
      if (!created) {
        await httpClient.put(`${orgUrl()}/invoices/${id}`, payload)
      } else {
        // #155: an unanswered save keeps its key, so saving again returns the document it made
        // (a cash sale is issued and moves stock on create) instead of making a second one.
        const { data } = await createAttempt.run(payload, headers => httpClient.post(`${orgUrl()}/invoices`, payload, { headers }))
        id = String(data?.invoice?.id || data?.invoice?._id || '')
      }
      markSaved()
      // FR-22.26: the method a new document was saved with is where the next one starts. Editing an
      // older document changes nothing about the next.
      if (created) payMethodMemory?.write(form.paymentMethod || '')
      if (!persistOpts.quiet) showSuccess(t(config.successKey))
      if (!staysOnSave) {
        router.push({ name: config.listRouteName })
        return id
      }
      if (String(route.params.id || '') !== id) {
        // On the saved document before anything else happens to it: should a following step fail
        // (issue, receive, print), pressing again acts on this one rather than saving a second.
        opts.onCreated?.(id)
        await router.replace({ name: `${config.listRouteName}.edit`, params: { id } })
      }
      await loadDocument()
      return id
    } catch (e: any) {
      showError(e?.response?.data?.message || t('common.operationFailed'))
      return null
    } finally {
      loading.value = false
    }
  }

  /** The document as the form shows it, stored: its id, or null when it is invalid or was refused. */
  async function saveIfNeeded(): Promise<string | null> {
    if (isEdit.value && !isDirtyNow.value) return String(route.params.id)
    if (!(await validate())) return null
    return persist(buildPayload(), { quiet: true })
  }

  async function onSave() {
    const ok = await validate()
    if (!ok) return
    const payload = { ...buildPayload(), ...(!isEdit.value && opts.extraPayload ? opts.extraPayload() : {}) }
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
    const payload = { ...buildPayload(), ...(opts.extraPayload ? opts.extraPayload() : {}), ...(extra || {}) }
    await persist(payload)
  }

  /**
   * FR-22.33 — „Запази и получи": save the bill, then receive it (it takes its issued number,
   * and books its goods unless it was made from receipts that already did). The user stays on
   * the bill, which now reads as received. Receiving was a list-row icon only.
   */
  const receiving = ref(false)
  /** FR-22.31c: the server asked first; `ReceiptOverlapDialog` carries the answer. */
  const receiptOverlap = ref<ReceiptOverlap | null>(null)
  async function onSaveAndReceive() {
    // The keyboard reaches a button that shows its spinner: Enter again would receive it again.
    if (receiving.value) return
    receiving.value = true
    let id: string | null = null
    try {
      if (!(await validate())) return
      // On the saved bill before receiving it: should receiving fail, pressing again receives
      // this one rather than saving a second.
      id = await persist(buildPayload(), { quiet: true })
      if (!id) return
      const { data: received } = await httpClient.post(`${orgUrl()}/invoices/${id}/receive`)
      // A bill made from receipts books no stock: its receipts did (FR-22.31).
      showSuccess(t(received?.invoice?.stockSource?.marker ? 'invoicing.linkDelivery.received' : 'invoicing.invoiceReceived'))
      await loadDocument()
    } catch (e: any) {
      receiptOverlap.value = id ? receiptOverlapOf(e, id) : null
      if (!receiptOverlap.value) showError(e?.response?.data?.message || t('common.operationFailed'))
      // Saved but not received: show what was saved, still a draft.
      if (route.params.id) await loadDocument()
    } finally {
      receiving.value = false
    }
  }

  // ── issue (FR-22.17 / .18) ──
  const issuer = useDocumentIssue()
  const issuing = ref(false)
  const issuingWithPrint = ref(false)
  /** Why the document is still a draft after it was asked to be issued (FR-22 §5.2). */
  const issueError = issuer.lastError

  /**
   * „Издай" / „Запази и издай" / „Издай и печатай": save what the form shows when it differs from
   * what is stored, then issue through the very path the list's „Изпрати" takes — the stock check,
   * the transfer dialog when a warehouse is short, `/send`. With `print`, the issued document is
   * printed with the user's last print settings. Nothing prints unless it was issued: a document
   * that could not be issued stays a draft, and the form says why.
   */
  async function issueFromForm(print: boolean) {
    if (issuing.value) return
    issuing.value = true
    issuingWithPrint.value = print
    issueError.value = ''
    try {
      const id = await saveIfNeeded()
      if (!id) return
      const outcome = await issuer.issue({ _id: id, type: config.apiType }, async () => {
        await loadDocument()
        if (print) await onExportSingle({ ...lastPrint.value, companions: [] })
      })
      // Refused: the draft as stored, with the reason on it. ('transfer': the dialog is open, and
      // confirming it issues — and prints — the document.)
      if (outcome === 'failed') await loadDocument()
    } finally {
      issuing.value = false
      issuingWithPrint.value = false
    }
  }

  /** FR-22.21: a credit or debit note for this invoice — its form opens on the invoice's customer and lines. */
  function openNote(type: 'credit_note' | 'debit_note') {
    const id = route.params.id
    if (!id) return
    router.push({
      name: config.direction === 'incoming' ? 'invoicing.purchases.new' : 'invoicing.sales.new',
      query: { type, relatedInvoiceId: String(id) },
    })
  }

  /**
   * FR-22.22 — „Преобразувай във фактура" on the proforma: the invoice it becomes opens at once,
   * ready to be issued. The list used to stay where it was, the new invoice only a link in its row.
   * A proforma that is new or edited is saved first.
   */
  const converting = ref(false)
  async function onConvert() {
    if (converting.value) return
    converting.value = true
    try {
      const id = await saveIfNeeded()
      if (!id) return
      const { data } = await httpClient.post(`${orgUrl()}/invoices/${id}/convert`)
      showSuccess(t('invoicing.convertedToInvoice'))
      const invoiceId = data?.invoice?.id || data?.invoice?._id
      if (invoiceId) await router.push({ name: 'invoicing.sales.edit', params: { id: String(invoiceId) } })
    } catch (e: any) {
      showError(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      converting.value = false
    }
  }

  // ── data loading ──
  async function fetchContacts(search?: string) {
    loadingContacts.value = true
    try {
      // FR-22.25: this document's side first, the most recently used at the top — customers on
      // an outgoing document, suppliers on an incoming one.
      const params: Record<string, any> = {
        ...(config.contactFetchParams || {}),
        size: 20,
        prefer: config.direction === 'incoming' ? 'supplier' : 'customer',
      }
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
      // A bill's lines take their product's current values before the clean state is taken:
      // seeding is loading, not an edit, and must not leave an untouched bill "unsaved".
      await seedUnseededLines()
      // What was just loaded is the clean state. The composable's own snapshot runs on a 500 ms
      // timer from mount, so a slower load used to count as an edit: leaving an untouched
      // document asked to keep "unsaved changes". After a save that stays on the document
      // (FR-22.16) this also re-arms the guard the save had stood down.
      markClean()
    } catch {
      /* */
    }
  }

  onMounted(async () => {
    const tasks: Promise<any>[] = [fetchContacts(), fetchWarehouses()]
    if (config.showRelatedInvoice) tasks.push(fetchInvoices())
    // The switch starts on: the category column's options are loaded as the switch would load them.
    if (grColumnsVisible.value) tasks.push(fetchGRCategories())
    await Promise.all(tasks)
    userDefaultWarehouseId.value = loadUserDefaultWarehouse()
    if (tryRestore()) {
      syncDocLevelFromLines()
      void seedUnseededLines()
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
      else seedPlaceOfDeal()
      fetchPeekedNumber()
      // FR-22.26: how this user last paid a document of this type.
      const method = rememberedPaymentMethod()
      if (method !== null) form.paymentMethod = method
      // FR-22.24: a copy starts as its source; FR-22.21: a note opened from the invoice it
      // corrects starts as that invoice; FR-22.47: a document opened from an article starts with
      // it on the first line.
      const copyOf = String(route.query.copyOf || '')
      const relatedId = String(route.query.relatedInvoiceId || '')
      const productId = String(route.query.productId || '')
      if (copyOf) await prefillFromCopy(copyOf)
      else if (relatedId && config.relatedInvoiceAutofill) await prefillFromInvoice(relatedId)
      else if (productId) await prefillFromProduct(productId)
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
    attachDialogOpen,
    onAttached,
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
    onWithProductUpdateChange,
    productUpdateOffered,
    foreignBillCurrency,
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
    // FR-22.20: one click, the user's last settings; the options one click further
    lastPrint,
    onPrint,
    onPrintOptions,
    // a supplier bill's „Стокова разписка"
    stockReceipts,
    stockReceiptLoading,
    onPrintStockReceipt,
    // persistence
    buildPayload,
    onSave,
    submitCreate,
    isDirtyNow,
    // FR-22.33: save and receive; and what a linker needs to reload the bill it changed
    onSaveAndReceive,
    receiving,
    receiptOverlap,
    saveIfNeeded,
    loadDocument,
    markSaved,
    /** A linker that made this new document itself tells the view it is the same document (FR-22.16). */
    adoptCreated: (id: string) => opts.onCreated?.(id),
    // FR-22.17/.18: issue from the form, and the stock check in front of it
    issuable,
    isDraftDoc,
    issuing,
    issueFromForm,
    issueError,
    transfer: issuer.transfer,
    confirmTransfers: issuer.confirmTransfers,
    // FR-22.27: place of deal
    showPlaceOfDeal,
    // FR-22.21 / FR-22.22
    correctable,
    openNote,
    convertible,
    onConvert,
    converting,
    // misc
    orgUrl,
    appStore,
  }
}
