<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('erp.productionOrders') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-row class="mb-2">
          <v-col cols="12" md="5">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="t('common.status')" :items="orderStatuses" clearable hide-details />
          </v-col>
        </v-row>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="store.loading" item-value="_id">
          <template #item.status="{ item }">
            <v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.priority="{ item }">
            <v-chip size="small" :color="priorityColor(item.priority)">{{ item.priority }}</v-chip>
          </template>
          <template #item.plannedStartDate="{ item }">{{ item.plannedStartDate?.split('T')[0] }}</template>
          <template #item.plannedEndDate="{ item }">{{ item.plannedEndDate?.split('T')[0] }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.status === 'planned'" icon="mdi-play" size="small" variant="text" color="primary" :title="t('erp.start')" @click="doStart(item)" />
            <v-btn v-if="item.status === 'in_progress'" icon="mdi-check" size="small" variant="text" color="success" :title="t('erp.complete')" @click="doComplete(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-if="editing" v-model="form.orderNumber" :label="t('erp.orderNumber')" readonly disabled />
            <v-autocomplete v-model="form.bomId" :label="t('erp.bom')" :items="store.boms" item-title="name" item-value="_id" :rules="[rules.required]" />
            <v-autocomplete v-model="form.productId" :label="t('erp.product')" :items="products" item-title="name" item-value="_id" :rules="[rules.required]" />
            <v-text-field v-model.number="form.quantity" :label="t('erp.quantity')" type="number" :rules="[rules.required]" />
            <v-autocomplete v-model="form.warehouseId" :label="t('erp.warehouse')" :items="warehouses" item-title="name" item-value="_id" :rules="[rules.required]" />
            <v-autocomplete v-model="form.outputWarehouseId" :label="t('erp.outputWarehouse')" :items="warehouses" item-title="name" item-value="_id" :rules="[rules.required]" />
            <v-select v-model="form.priority" :label="t('erp.priority')" :items="priorities" :rules="[rules.required]" />
            <v-text-field v-model="form.plannedStartDate" :label="t('erp.plannedStart')" type="date" :rules="[rules.required]" />
            <v-text-field v-model="form.plannedEndDate" :label="t('erp.plannedEnd')" type="date" :rules="[rules.required]" />
            <v-textarea v-model="form.notes" :label="t('common.notes')" rows="2" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ t('common.confirmDelete') }}</v-card-title>
        <v-card-text>{{ t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useERPStore, type ProductionOrder } from '../../store/erp.store'
import { useAppStore } from '../../store/app.store'

const { t } = useI18n()
const store = useERPStore()
const appStore = useAppStore()

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

const search = ref('')
const statusFilter = ref<string | null>(null)
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const products = ref<{ _id: string; name: string }[]>([])
const warehouses = ref<{ _id: string; name: string }[]>([])

const orderStatuses = ['planned', 'in_progress', 'quality_check', 'completed', 'cancelled']
const priorities = ['low', 'normal', 'high', 'urgent']

const emptyForm = () => ({
  orderNumber: '',
  bomId: '',
  productId: '',
  quantity: 1,
  warehouseId: '',
  outputWarehouseId: '',
  priority: 'normal' as string,
  plannedStartDate: '',
  plannedEndDate: '',
  notes: '',
})
const form = ref(emptyForm())

const headers = [
  { title: t('erp.orderNumber'), key: 'orderNumber' },
  { title: t('erp.bom'), key: 'bomName' },
  { title: t('erp.product'), key: 'productName' },
  { title: t('erp.quantity'), key: 'quantity', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('erp.priority'), key: 'priority' },
  { title: t('erp.plannedStart'), key: 'plannedStartDate' },
  { title: t('erp.plannedEnd'), key: 'plannedEndDate' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const filteredItems = computed(() => {
  let r = store.productionOrders
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  return r
})

function statusColor(s: string) {
  return ({ planned: 'info', in_progress: 'warning', quality_check: 'purple', completed: 'success', cancelled: 'error' }[s] || 'grey')
}

function priorityColor(s: string) {
  return ({ low: 'grey', normal: 'info', high: 'warning', urgent: 'error' }[s] || 'grey')
}

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function openCreate() { editing.value = false; form.value = emptyForm(); dialog.value = true }

function openEdit(item: ProductionOrder) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    orderNumber: item.orderNumber || '',
    bomId: item.bomId,
    productId: item.productId,
    quantity: item.quantity,
    warehouseId: item.warehouseId,
    outputWarehouseId: item.outputWarehouseId,
    priority: item.priority || 'normal',
    plannedStartDate: item.plannedStartDate?.split('T')[0] || '',
    plannedEndDate: item.plannedEndDate?.split('T')[0] || '',
    notes: item.notes || '',
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  const payload = { ...form.value } as Record<string, unknown>
  if (!editing.value) {
    delete payload.orderNumber
  }
  if (editing.value) {
    await store.updateProductionOrder(selectedId.value, payload as unknown as Partial<ProductionOrder>)
  } else {
    await store.createProductionOrder(payload as unknown as Partial<ProductionOrder>)
  }
  dialog.value = false
}

async function doStart(item: ProductionOrder) { await store.startProduction(item._id) }
async function doComplete(item: ProductionOrder) { await store.completeProduction(item._id) }

function confirmDelete(item: ProductionOrder) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteProductionOrder(selectedId.value); deleteDialog.value = false }

async function fetchProducts() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/product`); products.value = data.products || [] } catch { /* */ }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(() => {
  store.fetchProductionOrders()
  store.fetchBOMs()
  fetchProducts()
  fetchWarehouses()
})
</script>
