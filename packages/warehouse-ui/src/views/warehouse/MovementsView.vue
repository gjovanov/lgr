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
          <v-col cols="12" md="2">
            <v-select v-model="typeFilter" :label="$t('common.type')" :items="['receipt', 'shipment', 'transfer', 'adjustment']" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="['draft', 'confirmed', 'cancelled']" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="warehouseIdFilter" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" clearable hide-details density="compact" />
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
        </v-data-table-server>
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
            <v-autocomplete v-model="form.contactId" :label="$t('invoicing.contact')" :items="contacts" item-title="name" item-value="_id" clearable :disabled="viewing" />

            <div class="d-flex align-center mt-4 mb-2">
              <span class="text-subtitle-2">{{ $t('invoicing.lineItems') }}</span>
              <v-spacer />
              <v-btn v-if="!viewing" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">{{ $t('invoicing.addLine') }}</v-btn>
            </div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ $t('warehouse.product') }}</th>
                  <th style="width:100px">{{ $t('warehouse.stock') || 'Stock' }}</th>
                  <th class="text-end" style="width:100px">{{ $t('warehouse.quantity') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('warehouse.unitCost') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('common.total') }}</th>
                  <th v-if="!viewing" style="width:40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td style="min-width:200px">
                    <ProductSearch
                      v-if="!viewing"
                      :org-url="appStore.orgUrl()"
                      :initial-product="line.productId ? { _id: line.productId, name: line.productName || '' } : null"
                      @product-selected="onLineProductSelected(idx, $event)"
                      @product-cleared="onLineProductCleared(idx)"
                    />
                    <span v-else>{{ line.productName || line.productId }}</span>
                  </td>
                  <td>
                    <v-chip v-if="line.stockQty != null" size="small" label color="info" variant="tonal">{{ line.stockQty }}</v-chip>
                    <span v-else class="text-grey">&mdash;</span>
                  </td>
                  <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" :disabled="viewing" /></td>
                  <td><v-text-field v-model.number="line.unitCost" type="number" step="0.01" density="compact" hide-details variant="underlined" :disabled="viewing" /></td>
                  <td class="text-end">{{ fmtCurrency(line.quantity * (line.unitCost || 0)) }}</td>
                  <td v-if="!viewing"><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td :colspan="viewing ? 4 : 4" class="text-end text-subtitle-2">{{ $t('common.total') }}</td>
                  <td class="text-end text-subtitle-2">{{ fmtCurrency(computedTotal) }}</td>
                  <td v-if="!viewing"></td>
                </tr>
              </tfoot>
            </v-table>

            <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" :disabled="viewing" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ viewing ? $t('common.close') : $t('common.cancel') }}</v-btn>
          <v-btn v-if="!viewing" color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ProductSearch from 'ui-shared/components/ProductSearch.vue'

interface Item { _id: string; number?: string; type: string; date: string; fromWarehouseName?: string; toWarehouseName?: string; fromWarehouseId?: string; toWarehouseId?: string; contactName?: string; status: string; total?: number; lines?: any[]; notes?: string }
interface Warehouse { _id: string; name: string }
interface Contact { _id: string; name: string; companyName?: string; firstName?: string; lastName?: string }
const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const warehouses = ref<Warehouse[]>([])
const contacts = ref<Contact[]>([])
const dialog = ref(false)
const viewing = ref(false)
const saving = ref(false)
const formRef = ref()
const typeFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null)
const warehouseIdFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')

const emptyLine = () => ({ productId: '', productName: '', quantity: 0, unitCost: 0, stockQty: null as number | null })
const form = ref({
  type: 'receipt', fromWarehouseId: '', toWarehouseId: '', contactId: '' as string | undefined,
  date: new Date().toISOString().split('T')[0], notes: '',
  lines: [emptyLine()] as any[],
})

const computedTotal = computed(() => form.value.lines.reduce((s: number, l: any) => s + l.quantity * (l.unitCost || 0), 0))

const rules = { required: (v: string) => !!v || t('validation.required') }

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (typeFilter.value) f.type = typeFilter.value
  if (statusFilter.value) f.status = statusFilter.value
  if (warehouseIdFilter.value) f.warehouseId = warehouseIdFilter.value
  if (dateFrom.value) f.dateFrom = dateFrom.value
  if (dateTo.value) f.dateTo = dateTo.value
  return f
})

const url = computed(() => `${appStore.orgUrl()}/warehouse/movement`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'stockMovements',
  filters,
})

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

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function typeColor(t: string) { return ({ receipt: 'success', shipment: 'error', transfer: 'info', adjustment: 'warning' }[t] || 'grey') }
function addLine() { form.value.lines.push(emptyLine()) }
function onExport(format: string) { console.log('Export movements as', format) }

function openCreate() {
  viewing.value = false
  form.value = { type: 'receipt', fromWarehouseId: '', toWarehouseId: '', contactId: undefined, date: new Date().toISOString().split('T')[0], notes: '', lines: [emptyLine()] }
  dialog.value = true
}

function openView(item: Item) {
  viewing.value = true
  form.value = {
    type: item.type, fromWarehouseId: item.fromWarehouseId || '', toWarehouseId: item.toWarehouseId || '',
    contactId: (item as any).contactId || undefined, date: item.date?.split('T')[0] || '', notes: (item as any).notes || '',
    lines: (item.lines || []).map((l: any) => ({ productId: l.productId, productName: l.productName || '', quantity: l.quantity, unitCost: l.unitCost })),
  }
  dialog.value = true
}

async function fetchLineStock(idx: number) {
  const line = form.value.lines[idx]
  if (!line?.productId || !form.value.fromWarehouseId) {
    if (line) { line.stockQty = null }
    return
  }
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level`, {
      params: { productId: line.productId, warehouseId: form.value.fromWarehouseId, size: 1 },
    })
    const sl = data.stockLevels?.[0]
    if (sl) {
      line.stockQty = sl.availableQuantity ?? sl.quantity ?? 0
      line.quantity = line.stockQty
      line.unitCost = sl.avgCost || line.unitCost
    } else {
      line.stockQty = 0
    }
  } catch {
    line.stockQty = null
  }
}

async function onLineProductSelected(idx: number, product: any) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = product._id
  line.productName = product.name
  line.unitCost = product.purchasePrice ?? 0
  line.stockQty = null
  await fetchLineStock(idx)
}

function onLineProductCleared(idx: number) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = ''
  line.productName = ''
  line.stockQty = null
}

watch(() => form.value.fromWarehouseId, () => {
  form.value.lines.forEach((_line: any, idx: number) => {
    if (_line.productId) fetchLineStock(idx)
  })
})

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  saving.value = true
  try {
    const payload = {
      type: form.value.type,
      date: form.value.date,
      fromWarehouseId: form.value.fromWarehouseId || undefined,
      toWarehouseId: form.value.toWarehouseId || undefined,
      contactId: form.value.contactId || undefined,
      notes: form.value.notes || undefined,
      totalAmount: computedTotal.value,
      lines: form.value.lines.map(l => ({
        productId: l.productId,
        quantity: l.quantity,
        unitCost: l.unitCost || 0,
        totalCost: l.quantity * (l.unitCost || 0),
      })),
    }
    await httpClient.post(`${appStore.orgUrl()}/warehouse/movement`, payload)
    await fetchItems(); dialog.value = false
  } finally { saving.value = false }
}

async function confirmMovement(item: Item) {
  await httpClient.post(`${appStore.orgUrl()}/warehouse/movement/${item._id}/confirm`)
  await fetchItems()
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

function contactDisplayName(c: any): string {
  if (c.companyName) return c.companyName
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id
}

async function fetchContacts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`)
    contacts.value = (data.contacts || []).map((c: any) => ({ ...c, name: contactDisplayName(c) }))
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchWarehouses(); fetchContacts() })
</script>
