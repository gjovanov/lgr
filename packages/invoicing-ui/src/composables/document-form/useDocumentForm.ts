import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaymentMethods } from 'ui-shared/composables/usePaymentMethods'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useInvoiceLineColumns } from 'ui-shared/composables/useInvoiceLineColumns'
import { useGRColumns } from 'ui-shared/composables/useGRColumns'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import type { FormAction, SmartButtonDef, StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import type { DocumentTypeConfig } from './types'
import {
  buildPayload as buildPayloadPure,
  buildProductUpdates,
  computeTotals,
  lineAmounts,
  type DocumentFormState,
} from './document-payload'

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
  const { showSuccess, showError } = useSnackbar()
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

  // ── line columns ──
  const columnPickerOpen = ref(false)
  const {
    selected: selectedCols,
    availableColumns: availableLineColumns,
    activeColumns: activeLineColumns,
    toggle: toggleCol,
    selectAll: selectAllCols,
    selectNone: selectNoCols,
    resetDefaults: resetColDefaults,
  } = useInvoiceLineColumns(config.docType, {
    userId: () => (appStore.user as any)?._id || (appStore.user as any)?.id,
    orgId: () => appStore.currentOrg?.id,
  })
  const isColActive = (key: string) => selectedCols.value.includes(key)
  const { uomOptions } = useProductUnits()
  const paymentMethods = usePaymentMethods()

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
    userId: () => (appStore.user as any)?._id || (appStore.user as any)?.id,
    orgId: () => appStore.currentOrg?.id,
  })
  const grColumnsVisible = computed(() => !!config.supportsProductUpdate && withProductUpdate.value)

  // ── doc-level single-value controls (used while the per-line column is hidden) ──
  // null docTaxRate = mixed/unset (label shows placeholder); picking a value applies to all lines.
  const docTaxRate = ref<number | null>(null)
  const docWarehouseId = ref<string | null>(null)
  const userDefaultWarehouseId = ref('')

  function userDefaultWhKey() {
    const u = (appStore.user as any)?._id || (appStore.user as any)?.id || 'anon'
    return `lgr:default-wh:${u}:${appStore.currentOrg?.id || 'no-org'}`
  }
  function loadUserDefaultWarehouse(): string {
    try {
      return localStorage.getItem(userDefaultWhKey()) || ''
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

  // The notes textarea binds to either `notes` or `reason` depending on the doc type.
  const notesModel = computed<string>({
    get: () => ((form as any)[config.notesFieldModel] as string) || '',
    set: (v: string) => {
      ;(form as any)[config.notesFieldModel] = v
    },
  })

  // ── pending changes ──
  const { markSaved, tryRestore } = usePendingChanges({
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

  function computeLineTotal(l: Line): number {
    return lineAmounts(l, config.line.hasDiscount).total
  }
  /** Net line amount (qty × unit price, before discount/tax) for the lineSubtotal column. */
  function computeLineSubtotal(l: Line): number {
    return lineAmounts(l, config.line.hasDiscount).net
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

  async function onProductSelected(idx: number, product: any) {
    const line = form.lines[idx]
    if (!line) return
    line.unitPrice = product[config.priceField] ?? 0
    line.unit = product.unit || line.unit
    if (config.resetDiscountOnProductSelect) line.discount = 0
    line.taxRate = product.taxRate ?? line.taxRate
    if (line.productId) await resolvePriceForLine(idx)
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
    if (!line?.productId) return
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
      while (existing.length < 10) {
        existing.push({ name: `Price ${existing.length + 1}`, percent: 0, finalPrice: Number(p.sellingPrice) || 0, manualOverride: false, contactIds: [], tags: [] })
      }
      line.priceTiers = existing.slice(0, 10)
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

  function onContactChange(contactId?: string) {
    const id = contactId ?? form.contactId
    if (config.captureBillingAddress && id) captureBilling(id)
    if (config.reResolveOnChange) {
      form.lines.forEach((_, i) => {
        if (form.lines[i]?.productId) resolvePriceForLine(i)
      })
    }
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
            form.lines = invoice.lines.map((l: any) => ({
              productId: l.productId || undefined,
              description: l.description || '',
              quantity: l.quantity || 1,
              unitPrice: l.unitPrice || 0,
              discount: 0,
              taxRate: l.taxRate || 0,
              warehouseId: l.warehouseId || undefined,
            }))
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
  const formActions = computed<FormAction[]>(() => {
    const save: FormAction = { label: t('common.save'), color: 'primary', handler: onSave, loading: loading.value }
    if (!isEdit.value) return [save]
    if (config.editSaveGate === 'draft-only' && invoiceStatus.value !== 'draft') return []
    return [save]
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
  const { loading: exportLoading, exportOne } = useInvoicingExport(() => appStore.orgUrl())
  async function onExportSingle(o: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns?: string[] }) {
    const id = route.params.id as string
    if (!id) return
    try {
      await exportOne(id, invoiceNumber.value || id, o.format, o.mode, o.columns, appStore.locale)
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
    return p
  }

  async function validate(): Promise<boolean> {
    if (!formRef.value) return true
    const { valid } = await formRef.value.validate()
    return valid
  }

  async function persist(payload: Record<string, any>) {
    loading.value = true
    try {
      if (isEdit.value) await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
      else await httpClient.post(`${orgUrl()}/invoices`, payload)
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

  async function fetchInvoices() {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices`, { params: { type: 'invoice' } })
      invoices.value = data.invoices || []
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
      form.supplierInvoiceNumber = inv.supplierInvoiceNumber || ''
      form.relatedInvoiceId = inv.relatedInvoiceId || ''
      form.issueDate = inv.issueDate?.split('T')[0] || inv.date?.split('T')[0] || ''
      form.dueDate = inv.dueDate?.split('T')[0] || ''
      form.validUntil = inv.validUntil?.split('T')[0] || ''
      form.currency = inv.currency || baseCurrency.value
      form.exchangeRate = inv.exchangeRate || 1
      form.paymentMethod = inv.paymentMethod || config.paymentMethodDefault
      form.notes = inv.notes || ''
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
    // form
    form,
    notesModel,
    // columns
    selectedCols,
    availableLineColumns,
    activeLineColumns,
    toggleCol,
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
    onContactChange,
    onContactCreated,
    onContactSearch,
    // export
    showExportDialog,
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
