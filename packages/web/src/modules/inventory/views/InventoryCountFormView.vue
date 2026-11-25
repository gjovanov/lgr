<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('nav.inventoryCount') : $t('common.create') + ' ' + $t('nav.inventoryCount')"
    :subtitle="isEdit ? (countNumber || '') : ''"
    :status="isEdit ? statusDef : undefined"
    :actions="formActions"
    :loading="loading"
    :load-error="loadError"
    :refusal="refusal"
    @retry="fetchItem"
    @dismiss-refusal="dismissRefusal"
    back-to="/inventory-counts"
    :back-label="$t('nav.inventoryCount')"
  >
    <!-- FR-04 (#11): the adjustment movement this count booked, once completed. -->
    <v-alert v-if="adjustmentMovementId" type="info" variant="tonal" density="compact" class="mb-3">
      {{ $t('warehouse.movementDoc') }}:
      <router-link :to="{ name: 'inventory.movements.view', params: { id: adjustmentMovementId } }">
        {{ $t('common.view') }}
      </router-link>
    </v-alert>

    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <v-select v-model="form.warehouseId" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" :rules="[rules.required]" :disabled="readonly" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" :disabled="readonly" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-select v-model="form.type" :label="$t('common.type')" :items="countTypes" :disabled="readonly" density="compact" />
        </v-col>
      </v-row>

      <!-- Count Lines. FR-30.17 / FR-33.1: a warehouse of 25 000 levels is a virtual table (only the rows in view are
           drawn), keyed by article, with a line filter and two toggles. A plain table of a field per level took 190 s
           to show its rows. -->
      <div class="d-flex align-center mt-4 mb-2 ga-3 flex-wrap">
        <span class="text-subtitle-2">{{ $t('warehouse.countItems') }}</span>
        <v-text-field
          v-model="lineSearch"
          :placeholder="$t('warehouse.countSearch')"
          prepend-inner-icon="mdi-magnify"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="max-width: 320px"
          data-testid="count-search"
        />
        <v-btn-toggle v-model="lineFilter" mandatory density="compact" variant="outlined" divided data-testid="count-filter">
          <v-btn value="all" size="small">{{ $t('warehouse.countFilter.all') }}</v-btn>
          <v-btn value="notCounted" size="small">{{ $t('warehouse.countFilter.notCounted') }}</v-btn>
          <v-btn value="difference" size="small">{{ $t('warehouse.countFilter.difference') }}</v-btn>
        </v-btn-toggle>
        <span class="text-caption text-medium-emphasis" data-testid="count-shown">{{ shownLines.length }} / {{ form.lines.length }}</span>
        <v-spacer />
        <v-btn v-if="!isEdit" variant="outlined" size="small" prepend-icon="mdi-refresh" @click="loadProducts">
          {{ $t('warehouse.loadProducts') }}
        </v-btn>
      </div>
      <component
        :is="virtualLines ? VDataTableVirtual : VDataTable"
        :headers="lineHeaders"
        :items="shownLines"
        item-value="productId"
        density="compact"
        fixed-header
        v-bind="virtualLines ? { height: '60vh' } : { itemsPerPage: -1, hideDefaultFooter: true }"
        data-testid="count-lines"
      >
        <template #item.product="{ item }">
          <span>{{ item.productName || item.productId }}</span>
          <span v-if="item.productSku" class="text-caption text-medium-emphasis ms-2">{{ item.productSku }}</span>
        </template>
        <template #item.qty="{ item }">
          <DecimalField
            :model-value="item.countedQuantity"
            :decimals="QTY_DECIMALS"
            :min-decimals="0"
            min="0"
            density="compact"
            hide-details
            variant="underlined"
            :disabled="readonly"
            data-testid="count-qty"
            @update:model-value="setCounted(item, $event)"
          />
        </template>
        <template #item.variance="{ item }">
          <span :class="(item.countedQuantity - item.systemQuantity) !== 0 ? 'text-error font-weight-bold' : 'text-success'">
            {{ item.countedQuantity - item.systemQuantity }}
          </span>
        </template>
      </component>

      <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" density="compact" :disabled="readonly" />
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import DecimalField from 'ui-shared/components/DecimalField.vue'
import { QTY_DECIMALS } from 'ui-shared/composables/price-precision'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import {
  completeInventoryCount, createInventoryCount, getInventoryCount, updateInventoryCount, type InventoryCount, type InventoryCountBody,
} from '../api/inventory-counts'
import { listStockLevels } from '../api/stock-levels'
import { listWarehouses } from '../api/warehouses'
import { reportError } from 'ui-shared/composables/report-error'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction, StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import { VDataTable, VDataTableVirtual } from 'vuetify/components'
import { searchTextMatcher } from 'config/search-text'

interface Warehouse { _id: string; name: string }

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
// FR-31.6 / .8: a record that did not load says so; a refused action stays at the top of the form.
const { loadError, refusal, loadStarted, loadFailed, refused, succeeded, dismissRefusal } = useFormFeedback()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const warehouses = ref<Warehouse[]>([])
const countNumber = ref('')
const countStatus = ref('draft')
const adjustmentMovementId = ref('')

/** The shell translates a pipeline step as an i18n KEY, so a bare word would render as itself. */
const statusDef = computed<StatusDef>(() => ({
  steps: ['draft', 'in_progress', 'completed'].map(s => `warehouse.countStatus.${s}`),
  current: `warehouse.countStatus.${countStatus.value}`,
}))
const countTypes = computed(() => [
  { value: 'full', title: t('warehouse.countType.full') },
  { value: 'partial', title: t('warehouse.countType.partial') },
  { value: 'cycle', title: t('warehouse.countType.cycle') },
])

interface CountLine {
  productId: string
  productName: string
  productSku?: string
  productBarcode?: string
  systemQuantity: number
  countedQuantity: number
  avgCost: number
}

const form = ref({
  warehouseId: '', date: new Date().toISOString().split('T')[0], type: 'full', notes: '',
  lines: [] as CountLine[],
})

// ── FR-30.17 / FR-33.2: finding a line among 25 000 ──
/** Above this many lines only the rows in view are drawn; a small count is a plain table of all its rows. */
const VIRTUAL_FROM = 200
const virtualLines = computed(() => form.value.lines.length > VIRTUAL_FROM)
const lineSearch = ref<string | null>('')
const lineFilter = ref<'all' | 'notCounted' | 'difference'>('all')
/**
 * The articles a quantity was typed for since the form opened. A row is keyed by its article (a count holds each
 * article once), so a filter or a scroll never moves a quantity to another row. A saved count's lines that differ from
 * the system count are taken as counted.
 */
const counted = ref(new Set<string>())
const lineHeaders = computed(() => [
  { title: t('warehouse.product'), key: 'product', sortable: false },
  { title: t('warehouse.systemQty'), key: 'systemQuantity', align: 'end' as const, width: 120, sortable: false },
  // Keyed `qty`, not `countedQuantity`: the table reads every row's value of each column's key, and a typed quantity
  // would then make it read all 25 000 rows again on each keystroke.
  { title: t('warehouse.countedQty'), key: 'qty', align: 'end' as const, width: 140, sortable: false },
  { title: t('warehouse.variance'), key: 'variance', align: 'end' as const, width: 120, sortable: false },
])
/**
 * The rows shown. The line filter reads name, SKU and barcode as the product search does (`config/search-text`): every
 * word, in any case, Latin and Cyrillic look-alikes as one letter. Then the toggle.
 */
const shownLines = computed(() => {
  const matches = searchTextMatcher(lineSearch.value)
  if (!matches && lineFilter.value === 'all') return form.value.lines
  const done = counted.value
  return form.value.lines.filter((l) => {
    if (lineFilter.value === 'notCounted' && done.has(String(l.productId))) return false
    if (lineFilter.value === 'difference' && l.countedQuantity === l.systemQuantity) return false
    return !matches || matches(`${l.productName || ''} ${l.productSku || ''} ${l.productBarcode || ''}`)
  })
})
function setCounted(line: CountLine, value: number) {
  line.countedQuantity = Number.isFinite(value) ? value : 0
  if (!counted.value.has(String(line.productId))) {
    const next = new Set(counted.value)
    next.add(String(line.productId))
    counted.value = next
  }
}
/** A saved count: what differs from the system was counted. */
function countedOf(lines: CountLine[]): Set<string> {
  return new Set(lines.filter((l) => l.countedQuantity !== l.systemQuantity).map((l) => String(l.productId)))
}

const { markSaved, markLoaded, tryRestore } = usePendingChanges({
  appId: 'inventory',
  entityType: 'inventoryCount',
  icon: 'mdi-clipboard-check',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: t('common.type'), value: countTypes.value.find(c => c.value === form.value.type)?.title ?? form.value.type },
    { label: t('common.date'), value: form.value.date },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

// FR-04 (#11): completed counts are immutable (the backend 409s) — no Save, no Complete.
const readonly = computed(() => isEdit.value && countStatus.value === 'completed')

const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = []
  if (!readonly.value) {
    actions.push({ label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, cap: isEdit.value ? ['inventory-counts.create', 'inventory-counts.edit'] : 'inventory-counts.create', loading: saving.value })
  }
  if (isEdit.value && countStatus.value === 'in_progress') {
    actions.push({ label: t('warehouse.completeCount'), color: 'success', icon: 'mdi-check-all', handler: completeCount, loading: saving.value })
  }
  return actions
})

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  loadStarted()
  try {
    // A count that is not there answers `{ inventoryCount: null }`: the form then starts empty.
    const { inventoryCount } = await getInventoryCount(route.params.id as string)
    const detail: Partial<InventoryCount> = inventoryCount ?? {}
    // The GET /:id handler returns the raw doc — its field is countNumber (the `number`
    // alias exists only on the LIST handler), so the subtitle used to render blank.
    countNumber.value = detail.countNumber || ''
    countStatus.value = detail.status || 'draft'
    adjustmentMovementId.value = detail.adjustmentMovementId || ''
    await markLoaded(() => {
      form.value = {
        warehouseId: detail.warehouseId || '', date: detail.date?.split('T')[0] || '', type: detail.type || 'full',
        notes: detail.notes || '',
        lines: (detail.lines || []).map((l: any) => ({
          productId: l.productId,
          productName: l.productName || '',
          productSku: l.productSku || '',
          productBarcode: l.productBarcode || '',
          systemQuantity: l.systemQuantity ?? 0,
          countedQuantity: l.countedQuantity ?? 0,
          avgCost: l.avgCost || 0,
        })),
      }
      counted.value = countedOf(form.value.lines)
    })
  } catch (e: any) {
    loadFailed(e)
  } finally {
    loading.value = false
  }
}

async function loadProducts() {
  if (!form.value.warehouseId) return
  try {
    // size: 0 = ALL stock levels. The default page (10) used to silently seed a "full"
    // count with ten products. `fields=count` is the endpoint's lean "all" (FR-30.8): past the list ceiling of a
    // thousand rows, each level narrow.
    const { stockLevels } = await listStockLevels({ warehouseId: form.value.warehouseId, size: 0, fields: 'count' })
    form.value.lines = stockLevels.map(s => ({
      productId: s.productId,
      productName: s.productName || s.productSku,
      productSku: s.productSku || '',
      productBarcode: s.productBarcode || '',
      systemQuantity: s.quantity || 0,
      countedQuantity: s.quantity || 0,
      avgCost: s.avgCost || 0,
    }))
    counted.value = new Set()
  } catch (e) { reportError(e) }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    const payload: InventoryCountBody = {
      ...form.value,
      itemCount: form.value.lines.length,
      varianceCount: form.value.lines.filter(l => l.countedQuantity !== l.systemQuantity).length,
      lines: form.value.lines.map(l => ({
        productId: l.productId,
        systemQuantity: l.systemQuantity,
        countedQuantity: l.countedQuantity,
        variance: l.countedQuantity - l.systemQuantity,
        // FR-27.11.C.4: no `varianceCost`. The server prices a count from the stock level's average cost, which a role
        // without the cost figures never reads.
      })),
    }
    if (isEdit.value) {
      await updateInventoryCount(route.params.id as string, payload)
    } else {
      const { inventoryCount } = await createInventoryCount(payload)
      const newId = inventoryCount._id
      if (newId) {
        markSaved()
        succeeded()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'inventory.inventory-counts.edit', params: { id: newId } })
        return
      }
    }
    markSaved()
    succeeded()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    refused(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function completeCount() {
  saving.value = true
  try {
    const { inventoryCount } = await completeInventoryCount(route.params.id as string)
    countStatus.value = 'completed'
    adjustmentMovementId.value = inventoryCount?.adjustmentMovementId || adjustmentMovementId.value
    succeeded()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    refused(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function fetchWarehouses() {
  try { warehouses.value = (await listWarehouses({ size: 1000 })).warehouses } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
}

onMounted(async () => {
  await fetchWarehouses()
  if (tryRestore()) return
  fetchItem()
})
</script>
