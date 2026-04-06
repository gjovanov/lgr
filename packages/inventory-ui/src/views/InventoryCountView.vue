<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.inventoryCount') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'inventory.inventory-counts.new' }">{{ $t('common.create') }}</responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label>{{ item.type || 'full' }}</v-chip>
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'warning' : 'grey'">
              {{ item.status }}
            </v-chip>
          </template>
          <template #item.varianceCount="{ item }">
            <span :class="item.varianceCount > 0 ? 'text-error font-weight-bold' : ''">{{ item.varianceCount || 0 }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'inventory.inventory-counts.edit', params: { id: item._id } }" />
            <v-btn v-if="item.status === 'in_progress'" icon="mdi-check-all" size="small" variant="text" color="success" :title="$t('warehouse.completeCount')" @click="complete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import { useDialogPendingChanges } from 'ui-shared/composables/useDialogPendingChanges'

interface Item { _id: string; number: string; warehouseName: string; warehouseId?: string; date: string; type: string; status: string; itemCount: number; varianceCount: number; notes?: string; lines?: any[] }
interface Warehouse { _id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const warehouses = ref<Warehouse[]>([])
const dialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const formRef = ref()
const selectedId = ref('')

const form = ref({
  warehouseId: '', date: new Date().toISOString().split('T')[0], type: 'full', notes: '',
  lines: [] as Array<{ productId: string; productName: string; systemQuantity: number; countedQuantity: number; avgCost: number }>,
})

const { markSaved } = useDialogPendingChanges({
  appId: 'inventory',
  entityType: 'inventoryCount',
  dialogId: 'inventory-inventory-counts',
  icon: 'mdi-clipboard-check',
  dialogVisible: dialog,
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Type', value: form.value.type },
    { label: 'Date', value: form.value.date },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => editing.value,
  entityId: () => selectedId.value,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  return f
})

const url = computed(() => `${appStore.orgUrl()}/warehouse/inventory-count`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'inventoryCounts',
  filters,
})

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: true },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('common.status'), key: 'status' },
  { title: t('warehouse.itemCount'), key: 'itemCount', align: 'end' as const },
  { title: t('warehouse.variances'), key: 'varianceCount', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function onExport(format: string) { console.log('Export inventory counts as', format) }

function openCreate() {
  editing.value = false
  form.value = { warehouseId: '', date: new Date().toISOString().split('T')[0], type: 'full', notes: '', lines: [] as any[] }
  dialog.value = true
}

async function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/inventory-count/${item._id}`)
    const detail = data.inventoryCount || data.item || data
    form.value = {
      warehouseId: detail.warehouseId || '', date: detail.date?.split('T')[0] || '', type: detail.type || 'full',
      notes: detail.notes || '',
      lines: (detail.lines || []).map((l: any) => ({
        productId: l.productId,
        productName: l.productName || '',
        systemQuantity: l.systemQuantity ?? 0,
        countedQuantity: l.countedQuantity ?? 0,
        avgCost: l.avgCost || 0,
      })),
    }
  } catch {
    form.value = {
      warehouseId: item.warehouseId || '', date: item.date?.split('T')[0] || '', type: item.type || 'full',
      notes: item.notes || '', lines: item.lines || [],
    }
  }
  dialog.value = true
}

async function loadProducts() {
  if (!form.value.warehouseId) return
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level`, { params: { warehouseId: form.value.warehouseId } })
    form.value.lines = (data.stockLevels || []).map((s: any) => ({
      productId: s.productId,
      productName: s.productName || s.productSku,
      systemQuantity: s.quantity || 0,
      countedQuantity: s.quantity || 0,
      avgCost: s.avgCost || 0,
    }))
  } catch { /* */ }
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  saving.value = true
  try {
    const payload = {
      ...form.value,
      itemCount: form.value.lines.length,
      varianceCount: form.value.lines.filter(l => l.countedQuantity !== l.systemQuantity).length,
      lines: form.value.lines.map(l => ({
        productId: l.productId,
        systemQuantity: l.systemQuantity,
        countedQuantity: l.countedQuantity,
        variance: l.countedQuantity - l.systemQuantity,
        varianceCost: (l.countedQuantity - l.systemQuantity) * (l.avgCost || 0),
      })),
    }
    if (editing.value) await httpClient.put(`${appStore.orgUrl()}/warehouse/inventory-count/${selectedId.value}`, payload)
    else await httpClient.post(`${appStore.orgUrl()}/warehouse/inventory-count`, payload)
    await fetchItems()
    markSaved()
    dialog.value = false
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { saving.value = false }
}

async function complete(item: Item) {
  try {
    await httpClient.post(`${appStore.orgUrl()}/warehouse/inventory-count/${item._id}/complete`)
    await fetchItems()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchWarehouses() })
</script>
