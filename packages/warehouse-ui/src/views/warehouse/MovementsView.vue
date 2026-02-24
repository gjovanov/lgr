<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.stockMovements') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="typeFilter" :label="$t('common.type')" :items="['receipt', 'shipment', 'transfer', 'adjustment']" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="['draft', 'confirmed', 'cancelled']" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateFrom" :label="$t('invoicing.dateFrom')" type="date" hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateTo" :label="$t('invoicing.dateTo')" type="date" hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="loading" item-value="_id" hover>
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label :color="typeColor(item.type)">{{ item.type }}</v-chip>
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="item.status === 'confirmed' ? 'success' : item.status === 'draft' ? 'grey' : 'error'">{{ item.status }}</v-chip>
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total || 0) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-eye" size="small" variant="text" @click="openView(item)" />
            <v-btn v-if="item.status === 'draft'" icon="mdi-check" size="small" variant="text" color="success" :title="$t('warehouse.confirm')" @click="confirmMovement(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create/View Dialog -->
    <v-dialog v-model="dialog" max-width="900" persistent>
      <v-card>
        <v-card-title>{{ viewing ? $t('warehouse.viewMovement') : $t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="3">
                <v-select v-model="form.type" :label="$t('common.type')" :items="['receipt', 'shipment', 'transfer', 'adjustment']" :rules="[rules.required]" :disabled="viewing" />
              </v-col>
              <v-col cols="12" md="3">
                <v-select v-model="form.fromWarehouseId" :label="$t('warehouse.fromWarehouse')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="viewing" />
              </v-col>
              <v-col cols="12" md="3">
                <v-select v-model="form.toWarehouseId" :label="$t('warehouse.toWarehouse')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="viewing" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" :disabled="viewing" />
              </v-col>
            </v-row>
            <v-text-field v-model="form.contactName" :label="$t('warehouse.contactName')" clearable :disabled="viewing" />

            <div class="d-flex align-center mt-4 mb-2">
              <span class="text-subtitle-2">{{ $t('invoicing.lineItems') }}</span>
              <v-spacer />
              <v-btn v-if="!viewing" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">{{ $t('invoicing.addLine') }}</v-btn>
            </div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ $t('warehouse.product') }}</th>
                  <th class="text-end" style="width:100px">{{ $t('warehouse.quantity') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('warehouse.unitCost') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('common.total') }}</th>
                  <th v-if="!viewing" style="width:40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td><v-text-field v-model="line.productName" density="compact" hide-details variant="underlined" :disabled="viewing" /></td>
                  <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" :disabled="viewing" /></td>
                  <td><v-text-field v-model.number="line.unitCost" type="number" step="0.01" density="compact" hide-details variant="underlined" :disabled="viewing" /></td>
                  <td class="text-end">{{ fmtCurrency(line.quantity * (line.unitCost || 0)) }}</td>
                  <td v-if="!viewing"><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td :colspan="viewing ? 3 : 3" class="text-end text-subtitle-2">{{ $t('common.total') }}</td>
                  <td class="text-end text-subtitle-2">{{ fmtCurrency(computedTotal) }}</td>
                  <td v-if="!viewing"></td>
                </tr>
              </tfoot>
            </v-table>

            <v-text-field v-model="form.reference" :label="$t('invoicing.reference')" class="mt-4" :disabled="viewing" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ viewing ? $t('common.close') : $t('common.cancel') }}</v-btn>
          <v-btn v-if="!viewing" color="primary" :loading="loading" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ExportMenu from 'ui-shared/components/ExportMenu'

interface Item { _id: string; number?: string; type: string; date: string; fromWarehouseName?: string; toWarehouseName?: string; fromWarehouseId?: string; toWarehouseId?: string; contactName?: string; status: string; total?: number; lines?: any[]; reference?: string }
interface Warehouse { _id: string; name: string }
const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const loading = ref(false)
const items = ref<Item[]>([])
const warehouses = ref<Warehouse[]>([])
const dialog = ref(false)
const viewing = ref(false)
const formRef = ref()
const typeFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')

const emptyLine = () => ({ productName: '', quantity: 0, unitCost: 0 })
const form = ref({
  type: 'receipt', fromWarehouseId: '', toWarehouseId: '', contactName: '',
  date: new Date().toISOString().split('T')[0], reference: '',
  lines: [emptyLine()] as any[],
})

const computedTotal = computed(() => form.value.lines.reduce((s: number, l: any) => s + l.quantity * (l.unitCost || 0), 0))

const rules = { required: (v: string) => !!v || t('validation.required') }

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('warehouse.fromWarehouse'), key: 'fromWarehouseName' },
  { title: t('warehouse.toWarehouse'), key: 'toWarehouseName' },
  { title: t('invoicing.contact'), key: 'contactName' },
  { title: t('common.status'), key: 'status' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const filteredItems = computed(() => {
  let r = items.value
  if (typeFilter.value) r = r.filter(i => i.type === typeFilter.value)
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  if (dateFrom.value) r = r.filter(i => i.date >= dateFrom.value)
  if (dateTo.value) r = r.filter(i => i.date <= dateTo.value)
  return r
})

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function typeColor(t: string) { return ({ receipt: 'success', shipment: 'error', transfer: 'info', adjustment: 'warning' }[t] || 'grey') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function addLine() { form.value.lines.push(emptyLine()) }
function onExport(format: string) { console.log('Export movements as', format) }

function openCreate() {
  viewing.value = false
  form.value = { type: 'receipt', fromWarehouseId: '', toWarehouseId: '', contactName: '', date: new Date().toISOString().split('T')[0], reference: '', lines: [emptyLine()] }
  dialog.value = true
}

function openView(item: Item) {
  viewing.value = true
  form.value = {
    type: item.type, fromWarehouseId: item.fromWarehouseId || '', toWarehouseId: item.toWarehouseId || '',
    contactName: item.contactName || '', date: item.date?.split('T')[0] || '', reference: item.reference || '',
    lines: item.lines || [],
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/warehouse/movement`, { ...form.value, total: computedTotal.value })
    await fetchItems(); dialog.value = false
  } finally { loading.value = false }
}

async function confirmMovement(item: Item) {
  loading.value = true
  try { await httpClient.post(`${orgUrl()}/warehouse/movement/${item._id}/confirm`); await fetchItems() }
  finally { loading.value = false }
}

async function fetchItems() {
  loading.value = true
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/movement`); items.value = data.stockMovements || [] }
  finally { loading.value = false }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchWarehouses() })
</script>
