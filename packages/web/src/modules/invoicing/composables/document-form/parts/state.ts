/**
 * FR-32.22 (#797): the document form's state — what every other part of `useDocumentForm` reads and writes. The
 * app's services (i18n, route, store, messages), the org's tax and currency settings, the collections the pickers
 * read, the line and product-update columns, the form itself, its payment-method memory, the pending-changes guard,
 * and the print notes with what says the form differs from what is stored.
 *
 * ⚠ It is built FIRST: `usePendingChanges` registers its own `onMounted` here, before the form's (`load.ts#mountForm`),
 * as it always did (FR-31 A1: the clean state is taken when the load resolves).
 */
import { intlLocale } from 'ui-shared/format'
import { ref, reactive, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../../store/app.store'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaymentMethods } from 'ui-shared/composables/usePaymentMethods'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useInvoiceLineColumns } from 'ui-shared/composables/useInvoiceLineColumns'
import { useGRColumns } from 'ui-shared/composables/useGRColumns'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { jwtUserId } from 'ui-shared/composables/useStorageIdentity'
import { rememberedFlag, rememberedSetting } from 'ui-shared/composables/useUserDefaults'
import type { DocumentTypeConfig } from '../types'

export type Line = Record<string, any>

/** Concrete (non-optional) shape of the reactive form so template bindings are well-typed. */
export interface DocFormReactive {
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
export function emptyBillingAddress() {
  return { street: '', city: '', state: '', postalCode: '', country: '' }
}

export function useFormState(config: DocumentTypeConfig) {
  const { t, locale } = useI18n()
  const route = useRoute()
  const router = useRouter()
  const appStore = useAppStore()
  const { showSuccess, showError, showSnackbar } = useSnackbar()
  // FR-31.6 / .8: a document that did not load says so; a refused save stays at the top of the form.
  const feedback = useFormFeedback()
  const { formatCurrency } = useCurrency()

  const vatRates = computed(() => appStore.currentOrg?.settings?.taxConfig?.vatRates ?? [])
  const defaultVatRate = computed(() => appStore.currentOrg?.settings?.taxConfig?.defaultVatRate ?? 0)
  const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
  const localeCode = computed(
    () => intlLocale(appStore.locale),
  )

  const isEdit = computed(() => !!route.params.id)

  // ── refs / collections ──
  const formRef = ref<any>()
  /**
   * FR-28.35: the header banner sits OUTSIDE `formRef`'s <v-form>, which is why its party select's
   * `required` has never taken part in a save. Its issue date, moved up there from inside the form,
   * was required and still has to be, so `validate()` asks the date itself as well as the form.
   * Only the date: the party select must stay out of it, or a draft could no longer be saved before
   * its party is chosen. (`DateField` exposes `validate()`; no second <form> is added to the page,
   * which specs and `.v-form` selectors would see.)
   */
  const issueDateRef = ref<{ validate: (silent?: boolean) => Promise<string[]> } | null>(null)
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
  /** FR-28.25: what the user had typed in the line's field when they asked for Details (F4, "Show all N results"). */
  const productPickerText = ref('')
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
  const { markSaved, markLoaded, isDirty: formDiffersFromStored, tryRestore } = usePendingChanges({
    appId: 'invoicing',
    entityType: config.pendingEntityType,
    icon: config.pendingIcon,
    getFormData: () => ({ ...form, lines: [...form.lines] }),
    getPreviewFields: () => [
      { label: t('common.date'), value: form.issueDate || '' },
      { label: t('common.currency'), value: form.currency || '' },
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

  // ── the print notes, and whether the form differs from what is stored ──
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
  /**
   * What the form shows now is what is stored (it was just loaded); an edit from here is unsaved. The form's own fields
   * took their clean state in `markLoaded`; the print notes, which live outside it, take theirs here.
   */
  function noteLoaded() {
    storedNotes.printNote = printNote.value
    storedNotes.companionNote = companionNote.value
    cleanTick.value++
  }

  return {
    config, t, locale, route, router, appStore, showSuccess, showError, showSnackbar, feedback, formatCurrency,
    vatRates, defaultVatRate, baseCurrency, localeCode, isEdit,
    formRef, issueDateRef, loading, loadingContacts, contacts, warehouses, invoices,
    invoiceStatus, invoiceNumber, invoiceData, peekedNumber,
    ledgerDialog, productPickerOpen, productPickerRowIdx, productPickerText, importDialogOpen,
    columnPickerOpen, selectedCols, availableLineColumns, activeLineColumns, lineColumnEntries,
    toggleCol, moveCol, reorderCol, selectAllCols, selectNoCols, resetColDefaults, isColActive, uomOptions,
    withProductUpdate, onWithProductUpdateChange, foreignBillCurrency, productUpdateOffered,
    grColumnPickerOpen, grCategories, grSelectedCols, grActiveColumns, grToggleCol, grSelectAllCols, grSelectNoCols,
    grResetColDefaults, grColumnsVisible,
    docTaxRate, docWarehouseId, userDefaultWarehouseId, userDefaultWhKey, loadUserDefaultWarehouse,
    emptyLine, form, selectedContact, paymentMethods, payMethodMemory, rememberedPaymentMethod, notesModel,
    markSaved, markLoaded, tryRestore, rules, orgUrl,
    printNote, companionNote, isDirtyNow, noteLoaded,
  }
}

export type FormState = ReturnType<typeof useFormState>
