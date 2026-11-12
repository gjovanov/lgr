<template>
  <v-dialog
    :model-value="modelValue"
    max-width="1500"
    scrollable
    @update:model-value="onModel"
  >
    <v-card data-testid="order-dialog" :data-kind="kind">
      <v-toolbar color="surface" flat density="compact">
        <v-toolbar-title class="text-body-1 font-weight-bold">
          {{ kind === 'supplier' ? $t('productOrders.dialog.supplierTitle') : $t('productOrders.dialog.customerTitle') }}
        </v-toolbar-title>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" :aria-label="$t('common.close')" data-testid="order-close" @click="close" />
      </v-toolbar>

      <v-card-text class="pa-4">
        <v-progress-linear v-if="loading" indeterminate class="mb-2" />
        <v-alert v-if="loadError" type="error" variant="tonal" density="compact" class="mb-3" data-testid="order-load-error">{{ loadError }}</v-alert>

        <template v-if="!loadError && !loading">
          <p class="text-body-2 text-medium-emphasis mb-3" data-testid="order-intro">
            {{ kind === 'supplier' ? $t('productOrders.dialog.introSupplier', { n: rows.length }) : $t('productOrders.dialog.introCustomer', { n: rows.length }) }}
          </p>

          <!-- A customer order: who it is for, and by when. -->
          <v-row v-if="kind === 'customer'" dense class="mb-2">
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="clientId"
                :items="clientSearch.contacts.value"
                :loading="clientSearch.loading.value"
                :item-title="contactTitle"
                item-value="_id"
                :label="$t('productOrders.dialog.client')"
                :rules="[(v: unknown) => !!v || $t('validation.required')]"
                no-filter
                density="compact"
                hide-details="auto"
                data-testid="order-client"
                @update:search="clientSearch.onSearch"
              />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field
                v-model="deliveryDate"
                type="date"
                :label="$t('productOrders.dialog.deliveryDate')"
                :rules="[(v: unknown) => !!v || $t('validation.required')]"
                density="compact"
                hide-details="auto"
                data-testid="order-delivery"
              />
            </v-col>
            <v-col cols="6" md="2">
              <v-select
                v-model="priority"
                :items="priorityOptions"
                item-title="title"
                item-value="value"
                :label="$t('productOrders.dialog.priority')"
                density="compact"
                hide-details="auto"
                data-testid="order-priority"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-select
                v-model="preferredWarehouse"
                :items="warehouseOptions"
                item-title="name"
                item-value="_id"
                :label="$t('productOrders.dialog.preferredWarehouse')"
                clearable
                density="compact"
                hide-details="auto"
                data-testid="order-warehouse-pref"
              />
            </v-col>
          </v-row>

          <div class="order-rows-wrap">
            <v-table density="compact" class="order-rows" data-testid="order-rows">
              <thead>
                <tr>
                  <th>{{ $t('productOrders.dialog.article') }}</th>
                  <th>{{ $t('productOrders.dialog.unit') }}</th>
                  <th class="text-end">{{ $t('productOrders.dialog.onHand') }}</th>
                  <th class="text-end">{{ $t('productOrders.dialog.reserved') }}</th>
                  <template v-if="kind === 'supplier'">
                    <th class="text-end">{{ $t('productOrders.dialog.onOrder') }}</th>
                    <th class="text-end">{{ $t('productOrders.dialog.min') }}</th>
                  </template>
                  <th class="order-qty-col">{{ $t('productOrders.dialog.quantity') }}</th>
                  <template v-if="kind === 'supplier'">
                    <th class="order-supplier-col">{{ $t('productOrders.dialog.supplier') }}</th>
                    <th class="order-price-col">{{ $t('productOrders.dialog.price') }}</th>
                    <th class="order-warehouse-col">{{ $t('productOrders.dialog.warehouse') }}</th>
                  </template>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.productId" data-testid="order-row" :data-product-id="row.productId">
                  <td>
                    <div class="font-weight-medium">{{ row.name }}</div>
                    <div class="text-caption text-medium-emphasis">{{ row.sku }}</div>
                  </td>
                  <td>{{ row.unit }}</td>
                  <td class="text-end">{{ fmt(row.onHand) }}</td>
                  <td class="text-end">{{ fmt(row.reserved) }}</td>
                  <template v-if="kind === 'supplier'">
                    <td class="text-end">{{ fmt(row.onOrder) }}</td>
                    <td class="text-end">{{ row.minStockLevel ? fmt(row.minStockLevel) : '–' }}</td>
                  </template>
                  <td class="order-qty-col">
                    <v-text-field
                      v-model="row.quantity"
                      type="number"
                      min="0"
                      step="any"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :error="!validQuantity(row.quantity)"
                      :aria-label="$t('productOrders.dialog.quantity')"
                      data-testid="order-qty"
                    />
                  </td>
                  <template v-if="kind === 'supplier'">
                    <td class="order-supplier-col">
                      <v-autocomplete
                        v-model="row.supplierId"
                        :items="supplierItems(row)"
                        item-title="name"
                        item-value="supplierId"
                        :placeholder="$t('productOrders.dialog.chooseSupplier')"
                        density="compact"
                        variant="outlined"
                        hide-details
                        no-filter
                        :error="!row.supplierId"
                        :aria-label="$t('productOrders.dialog.supplier')"
                        data-testid="order-supplier"
                        @update:model-value="(id: string | null) => onSupplierPicked(row, id)"
                        @update:search="supplierSearch.onSearch"
                      />
                    </td>
                    <td class="order-price-col">
                      <v-text-field
                        v-model="row.price"
                        type="number"
                        min="0"
                        step="any"
                        density="compact"
                        variant="outlined"
                        hide-details
                        :aria-label="$t('productOrders.dialog.price')"
                        data-testid="order-price"
                      />
                    </td>
                    <td class="order-warehouse-col">
                      <v-select
                        v-model="row.warehouseId"
                        :items="warehouseOptions"
                        item-title="name"
                        item-value="_id"
                        density="compact"
                        variant="outlined"
                        hide-details
                        :aria-label="$t('productOrders.dialog.warehouse')"
                        data-testid="order-warehouse"
                      />
                    </td>
                  </template>
                </tr>
              </tbody>
            </v-table>
          </div>

          <!-- A supplier order: one supplier for every row at once, and the open draft to add to instead. -->
          <v-row v-if="kind === 'supplier'" dense class="mt-3">
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="bulkSupplier"
                :items="allSupplierItems"
                item-title="name"
                item-value="supplierId"
                :label="$t('productOrders.dialog.setAllSuppliers')"
                :placeholder="$t('productOrders.dialog.chooseSupplier')"
                density="compact"
                hide-details
                no-filter
                clearable
                data-testid="order-supplier-all"
                @update:model-value="setAllSuppliers"
                @update:search="supplierSearch.onSearch"
              />
            </v-col>
            <v-col v-if="drafts.length" cols="12" md="5">
              <v-select
                v-model="appendTo"
                :items="draftItems"
                item-title="title"
                item-value="value"
                :label="$t('productOrders.dialog.appendTo')"
                density="compact"
                hide-details
                data-testid="order-append"
              />
            </v-col>
          </v-row>
          <v-alert v-if="appendTo && alreadyThere" type="warning" variant="tonal" density="compact" class="mt-2" data-testid="order-append-warning">
            {{ $t('productOrders.dialog.appendWarn', { n: alreadyThere }) }}
          </v-alert>
        </template>

        <v-alert v-if="submitError" type="error" variant="tonal" density="compact" class="mt-3" data-testid="order-error">{{ submitError }}</v-alert>
      </v-card-text>

      <v-card-actions class="px-4 pb-3">
        <span v-if="kind === 'supplier' && missing > 0 && !loading && !loadError" class="text-body-2 text-error" data-testid="order-missing">
          {{ $t('productOrders.dialog.needSupplier', { n: missing }) }}
        </span>
        <v-spacer />
        <v-btn variant="text" data-testid="order-cancel" @click="close">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!canSubmit"
          :loading="submitting"
          data-testid="order-create"
          @click="submit"
        >
          {{ kind === 'supplier' ? $t('productOrders.dialog.createSupplier') : $t('productOrders.dialog.createCustomer') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { numberFormat } from '../../composables/number-display'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../../composables/useHttpClient'
import { contactTitle, useContactSearch } from '../../composables/useContactSearch'

/**
 * FR-28.19 — the two order dialogs of the Products list, one component: "Create supplier order" and "Create customer
 * order". One row per selected article from ONE server call (`orders/from-products/preview`), which also resolves "all
 * that match the filter" and computes the defaults, so every client gets the same ones. The user edits quantity,
 * supplier, price and warehouse; the result is ONE draft, which the page opens (FR-22.35: no number lives only in a
 * snackbar).
 *
 * The dialog makes \`requestId\` ONCE per open and reuses it for every attempt: a double click, or a retry after a
 * dropped answer, is one request to the server (FR-28.17). Closing keeps the page's selection; a created order is
 * announced with \`created\` and the page clears it.
 */

interface PreviewSupplier { supplierId: string; name: string; lastUnitPrice?: number; currency?: string }
interface PreviewRow {
  productId: string; sku: string; name: string; unit: string
  onHand: number; reserved: number; onOrder: number; minStockLevel: number; maxStockLevel: number
  suggestedQuantity: number
  suppliers?: PreviewSupplier[]; supplierId?: string; expectedUnitPrice?: number; warehouseId?: string
}
interface Row extends Omit<PreviewRow, 'supplierId' | 'warehouseId' | 'expectedUnitPrice'> {
  quantity: string
  supplierId: string | null
  price: string
  warehouseId: string | null
}

const props = defineProps<{
  modelValue: boolean
  kind: 'supplier' | 'customer'
  orgUrl: string
  /** The selection as the preview takes it: `{ productIds?, filter?, warehouseId? }` (`useProductSelection().body()`). */
  selection: { productIds?: string[]; filter?: Record<string, string>; warehouseId?: string }
  /** A BCP 47 tag, for quantities. */
  locale?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  created: [result: { kind: 'supplier' | 'customer'; order: any; skipped: Array<{ productId: string; reason: string }> }]
}>()

const { t } = useI18n()

const loading = ref(false)
const loadError = ref('')
const rows = ref<Row[]>([])
const warehouseOptions = ref<Array<{ _id: string; name: string }>>([])
const requestId = ref('')
const submitting = ref(false)
const submitError = ref('')

// supplier order
const bulkSupplier = ref<string | null>(null)
const drafts = ref<Array<{ _id: string; orderNumber: string }>>([])
const appendTo = ref<string | null>(null)
const alreadyThere = ref(0)

// customer order
const clientId = ref<string | null>(null)
const deliveryDate = ref('')
const priority = ref<'low' | 'normal' | 'high' | 'urgent'>('normal')
const preferredWarehouse = ref<string | null>(null)
const priorityOptions = computed(() => (['low', 'normal', 'high', 'urgent'] as const).map((p) => ({ value: p, title: t(`invoicing.priority.${p}`) })))

const clientSearch = useContactSearch({ orgUrl: () => props.orgUrl, type: () => 'customer', selected: () => [clientId.value] })
const supplierSearch = useContactSearch({ orgUrl: () => props.orgUrl, type: () => 'supplier', selected: () => rows.value.map((r) => r.supplierId), size: 50 })

const fmt = (n: number) => numberFormat(props.locale || 'en-US', { maximumFractionDigits: 3 }).format(n || 0)
const validQuantity = (q: string) => Number.isFinite(Number(q)) && Number(q) > 0 && String(q).trim() !== ''

/** The supplier a row offers: the article's own suppliers first (default order), then every supplier contact found. */
function supplierItems(row: Row): Array<{ supplierId: string; name: string }> {
  const own = (row.suppliers ?? []).map((s) => ({ supplierId: s.supplierId, name: s.name }))
  const known = new Set(own.map((s) => s.supplierId))
  const rest = supplierSearch.contacts.value.filter((c) => !known.has(c._id)).map((c) => ({ supplierId: c._id, name: contactTitle(c) }))
  return [...own, ...rest]
}
const allSupplierItems = computed(() => supplierSearch.contacts.value.map((c) => ({ supplierId: c._id, name: contactTitle(c) })))
const draftItems = computed(() => [
  { value: null as string | null, title: t('productOrders.dialog.newOrder') },
  ...drafts.value.map((d) => ({ value: d._id as string | null, title: d.orderNumber })),
])

const missing = computed(() => rows.value.filter((r) => !r.supplierId).length)
const quantitiesOk = computed(() => rows.value.length > 0 && rows.value.every((r) => validQuantity(r.quantity)))
const canSubmit = computed(() => {
  if (submitting.value || loading.value || loadError.value || !quantitiesOk.value) return false
  if (props.kind === 'supplier') return missing.value === 0
  return !!clientId.value && !!deliveryDate.value
})

/** Setting a row's supplier takes that supplier's last price (when the preview knew it) over the article's cost price. */
function onSupplierPicked(row: Row, id: string | null) {
  const fact = (row.suppliers ?? []).find((s) => s.supplierId === id)
  if (fact?.lastUnitPrice != null) row.price = String(fact.lastUnitPrice)
}

function setAllSuppliers(id: string | null) {
  if (!id) return
  for (const r of rows.value) {
    r.supplierId = id
    onSupplierPicked(r, id)
  }
}

const newRequestId = (): string => {
  const c = (globalThis as any).crypto
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

async function open() {
  loading.value = true
  loadError.value = ''
  submitError.value = ''
  submitting.value = false
  rows.value = []
  bulkSupplier.value = null
  appendTo.value = null
  alreadyThere.value = 0
  clientId.value = null
  deliveryDate.value = ''
  priority.value = 'normal'
  preferredWarehouse.value = null
  // ONE id for this opening: every attempt to create reuses it, so the server answers a repeat with the same order.
  requestId.value = newRequestId()
  try {
    const [preview, warehouses] = await Promise.all([
      httpClient.post(`${props.orgUrl}/invoicing/orders/from-products/preview`, { ...props.selection, kind: props.kind }),
      httpClient.get(`${props.orgUrl}/warehouse/warehouse`, { params: { size: 0 } }),
    ])
    warehouseOptions.value = (warehouses.data.warehouses || []).filter((w: any) => w.isActive !== false).map((w: any) => ({ _id: String(w._id), name: w.name }))
    rows.value = (preview.data.rows as PreviewRow[]).map((r) => reactive<Row>({
      ...r,
      quantity: String(r.suggestedQuantity),
      supplierId: r.supplierId ?? null,
      price: r.expectedUnitPrice != null ? String(r.expectedUnitPrice) : '',
      warehouseId: r.warehouseId ?? null,
    }))
    if (!rows.value.length) loadError.value = t('productOrders.dialog.empty')
    if (props.kind === 'supplier') {
      void supplierSearch.search('')
      void loadDrafts()
    } else {
      void clientSearch.search('')
    }
  } catch (e: any) {
    const data = e?.response?.data
    loadError.value = data?.code === 'selection_too_large'
      ? t('productOrders.bar.tooMany', { max: data.max ?? 500 })
      : data?.message || t('productOrders.dialog.loadFailed')
  } finally {
    loading.value = false
  }
}

/** The open draft supplier orders the lines can be added to instead of making a new one (FR-22.42). */
async function loadDrafts() {
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/invoicing/orders`, { params: { status: 'draft', size: 10, sortBy: 'createdAt', sortOrder: 'desc' } })
    drafts.value = (data.orders || []).map((o: any) => ({ _id: String(o._id), orderNumber: o.orderNumber || o.number }))
  } catch {
    drafts.value = []
  }
}

// A draft chosen: how many of the articles are on it already (the dialog warns; the server appends, never merges).
watch(appendTo, async (id) => {
  alreadyThere.value = 0
  if (!id) return
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/invoicing/orders/${id}`)
    const there = new Set<string>()
    for (const g of data.order?.supplierGroups || []) for (const l of g.lines || []) if (l.productId) there.add(String(l.productId))
    if (appendTo.value === id) alreadyThere.value = rows.value.filter((r) => there.has(r.productId)).length
  } catch { /* the warning is a courtesy */ }
})

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  submitError.value = ''
  try {
    const url = props.kind === 'supplier'
      ? `${props.orgUrl}/invoicing/orders/from-products`
      : `${props.orgUrl}/invoicing/internal-orders/from-products`
    const body = props.kind === 'supplier'
      ? {
          requestId: requestId.value,
          items: rows.value.map((r) => ({
            productId: r.productId,
            quantity: Number(r.quantity),
            supplierId: r.supplierId,
            warehouseId: r.warehouseId,
            ...(String(r.price).trim() !== '' && Number.isFinite(Number(r.price)) ? { expectedUnitPrice: Number(r.price) } : {}),
          })),
          ...(appendTo.value ? { appendToOrderId: appendTo.value } : {}),
        }
      : {
          requestId: requestId.value,
          contactId: clientId.value,
          requestedDeliveryDate: deliveryDate.value,
          priority: priority.value,
          ...(preferredWarehouse.value ? { warehouseId: preferredWarehouse.value } : {}),
          items: rows.value.map((r) => ({ productId: r.productId, quantity: Number(r.quantity) })),
        }
    const { data } = await httpClient.post(url, body)
    emit('created', { kind: props.kind, order: data.order, skipped: data.skipped || [] })
    emit('update:modelValue', false)
  } catch (e: any) {
    const data = e?.response?.data
    // The same requestId goes again on the next press: a request that did reach the server is not made twice.
    submitError.value = data?.message || t('common.operationFailed')
  } finally {
    submitting.value = false
  }
}

function close() { emit('update:modelValue', false) }
function onModel(v: boolean) { if (!v) close() }

watch(() => props.modelValue, (isOpen) => { if (isOpen) void open() }, { immediate: true })
</script>

<style scoped>
.order-rows-wrap { overflow-x: auto; }
.order-qty-col { width: 110px; min-width: 96px; }
.order-supplier-col { min-width: 240px; }
.order-price-col { width: 120px; min-width: 100px; }
.order-warehouse-col { min-width: 150px; }
</style>
