import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { intlLocale } from 'ui-shared/format'
import { askConfirm } from 'ui-shared/composables/confirm'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction, type IdempotentAction } from 'ui-shared/composables/idempotency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import { useAppStore } from '../../store/app.store'
import { useConversionFeedback } from '../useConversionFeedback'
import { reservationErrorMessage } from '../reservation-errors'
import { cascadeSummary, type CascadeSummary } from '../order-cascade'
import { contactName, resStatusColor, type ContactPool } from './shared'

/**
 * FR-32.23 (#797): ONE base for the two order forms, the supplier order (`OrderFormView`, ORDO) and the customer order
 * (`InternalOrderFormView`, ORDI). What they share lives here: the order's identity on the screen (number, status,
 * read-only), the reservations and invoices its GET returns, the contact pools and the warehouses, the order-wide
 * actions with Cancel and Complete asking first (FR-22.41), Delete, and the number a new order will get.
 *
 * What each form is stays in the form: its lines, its tree, its save, its load. The pending-changes guard is the
 * form's too (`usePendingChanges`), called after this and before the form's `onMounted`, as it always was: the clean
 * state is taken when the load resolves (FR-31.2).
 */
export interface OrderFormSpec {
  /** Where the orders live under `/invoicing`. */
  api: 'orders' | 'internal-orders'
  /** The list the form goes back to after a delete. */
  listRoute: 'invoicing.orders' | 'invoicing.internalOrders'
  /** Which order this is, for what Cancel and Complete release (`cascadeSummary`). */
  side: 'supplier' | 'client'
  deleteConfirmKey: string
  /** The statuses in which nothing on the form can be edited. */
  readonlyStatuses: string[]
  /** The form's currency, for the amounts it shows. */
  currency: () => string | undefined
  /** The contacts the form already holds, by pool: kept among the pool's options, so their names show. */
  knownContactIds: (pool: ContactPool) => string[]
  /** The reload after an order-wide action went through. */
  reload: (path: string) => Promise<void>
  /** What the message says after an action, when it says more than the action's own words. */
  actionSaid?: (data: any) => string | undefined
  /** Complete asks first also when this says so (besides when it lets reservations go). */
  completeAsks?: () => boolean
}

export type Warehouse = { _id: string; name: string; isDefault?: boolean }
type Snackbar = ReturnType<typeof useSnackbar>
type FormFeedback = ReturnType<typeof useFormFeedback>
export interface CascadeState { open: boolean; action: 'cancel' | 'complete'; error: string; busy: boolean }

export interface OrderFormBase extends FormFeedback {
  showSuccess: Snackbar['showSuccess']
  showError: Snackbar['showError']
  showSnackbar: Snackbar['showSnackbar']
  conversion: ReturnType<typeof useConversionFeedback>
  uomOptions: ReturnType<typeof useProductUnits>['uomOptions']
  isEdit: ComputedRef<boolean>
  formRef: Ref<any>
  loading: Ref<boolean>
  saving: Ref<boolean>
  orderStatus: Ref<string>
  orderNumber: Ref<string>
  peekedNumber: Ref<string>
  documentNumber: ComputedRef<string>
  readonly: ComputedRef<boolean>
  baseCurrency: ComputedRef<string>
  localeCode: ComputedRef<string>
  rules: { required: (v: string) => string | true }
  orgUrl: () => string
  fmtCurrency: (amount: number) => string
  /** The reservations of the order, as its GET returns them. */
  reservations: Ref<any[]>
  activeReservations: ComputedRef<any[]>
  /** FR-22.36: the invoices against the order, as its GET returns them. */
  linkedInvoices: Ref<Record<string, any>>
  /** The orders on the other side, by id: the client orders of a supplier order, the supplier orders of a client order. */
  linkedOrderNumbers: Ref<Record<string, string>>
  resStatusColor: (status: string) => string
  clientOptions: Ref<any[]>
  supplierOptions: Ref<any[]>
  loadingContacts: Ref<boolean>
  contactNames: Ref<Record<string, string>>
  knownProducts: Ref<Record<string, { name: string }>>
  knownOf: (productId?: string | null) => { id: string; name: string } | null
  onContactSearch: (text: string, pool: ContactPool) => void
  fetchContacts: (pool: ContactPool, search?: string) => Promise<void>
  withKnown: (list: any[], pool: ContactPool) => any[]
  adoptContact: (c: any, pool: ContactPool) => string | null
  warehouses: Ref<Warehouse[]>
  fetchWarehouses: () => Promise<void>
  warehouseName: (id: string) => string
  createAttempt: IdempotentAction
  fetchPeekedNumber: () => Promise<void>
  deleteOrder: () => Promise<void>
  doAction: (path: string, successKey: string, opts?: { onError?: (message: string) => void }) => Promise<boolean>
  cascade: CascadeState
  cascadeNow: ComputedRef<CascadeSummary>
  cancelOrder: () => void
  completeOrder: () => void
  confirmCascade: () => Promise<void>
}

export function useOrderFormBase(spec: OrderFormSpec): OrderFormBase {
  const { t } = useI18n()
  const route = useRoute()
  const router = useRouter()
  const appStore = useAppStore()
  const { showSuccess, showError, showSnackbar } = useSnackbar()
  // FR-31.6 / .8: a record that did not load says so, with Back and Retry.
  const feedback = useFormFeedback()
  const conversion = useConversionFeedback()
  const { formatCurrency } = useCurrency()
  const { uomOptions } = useProductUnits()

  const isEdit = computed(() => !!route.params.id)
  const formRef = ref<any>()
  const loading = ref(false)
  const saving = ref(false)
  const orderStatus = ref('draft')
  const orderNumber = ref('')
  const peekedNumber = ref('')
  const documentNumber = computed(() => orderNumber.value || peekedNumber.value)
  const readonly = computed(() => spec.readonlyStatuses.includes(orderStatus.value))

  const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
  const localeCode = computed(() => intlLocale(appStore.locale))
  const rules = { required: (v: string) => !!v || t('validation.required') }

  function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
  function fmtCurrency(amount: number) { return formatCurrency(amount, spec.currency() || baseCurrency.value, localeCode.value) }
  const ordersUrl = () => `${orgUrl()}/invoicing/${spec.api}`

  // ── the reservations, the invoices and the orders on the other side, as the order's GET returns them ──
  const reservations = ref<any[]>([])
  const linkedInvoices = ref<Record<string, any>>({})
  const linkedOrderNumbers = ref<Record<string, string>>({})
  const activeReservations = computed(() => reservations.value.filter((r) => r.status !== 'cancelled'))

  // ── contacts (server-searched pools) + warehouses ──
  const clientOptions = ref<any[]>([])
  const supplierOptions = ref<any[]>([])
  const loadingContacts = ref(false)
  const warehouses = ref<Warehouse[]>([])
  const contactNames = ref<Record<string, string>>({})
  /**
   * FR-30.10: the articles as the order's read named them (`lookup.products`), so a line reads no article to show its
   * name. A line given another article reads that one, as before.
   */
  const knownProducts = ref<Record<string, { name: string }>>({})
  function knownOf(productId?: string | null): { id: string; name: string } | null {
    const p = productId ? knownProducts.value[String(productId)] : undefined
    return p ? { id: String(productId), name: p.name } : null
  }

  let contactSearchTimer: ReturnType<typeof setTimeout> | null = null
  function onContactSearch(text: string, pool: ContactPool) {
    if (contactSearchTimer) clearTimeout(contactSearchTimer)
    contactSearchTimer = setTimeout(() => fetchContacts(pool, text || undefined), 300)
  }

  /** The contacts the form already holds that have a name, as options: an id that is chosen keeps showing its name. */
  function knownEntries(pool: ContactPool) {
    const ids = [...new Set(spec.knownContactIds(pool).filter(Boolean))]
    return ids.filter((id) => contactNames.value[id]).map((id) => ({ _id: id, companyName: contactNames.value[id] }))
  }
  function withKnown(list: any[], pool: ContactPool) {
    const merged = [...list]
    for (const k of knownEntries(pool)) if (!merged.some((c: any) => c._id === k._id)) merged.push(k)
    return merged
  }

  async function fetchContacts(pool: ContactPool, search?: string) {
    loadingContacts.value = true
    try {
      // FR-30.7: the picker's rows, not whole contacts.
      // FR-30.12: a type-ahead shows no total, so nothing is counted.
      const params: Record<string, any> = { size: 20, fields: 'list', count: 'none' }
      if (pool === 'supplier') params.type = 'supplier'
      if (search) params.search = search
      const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params })
      const items = data.contacts || []
      // Keep already-selected ids resolvable by merging known entries in.
      const merged = withKnown(items, pool)
      if (pool === 'supplier') supplierOptions.value = merged
      else clientOptions.value = merged
      for (const c of items) contactNames.value[c._id] = contactName(c)
    } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ } finally {
      loadingContacts.value = false
    }
  }

  /** A contact chosen in the wide picker: its name is known from now on, and it is among the pool's options. */
  function adoptContact(c: any, pool: ContactPool): string | null {
    const id = c?._id || c?.id
    if (!id) return null
    const name = contactName(c)
    contactNames.value[id] = name
    const options = pool === 'supplier' ? supplierOptions : clientOptions
    if (!options.value.some((o) => o._id === id)) options.value = [{ _id: id, companyName: name }, ...options.value]
    return id
  }

  async function fetchWarehouses() {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } })
      warehouses.value = data.warehouses || []
    } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
  }
  function warehouseName(id: string) { return warehouses.value.find((w) => w._id === String(id))?.name || '—' }

  /**
   * FR-29.13: a new order is created under one `Idempotency-Key` per attempt, kept while its outcome is unknown, so a
   * double click or a save repeated after a timeout gets back the order the first request made instead of a second one.
   */
  const createAttempt = createIdempotentAction()

  async function fetchPeekedNumber() {
    try {
      const { data } = await httpClient.get(`${ordersUrl()}/peek-next`)
      peekedNumber.value = data.next || ''
    } catch { /* A preview only: the number is drawn on save. */ }
  }

  async function deleteOrder() {
    if (!(await askConfirm({ text: t(spec.deleteConfirmKey), confirm: t('common.delete'), danger: true }))) return
    try {
      await httpClient.delete(`${ordersUrl()}/${route.params.id}`)
      showSuccess(t('common.deletedSuccessfully'))
      void router.push({ name: spec.listRoute })
    } catch (e: any) {
      showError(reservationErrorMessage(e, t))
    }
  }

  /** True when it went through; a refusal goes to `onError` (the cascade dialog) or the snackbar. */
  async function doAction(path: string, successKey: string, opts: { onError?: (message: string) => void } = {}): Promise<boolean> {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${ordersUrl()}/${route.params.id}/${path}`)
      showSuccess(spec.actionSaid?.(data) || t(successKey))
      await spec.reload(path)
      return true
    } catch (e: any) {
      const message = reservationErrorMessage(e, t)
      if (opts.onError) opts.onError(message)
      else showError(message)
      return false
    } finally {
      loading.value = false
    }
  }

  // ── FR-22.41: Cancel and Complete say what they release before they do it ──
  const cascade = reactive<CascadeState>({ open: false, action: 'cancel', error: '', busy: false })
  const cascadeNow = computed(() => cascadeSummary(reservations.value, spec.side, linkedOrderNumbers.value))
  function openCascade(action: 'cancel' | 'complete') {
    cascade.action = action
    cascade.error = ''
    cascade.open = true
  }
  /** Cancel always asks: it cannot be undone. Complete asks when it lets reservations go (or when the form says so). */
  function cancelOrder() { openCascade('cancel') }
  function completeOrder() {
    if (cascadeNow.value.count > 0 || spec.completeAsks?.()) openCascade('complete')
    else void doAction('complete', 'invoicing.orderCompleted')
  }
  async function confirmCascade() {
    cascade.busy = true
    cascade.error = ''
    // Through doAction, so the reload after it is the form's own (a supplier order drops its staged changes).
    const ok = await doAction(cascade.action, cascade.action === 'cancel' ? 'invoicing.orderCancelled' : 'invoicing.orderCompleted', {
      onError: (message) => { cascade.error = message },
    })
    cascade.busy = false
    if (ok) cascade.open = false
  }

  return {
    ...feedback,
    showSuccess, showError, showSnackbar, conversion, uomOptions,
    isEdit, formRef, loading, saving, orderStatus, orderNumber, peekedNumber, documentNumber, readonly,
    baseCurrency, localeCode, rules, orgUrl, fmtCurrency,
    reservations, activeReservations, linkedInvoices, linkedOrderNumbers, resStatusColor,
    clientOptions, supplierOptions, loadingContacts, contactNames, knownProducts, knownOf,
    onContactSearch, fetchContacts, withKnown, adoptContact, warehouses, fetchWarehouses, warehouseName,
    createAttempt, fetchPeekedNumber, deleteOrder, doAction,
    cascade, cascadeNow, cancelOrder, completeOrder, confirmCascade,
  }
}
