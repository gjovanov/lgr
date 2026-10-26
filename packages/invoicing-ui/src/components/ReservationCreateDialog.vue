<template>
  <v-dialog :model-value="modelValue" max-width="640" scrollable @update:model-value="(v: boolean) => { if (!v) close() }" @after-enter="focusFirst">
    <v-card data-testid="reservation-create">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="primary">{{ repeat ? 'mdi-restore' : 'mdi-lock-plus-outline' }}</v-icon>
        {{ repeat ? $t('invoicing.reservations.againTitle', { number: repeatNumber }) : $t('invoicing.reservations.create') }}
      </v-card-title>
      <v-card-text>
        <p v-if="repeat" class="text-body-2 text-medium-emphasis mb-3">{{ $t('invoicing.reservations.againHint', { number: repeatNumber }) }}</p>
        <!-- FR-22.37: why the API refused it, where the user is looking. -->
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" role="alert" data-testid="reservation-create-error">{{ error }}</v-alert>

        <v-autocomplete
          ref="clientRef"
          v-model="contactId"
          :items="clients.contacts.value"
          :item-title="contactTitle"
          item-value="_id"
          :label="$t('invoicing.customer')"
          :loading="clients.loading.value"
          no-filter
          density="compact"
          variant="outlined"
          class="mb-2"
          @update:search="onClientSearch"
          @update:model-value="onClientPicked"
        />

        <v-autocomplete
          ref="productRef"
          v-model="productId"
          :items="products"
          item-title="label"
          item-value="_id"
          :label="$t('invoicing.product')"
          :placeholder="$t('invoicing.searchProduct')"
          :loading="loadingProducts"
          :readonly="!!repeat"
          no-filter
          density="compact"
          variant="outlined"
          class="mb-2"
          @update:search="onProductSearch"
          @update:model-value="onProductPicked"
        >
          <template #item="{ item, props: itemProps }">
            <v-list-item v-bind="itemProps" :subtitle="[item.raw.sku, item.raw.unit].filter(Boolean).join(' · ')" />
          </template>
        </v-autocomplete>

        <v-text-field
          ref="qtyRef"
          v-model.number="quantity"
          type="number"
          min="0"
          :label="$t('invoicing.qty')"
          :suffix="unitLabel(product?.unit)"
          :error-messages="quantityProblem"
          density="compact"
          variant="outlined"
          class="mb-1"
          style="max-width: 260px"
          @keydown.enter.prevent="canSubmit && submit()"
        />

        <div class="text-subtitle-2 mb-1">{{ $t('invoicing.reservations.sourceLabel') }}</div>
        <div v-if="!productId" class="text-body-2 text-medium-emphasis mb-2">{{ $t('invoicing.reservations.chooseProduct') }}</div>
        <v-progress-linear v-else-if="loadingSources && !sources" indeterminate class="mb-2" />
        <v-alert v-else-if="!options.length" type="info" variant="tonal" density="compact" class="mb-2" data-testid="reservation-no-sources">
          {{ $t('invoicing.reservations.noSources') }}
        </v-alert>
        <v-radio-group
          v-else
          v-model="sourceKey"
          hide-details
          density="compact"
          class="mb-1"
          :aria-label="$t('invoicing.reservations.sourceLabel')"
          @update:model-value="sourceTouched = true"
        >
          <template v-if="stockOptions.length">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.reservations.fromStock') }}</div>
            <v-radio v-for="o in stockOptions" :key="o.key" :value="o.key">
              <template #label>
                <span>{{ o.stock.warehouseName }}</span>
                <span class="text-caption text-medium-emphasis ms-2">{{ $t('invoicing.freeQty') }}: {{ o.free }}</span>
              </template>
            </v-radio>
          </template>
          <template v-if="orderOptions.length">
            <div class="text-caption text-medium-emphasis mt-1">{{ $t('invoicing.reservations.fromOrders') }}</div>
            <v-radio v-for="o in orderOptions" :key="o.key" :value="o.key">
              <template #label>
                <div class="py-1">
                  <div>{{ o.allocation.orderNumber }} · {{ o.allocation.warehouseName }}</div>
                  <div class="text-caption text-medium-emphasis">
                    {{ o.allocation.supplierName }}<template v-if="o.allocation.expectedDate"> · {{ $t('invoicing.expectedDate') }} {{ o.allocation.expectedDate.split('T')[0] }}</template>
                    · {{ $t('invoicing.freeQty') }}: {{ o.free }}
                  </div>
                </div>
              </template>
            </v-radio>
          </template>
        </v-radio-group>

        <v-select
          v-if="demandItems.length"
          v-model="lineKey"
          :items="demandItems"
          item-title="title"
          item-value="value"
          :label="$t('invoicing.reservations.forOrder')"
          :hint="$t('invoicing.reservations.forOrderHint')"
          persistent-hint
          clearable
          density="compact"
          variant="outlined"
          class="mt-3"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="close">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="!canSubmit" @click="submit">{{ $t('invoicing.reserve') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useContactSearch, contactTitle } from 'ui-shared/composables/useContactSearch'
import { useAppStore } from '../store/app.store'
import {
  defaultSourceKey, demandKey, keyOfReservation, sourceBody, sourceOptions,
  type ReservationSources,
} from '../composables/reservation-form'
import { reservationErrorMessage } from '../composables/reservation-errors'

/**
 * FR-22.37: a reservation made on the Reservations list — a client, a product, a quantity, and
 * where the goods come from: free stock in a warehouse, or room on a supplier order that is out to
 * the supplier; optionally for one of the client's open incoming orders. Only what the API would
 * accept is offered (`GET /reservations/sources`), and a refusal is said here, in the dialog.
 *
 * With `repeat`, the same dialog makes a cancelled reservation again (`POST /:id/repeat`): its
 * product fixed, everything else pre-filled and changeable — the way to move it to another source
 * or client (D-4), and where a repeat whose source has run dry lands (FR-22 §5.7).
 */
const props = defineProps<{
  modelValue: boolean
  repeat?: any | null
  /** Why repeating it as it was failed: shown when the dialog opens. */
  repeatError?: string
  /** Open on this product (`/reservations/new?productId=…`). */
  presetProductId?: string | null
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** `created` is false when another request had already repeated it: `reservation` is that copy. */
  created: [reservation: any, created: boolean]
}>()

const { t, te } = useI18n()
const appStore = useAppStore()
const orgUrl = () => appStore.orgUrl()
const unitLabel = (u?: string) => (u && te(`warehouse.uomShort.${u}`) ? t(`warehouse.uomShort.${u}`) : u || '')

const clientRef = ref<any>()
const productRef = ref<any>()
const qtyRef = ref<any>()

const contactId = ref<string | null>(null)
const productId = ref<string | null>(null)
const products = ref<Array<{ _id: string; name: string; sku?: string; unit?: string; label: string }>>([])
const loadingProducts = ref(false)
const quantity = ref<number>(1)
const sources = ref<ReservationSources | null>(null)
const loadingSources = ref(false)
const sourceKey = ref<string | null>(null)
/** The source asked for before the sources arrive: the repeated reservation's own. */
const preferredKey = ref<string | null>(null)
const lineKey = ref<string | null>(null)
const error = ref('')
const saving = ref(false)

const repeatNumber = computed(() => props.repeat?.reservationNumber || props.repeat?.number || '')
const product = computed(() => products.value.find((p) => p._id === productId.value) || null)

const clients = useContactSearch({ orgUrl, type: () => 'customer', selected: () => [contactId.value] })

const options = computed(() => sourceOptions(sources.value))
const stockOptions = computed(() => options.value.flatMap((o) => (o.kind === 'stock' ? [o] : [])))
const orderOptions = computed(() => options.value.flatMap((o) => (o.kind === 'order' ? [o] : [])))
const demand = computed(() => sources.value?.demand || [])
const demandItems = computed(() => demand.value.map((d) => ({
  value: demandKey(d.internalOrderId, d.lineId),
  title: t('invoicing.reservations.orderLine', { number: d.internalOrderNumber, quantity: d.quantity, open: d.open }),
})))
const selected = computed(() => options.value.find((o) => o.key === sourceKey.value) || null)
const selectedLine = computed(() => demand.value.find((d) => demandKey(d.internalOrderId, d.lineId) === lineKey.value) || null)

const quantityProblem = computed(() => {
  const q = Number(quantity.value) || 0
  if (selected.value && q > selected.value.free + 1e-9) return t('invoicing.reservations.onlyFree', { free: selected.value.free })
  if (selectedLine.value && q > selectedLine.value.open + 1e-9) {
    return t('invoicing.reservations.onlyOpen', { open: selectedLine.value.open, number: selectedLine.value.internalOrderNumber })
  }
  return ''
})
const canSubmit = computed(() =>
  !!contactId.value && !!productId.value && Number(quantity.value) > 0 && !!selected.value && !quantityProblem.value && !saving.value)

// ── loading ──
let sourcesRequest = 0
async function loadSources() {
  if (!productId.value) {
    sources.value = null
    sourceKey.value = null
    return
  }
  const mine = ++sourcesRequest
  loadingSources.value = true
  try {
    const params: Record<string, string> = { productId: productId.value }
    if (contactId.value) params.contactId = contactId.value
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/reservations/sources`, { params })
    if (mine !== sourcesRequest) return
    sources.value = data
    sourceKey.value = defaultSourceKey(options.value, quantity.value, sourceKey.value || preferredKey.value)
    if (lineKey.value && !demand.value.some((d) => demandKey(d.internalOrderId, d.lineId) === lineKey.value)) lineKey.value = null
  } catch (e: any) {
    if (mine === sourcesRequest) error.value = reservationErrorMessage(e, t)
  } finally {
    if (mine === sourcesRequest) loadingSources.value = false
  }
}

let productTimer: ReturnType<typeof setTimeout> | null = null
let productRequest = 0
function onProductSearch(text: string | null) {
  // Vuetify writes the chosen product's title back into the box: that is not a query.
  if (!text || text === product.value?.label) return
  if (productTimer) clearTimeout(productTimer)
  productTimer = setTimeout(() => searchProducts(text), 300)
}
async function searchProducts(text: string) {
  const mine = ++productRequest
  loadingProducts.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/product`, { params: { search: text, size: 10 } })
    if (mine !== productRequest) return
    const found = (data.products || []).map(asOption)
    // Keep the chosen product resolvable while the list shows other matches.
    const keep = product.value && !found.some((p: any) => p._id === product.value!._id) ? [product.value] : []
    products.value = [...keep, ...found]
  } catch { /* keep what is shown */ } finally {
    if (mine === productRequest) loadingProducts.value = false
  }
}
function asOption(p: any) {
  const id = String(p._id || p.id)
  return { _id: id, name: p.name, sku: p.sku, unit: p.unit, label: p.sku ? `${p.name} (${p.sku})` : p.name }
}
async function loadProduct(id: string) {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/product/${id}`)
    if (data?.product) products.value = [asOption(data.product)]
  } catch { /* the field stays empty */ }
}

let clientTimer: ReturnType<typeof setTimeout> | null = null
function onClientSearch(text: string | null) {
  const chosen = clients.contacts.value.find((c) => c._id === contactId.value)
  if (chosen && text === contactTitle(chosen)) return
  clients.onSearch(text)
}

/** Moves the cursor on once the autocomplete has finished with its own focus. */
function focusSoon(target: { value: any }, select = false) {
  nextTick(() => setTimeout(() => {
    target.value?.focus?.()
    if (select) target.value?.select?.()
  }, 0))
}
function focusFirst() {
  if (props.repeat) focusSoon(qtyRef, true)
  else if (!contactId.value) focusSoon(clientRef)
  else if (!productId.value) focusSoon(productRef)
  else focusSoon(qtyRef, true)
}

function onClientPicked(id: string | null) {
  error.value = ''
  // The client's own open orders for the product come with the sources.
  if (clientTimer) clearTimeout(clientTimer)
  clientTimer = setTimeout(loadSources, 0)
  if (id) focusSoon(productId.value ? qtyRef : productRef, !!productId.value)
}
function onProductPicked(id: string | null) {
  error.value = ''
  sourceKey.value = null
  sourceTouched.value = false
  lineKey.value = null
  loadSources()
  if (id) focusSoon(qtyRef, true)
}

/**
 * Until the user picks a source, the dialog keeps the one that holds the quantity typed: 3 come
 * from the default warehouse, 30 from wherever 30 are free. `sourceTouched` is set by the radio
 * group's own update event, which a programmatic change does not fire.
 */
const sourceTouched = ref(false)
watch(quantity, (q) => {
  if (sourceTouched.value || !options.value.length) return
  sourceKey.value = defaultSourceKey(options.value, q, preferredKey.value)
})

// ── open / close ──
watch(() => props.modelValue, async (open) => {
  if (!open) return
  error.value = props.repeatError || ''
  saving.value = false
  sources.value = null
  sourceKey.value = null
  sourceTouched.value = false
  const r = props.repeat
  if (r) {
    contactId.value = String(r.contactId || '') || null
    productId.value = r.productId ? String(r.productId) : null
    products.value = productId.value
      ? [{ _id: productId.value, name: r.productName || '', sku: r.productSku, unit: r.productUnit, label: r.productSku ? `${r.productName} (${r.productSku})` : (r.productName || '') }]
      : []
    quantity.value = Number(r.quantity) || 1
    preferredKey.value = keyOfReservation(r)
    lineKey.value = r.internalOrderId && r.internalOrderLineId ? demandKey(String(r.internalOrderId), String(r.internalOrderLineId)) : null
  } else {
    contactId.value = null
    productId.value = props.presetProductId || null
    products.value = []
    quantity.value = 1
    preferredKey.value = null
    lineKey.value = null
    if (productId.value) await loadProduct(productId.value)
  }
  await Promise.all([clients.ensureSelected(), clients.search(''), loadSources()])
})

function close() {
  emit('update:modelValue', false)
}

async function submit() {
  if (!canSubmit.value || !selected.value) return
  saving.value = true
  error.value = ''
  const line = selectedLine.value
  const body: Record<string, unknown> = {
    quantity: Number(quantity.value),
    contactId: contactId.value,
    ...sourceBody(selected.value),
    ...(line ? { internalOrderId: line.internalOrderId, internalOrderLineId: line.lineId } : {}),
  }
  try {
    const { data } = props.repeat
      ? await httpClient.post(`${orgUrl()}/invoicing/reservations/${props.repeat._id}/repeat`, body)
      : await httpClient.post(`${orgUrl()}/invoicing/reservations`, { productId: productId.value, ...body })
    emit('created', data.reservation, data.created !== false)
    close()
  } catch (e: any) {
    error.value = reservationErrorMessage(e, t)
    // What was free a moment ago may be taken now: show the figures as they are.
    await loadSources()
  } finally {
    saving.value = false
  }
}
</script>
