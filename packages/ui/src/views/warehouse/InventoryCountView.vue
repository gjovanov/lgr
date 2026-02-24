<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.inventoryCount') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card>
      <v-card-text>
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" class="mb-4" style="max-width:300px" />
        <v-data-table :headers="headers" :items="items" :search="search" :loading="loading" item-value="_id" hover>
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
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.status === 'in_progress'" icon="mdi-check-all" size="small" variant="text" color="success" :title="$t('warehouse.completeCount')" @click="complete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="900" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.inventoryCount') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="4">
                <v-select v-model="form.warehouseId" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-select v-model="form.type" :label="$t('common.type')" :items="['full', 'partial', 'cycle']" />
              </v-col>
            </v-row>

            <!-- Count Lines -->
            <div class="mt-4 mb-2">
              <span class="text-subtitle-2">{{ $t('warehouse.countItems') }}</span>
            </div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ $t('warehouse.product') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('warehouse.systemQty') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('warehouse.countedQty') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('warehouse.variance') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td>{{ line.productName || line.productId }}</td>
                  <td class="text-end">{{ line.expectedQuantity }}</td>
                  <td>
                    <v-text-field v-model.number="line.countedQuantity" type="number" min="0" density="compact" hide-details variant="underlined" />
                  </td>
                  <td class="text-end" :class="(line.countedQuantity - line.expectedQuantity) !== 0 ? 'text-error font-weight-bold' : 'text-success'">
                    {{ line.countedQuantity - line.expectedQuantity }}
                  </td>
                </tr>
              </tbody>
            </v-table>

            <v-btn v-if="!editing" variant="outlined" size="small" prepend-icon="mdi-refresh" class="mt-2" @click="loadProducts">
              {{ $t('warehouse.loadProducts') }}
            </v-btn>

            <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from '../../composables/useHttpClient'
import ExportMenu from '../../components/shared/ExportMenu.vue'

interface Item { _id: string; number: string; warehouseName: string; warehouseId?: string; date: string; type: string; status: string; itemCount: number; varianceCount: number; notes?: string; lines?: any[] }
interface Warehouse { _id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()

const search = ref('')
const loading = ref(false)
const items = ref<Item[]>([])
const warehouses = ref<Warehouse[]>([])
const dialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const form = ref({
  warehouseId: '', date: new Date().toISOString().split('T')[0], type: 'full', notes: '',
  lines: [] as Array<{ productId: string; productName: string; expectedQuantity: number; countedQuantity: number }>,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

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

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function onExport(format: string) { console.log('Export inventory counts as', format) }

function openCreate() {
  editing.value = false
  form.value = { warehouseId: '', date: new Date().toISOString().split('T')[0], type: 'full', notes: '', lines: [] }
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = {
    warehouseId: item.warehouseId || '', date: item.date?.split('T')[0] || '', type: item.type || 'full',
    notes: item.notes || '', lines: item.lines || [],
  }
  dialog.value = true
}

async function loadProducts() {
  if (!form.value.warehouseId) return
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/stock-level`, { params: { warehouseId: form.value.warehouseId } })
    form.value.lines = (data.stockLevels || []).map((s: any) => ({
      productId: s.productId,
      productName: s.productName || s.productSku,
      expectedQuantity: s.quantity || 0,
      countedQuantity: s.quantity || 0,
    }))
  } catch { /* */ }
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    const payload = { ...form.value, itemCount: form.value.lines.length, varianceCount: form.value.lines.filter(l => l.countedQuantity !== l.expectedQuantity).length }
    if (editing.value) await httpClient.put(`${orgUrl()}/warehouse/inventory-count/${selectedId.value}`, payload)
    else await httpClient.post(`${orgUrl()}/warehouse/inventory-count`, payload)
    await fetchItems(); dialog.value = false
  } finally { loading.value = false }
}

async function complete(item: Item) {
  loading.value = true
  try { await httpClient.post(`${orgUrl()}/warehouse/inventory-count/${item._id}/complete`); await fetchItems() }
  finally { loading.value = false }
}

async function fetchItems() {
  loading.value = true
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/inventory-count`); items.value = data.inventoryCounts || [] }
  finally { loading.value = false }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchWarehouses() })
</script>
