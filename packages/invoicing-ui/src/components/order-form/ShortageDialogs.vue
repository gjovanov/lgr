<template>
  <!-- Cover-shortages dialog: free stock → unreserved incoming → preemptable reservations -->
  <v-dialog v-model="coverDialog" max-width="860" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="warning">mdi-shield-search</v-icon>
        {{ $t('invoicing.coverShortages') }}
        <v-spacer />
        <v-btn :aria-label="$t('common.refresh')" :title="$t('common.refresh')" icon="mdi-refresh" size="small" variant="text" :loading="loadingSuggestions" @click="loadSuggestions" />
      </v-card-title>
      <v-card-text>
        <div v-if="loadingSuggestions" class="text-center pa-4"><v-progress-circular indeterminate /></div>
        <div v-else-if="!visibleSuggestions.length" class="text-medium-emphasis pa-4">{{ $t('invoicing.noShortages') }}</div>
        <div v-for="line in visibleSuggestions" :key="line.lineId" class="mb-4" data-testid="cover-line">
          <div class="text-subtitle-2 mb-1">
            {{ sugLookup.products?.[line.productId]?.name || line.productId }}
            — {{ $t('invoicing.shortQty') }}: <b>{{ line.openQuantity }}</b>
          </div>
          <!-- Opened from a line's + Reserve: only the source it asked for, and a word when that source has nothing for it. -->
          <div v-if="coverScope?.section === 'stock' && !line.freeStock.length" class="text-medium-emphasis text-body-2 mb-2">{{ $t('invoicing.tree.nothingFromStock') }}</div>
          <div v-if="coverScope?.section === 'order' && !line.incoming.length" class="text-medium-emphasis text-body-2 mb-2">{{ $t('invoicing.tree.nothingFromOrders') }}</div>

          <div v-if="showSection('stock') && line.freeStock.length" class="mb-2">
            <div class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.freeStock') }}</div>
            <div v-for="fs in line.freeStock" :key="fs.warehouseId" class="d-flex align-center ga-2 mb-1">
              <v-chip size="x-small" variant="tonal">{{ sugLookup.warehouses?.[fs.warehouseId] || fs.warehouseId }}</v-chip>
              <span class="text-caption">{{ $t('invoicing.freeQty') }}: {{ fs.available }}</span>
              <v-text-field v-model.number="fs._qty" type="number" min="0" density="compact" variant="underlined" hide-details style="max-width: 100px" />
              <v-btn size="x-small" color="primary" variant="tonal" :loading="acting" @click="reserveFromStock(line, fs)">{{ $t('invoicing.reserve') }}</v-btn>
            </div>
          </div>

          <div v-if="showSection('order') && line.incoming.length" class="mb-2">
            <div class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.incomingStock') }}</div>
            <div v-for="inc in line.incoming" :key="inc.allocationId" class="d-flex align-center ga-2 mb-1 flex-wrap">
              <v-chip size="x-small" variant="tonal" color="info">{{ inc.orderNumber }}</v-chip>
              <v-chip size="x-small" variant="tonal">{{ sugLookup.warehouses?.[inc.warehouseId] || '' }}</v-chip>
              <span class="text-caption">
                {{ inc.unreserved }}
                <template v-if="inc.expectedDate"> · {{ formatDate(inc.expectedDate) }}</template>
              </span>
              <v-icon v-if="inc.late" size="14" color="error" :title="$t('invoicing.lateDelivery')">mdi-clock-alert-outline</v-icon>
              <v-text-field v-model.number="inc._qty" type="number" min="0" density="compact" variant="underlined" hide-details style="max-width: 100px" />
              <v-btn size="x-small" color="primary" variant="tonal" :loading="acting" @click="reserveFromOrder(line, inc)">{{ $t('invoicing.reserve') }}</v-btn>
            </div>
          </div>

          <div v-if="!coverScope && line.preemptable.length" class="mb-2">
            <div class="text-caption text-medium-emphasis mb-1">
              {{ $t('invoicing.preemptable') }}
              <span v-if="line.preemptableTotal > line.preemptable.length">({{ line.preemptable.length }}/{{ line.preemptableTotal }})</span>
            </div>
            <div v-for="p in line.preemptable" :key="p.reservationId" class="d-flex align-center ga-2 mb-1 flex-wrap">
              <v-chip size="x-small" variant="tonal">{{ p.reservationNumber }}</v-chip>
              <span class="text-caption">
                {{ sugLookup.contacts?.[p.contactId] || '' }}
                <template v-if="p.internalOrderNumber"> · {{ p.internalOrderNumber }}</template>
                <template v-if="p.requestedDeliveryDate"> · {{ formatDate(p.requestedDeliveryDate) }}</template>
                · {{ $t('invoicing.releasableQty') }}: {{ p.releasable }}
              </span>
              <v-text-field v-model.number="p._qty" type="number" min="0" density="compact" variant="underlined" hide-details style="max-width: 100px" />
              <v-btn size="x-small" color="warning" variant="tonal" :loading="acting" @click="preempt(line, p)">{{ $t('invoicing.preempt') }}</v-btn>
            </div>
          </div>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="coverDialog = false">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- Generate-external-order dialog -->
  <v-dialog v-model="generateDialog" max-width="720">
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="primary">mdi-factory</v-icon>
        {{ $t('invoicing.generateExternalOrder') }}
      </v-card-title>
      <v-card-text>
        <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('invoicing.generateExternalHint') }}</p>
        <div v-if="!generateRows.length" class="text-medium-emphasis pa-2">{{ $t('invoicing.noShortages') }}</div>
        <div v-for="row in generateRows" :key="row.internalOrderLineId" class="d-flex align-center ga-2 mb-2 flex-wrap">
          <div style="min-width: 200px" class="flex-grow-1 text-body-2">{{ row.description }}</div>
          <v-text-field v-model.number="row.quantity" type="number" min="0" :label="$t('invoicing.qty')" density="compact" variant="outlined" hide-details style="max-width: 110px" />
          <v-autocomplete
            v-model="row.supplierId"
            :items="supplierOptions"
            item-title="companyName"
            item-value="_id"
            :label="$t('invoicing.supplier')"
            density="compact"
            variant="outlined"
            no-filter
            hide-details
            style="min-width: 220px"
            :loading="loadingContacts"
            @update:search="(s: string) => emit('searchSuppliers', s)"
          />
          <!-- FR-22.42: where the goods go, said up front — the order's warehouse, else the default one. -->
          <v-autocomplete v-model="row.warehouseId" :items="warehouses" item-title="name" item-value="_id" :label="$t('invoicing.toWarehouse')" density="compact" variant="outlined" hide-details style="min-width: 180px" />
        </div>
        <!-- FR-22.42: a draft supplier order of the same supplier can take the lines, instead of a new one. -->
        <v-select
          v-if="generateRows.length"
          v-model="generateTarget"
          :items="generateTargets"
          item-title="title"
          item-value="value"
          :label="$t('invoicing.generateInto')"
          :hint="generateTargets.length > 1 ? $t('invoicing.generateIntoHint') : ''"
          persistent-hint
          density="compact"
          variant="outlined"
          class="mt-4"
          data-testid="generate-target"
          @update:model-value="generateTargetTouched = true"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="generateDialog = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="generating" :disabled="!generateRows.some(r => r.quantity > 0 && r.supplierId)" @click="submitGenerate">
          {{ generateTarget === 'new' ? $t('common.create') : $t('invoicing.addToOrder') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * The customer order's two dialogs over what is short: Cover shortages (free stock, then what supplier orders bring
 * unreserved, then reservations that can be taken over) and a supplier order for the shortages (FR-22.42). Each
 * reservation is made AT ONCE; the form reloads its reservations through `refresh`. Opened by the form, from the
 * Reservations card or a line's + Reserve. Moved out of `InternalOrderFormView` (FR-32.23).
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { formatDate } from 'ui-shared/format'
import { askConfirm } from 'ui-shared/composables/confirm'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { reservationErrorMessage } from '../../composables/reservation-errors'
import { asDraftOrder, defaultDraftFor, pickDraftsFor, type DraftOrder } from '../../composables/order-generate'
import type { Warehouse } from '../../composables/order-form/useOrderFormBase'

const props = defineProps<{
  orgUrl: string
  /** The order's own warehouse, if it has one. */
  warehouseId?: string
  warehouses: Warehouse[]
  supplierOptions: any[]
  loadingContacts: boolean
  /** The form's reload of its reservations (and of what the server derives from them). */
  refresh: () => Promise<void>
}>()
const emit = defineEmits<{
  /** Text typed in a supplier field: the form searches its supplier pool. */
  searchSuppliers: [text: string]
  /** A supplier the suggestions name: the form keeps it among its options, so its name shows. */
  knownSupplier: [entry: { _id: string; companyName: string }]
}>()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { showSuccess, showError } = useSnackbar()
const orgUrl = () => props.orgUrl

// ── cover-shortages dialog ──
const coverDialog = ref(false)
const loadingSuggestions = ref(false)
const acting = ref(false)
const suggestions = ref<any[]>([])
const sugLookup = ref<any>({})

/** Opened from a line's + Reserve: the line, and the source it asked for. The toolbox's Cover shortages leaves it null and shows everything. */
const coverScope = ref<{ lineId: string; section: 'stock' | 'order' } | null>(null)
const visibleSuggestions = computed(() => coverScope.value
  ? suggestions.value.filter((l) => String(l.lineId) === coverScope.value!.lineId)
  : suggestions.value)
function showSection(section: 'stock' | 'order'): boolean {
  return !coverScope.value || coverScope.value.section === section
}
function openCoverDialog() {
  coverScope.value = null
  coverDialog.value = true
  loadSuggestions()
}
function openCoverFor(lineId: string, section: 'stock' | 'order') {
  coverScope.value = { lineId, section }
  coverDialog.value = true
  loadSuggestions()
}
async function loadSuggestions() {
  loadingSuggestions.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/internal-orders/${route.params.id}/suggestions`)
    for (const line of data.lines || []) {
      for (const fs of line.freeStock) fs._qty = Math.min(line.openQuantity, fs.available)
      for (const inc of line.incoming) inc._qty = Math.min(line.openQuantity, inc.unreserved)
      for (const p of line.preemptable) p._qty = Math.min(line.openQuantity, p.releasable)
    }
    suggestions.value = data.lines || []
    sugLookup.value = data.lookup || {}
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    loadingSuggestions.value = false
  }
}

async function coverAction(fn: () => Promise<any>) {
  acting.value = true
  try {
    await fn()
    showSuccess(t('common.savedSuccessfully'))
    await Promise.all([props.refresh(), loadSuggestions()])
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    acting.value = false
  }
}
function reserveFromStock(line: any, fs: any) {
  return coverAction(() => httpClient.post(`${orgUrl()}/invoicing/reservations`, {
    source: 'stock',
    productId: line.productId,
    quantity: fs._qty,
    internalOrderId: route.params.id,
    internalOrderLineId: line.lineId,
    warehouseId: fs.warehouseId,
  }))
}
function reserveFromOrder(line: any, inc: any) {
  return coverAction(() => httpClient.post(`${orgUrl()}/invoicing/reservations`, {
    source: 'order',
    productId: line.productId,
    quantity: inc._qty,
    internalOrderId: route.params.id,
    internalOrderLineId: line.lineId,
    orderId: inc.orderId,
    groupId: inc.groupId,
    lineId: inc.lineId,
    allocationId: inc.allocationId,
  }))
}
async function preempt(line: any, p: any) {
  if (!(await askConfirm({ text: t('invoicing.preemptConfirm', { number: p.reservationNumber }), confirm: t('invoicing.preempt') }))) return
  return coverAction(() => httpClient.post(`${orgUrl()}/invoicing/reservations/${p.reservationId}/preempt`, {
    internalOrderId: route.params.id,
    internalOrderLineId: line.lineId,
    quantity: p._qty,
  }))
}

// ── generate-external dialog ──
const generateDialog = ref(false)
const generating = ref(false)
const generateRows = ref<any[]>([])
/** 'new', or the id of the draft supplier order the lines are added to (FR-22.42). */
const generateTarget = ref<string>('new')
const generateTargetTouched = ref(false)
const draftOrders = ref<DraftOrder[]>([])

/**
 * The warehouse the goods go to when the dialog leaves it empty — the order's own, else the
 * default one — which is what `generateExternalOrder` falls back to. Shown, not implied.
 */
const fallbackWarehouseId = computed(() => props.warehouseId || props.warehouses.find((w) => w.isDefault)?._id || '')

const generateTargets = computed(() => [
  { value: 'new', title: t('invoicing.generateIntoNew') },
  ...pickDraftsFor(draftOrders.value, generateRows.value.map((r) => r.supplierId)).map((d) => ({
    value: d._id,
    title: t('invoicing.generateIntoDraft', { number: d.orderNumber, suppliers: d.supplierNames.join(', '), lines: d.lineCount }),
  })),
])

// Until the user picks one, the target follows the suppliers: their newest draft, else a new order.
watch(() => generateRows.value.map((r) => r.supplierId).join('|'), () => {
  if (!generateDialog.value || generateTargetTouched.value) return
  generateTarget.value = defaultDraftFor(draftOrders.value, generateRows.value.map((r) => r.supplierId))?._id || 'new'
  if (!generateTargets.value.some((o) => o.value === generateTarget.value)) generateTarget.value = 'new'
})

async function loadDraftOrders() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/orders`, { params: { status: 'draft', size: 100, sortBy: 'createdAt', sortOrder: 'desc' } })
    draftOrders.value = (data.orders || []).map(asDraftOrder)
  } catch {
    draftOrders.value = []
  }
}

async function openGenerateDialog(lineId?: string) {
  // Fresh every time: a reservation made since the cover dialog last looked changes what is short.
  await Promise.all([loadSuggestions(), loadDraftOrders()])
  generateRows.value = suggestions.value.filter((line) => !lineId || String(line.lineId) === lineId).map((line) => ({
    internalOrderLineId: line.lineId,
    description: sugLookup.value.products?.[line.productId]?.name || line.productId,
    quantity: line.openQuantity,
    supplierId: line.supplierHint?.supplierId || '',
    warehouseId: fallbackWarehouseId.value,
  }))
  // Make hinted suppliers resolvable in the autocomplete (the form adds the ones it does not have yet).
  for (const row of generateRows.value) {
    if (row.supplierId && sugLookup.value.contacts?.[row.supplierId]) {
      emit('knownSupplier', { _id: row.supplierId, companyName: sugLookup.value.contacts[row.supplierId] })
    }
  }
  generateTargetTouched.value = false
  generateTarget.value = defaultDraftFor(draftOrders.value, generateRows.value.map((r) => r.supplierId))?._id || 'new'
  generateDialog.value = true
}

async function submitGenerate() {
  const lines = generateRows.value
    .filter((r) => r.quantity > 0 && r.supplierId)
    .map((r) => ({
      internalOrderLineId: r.internalOrderLineId,
      quantity: r.quantity,
      supplierId: r.supplierId,
      warehouseId: r.warehouseId || undefined,
    }))
  if (!lines.length) return
  generating.value = true
  const appending = generateTarget.value !== 'new'
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/internal-orders/${route.params.id}/generate-external`, {
      lines,
      ...(appending ? { orderId: generateTarget.value } : {}),
    })
    showSuccess(t(appending ? 'invoicing.externalOrderAppended' : 'invoicing.externalOrderCreated', { number: data.order.orderNumber }))
    generateDialog.value = false
    // FR-22.35: the user lands on the supplier order — the next step is sending it.
    await router.push({ name: 'invoicing.orders.edit', params: { id: String(data.order._id) } })
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    generating.value = false
  }
}

defineExpose({ openCoverDialog, openCoverFor, openGenerateDialog })
</script>
