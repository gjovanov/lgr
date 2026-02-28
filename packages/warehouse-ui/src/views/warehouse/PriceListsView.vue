<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.priceLists') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

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
          <template #item.validFrom="{ item }">{{ item.validFrom?.split('T')[0] || '-' }}</template>
          <template #item.validTo="{ item }">{{ item.validTo?.split('T')[0] || '-' }}</template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="800" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.priceLists') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-select v-model="form.currency" :label="$t('common.currency')" :items="['EUR','USD','GBP','CHF','MKD','BGN','RSD']" />
              </v-col>
              <v-col cols="12" md="4">
                <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.validFrom" :label="$t('warehouse.validFrom')" type="date" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.validTo" :label="$t('warehouse.validTo')" type="date" />
              </v-col>
            </v-row>

            <!-- Price Items -->
            <div class="d-flex align-center mt-4 mb-2">
              <span class="text-subtitle-2">{{ $t('warehouse.priceItems') }}</span>
              <v-spacer />
              <v-btn variant="outlined" size="small" prepend-icon="mdi-plus" @click="addItem">{{ $t('warehouse.addItem') }}</v-btn>
            </div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ $t('warehouse.product') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('warehouse.price') }}</th>
                  <th class="text-end" style="width:120px">{{ $t('warehouse.minQuantity') }}</th>
                  <th class="text-end" style="width:100px">{{ $t('invoicing.discount') }}</th>
                  <th style="width:40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(item, idx) in form.items" :key="idx">
                  <td>
                    <v-autocomplete v-model="item.productId" :items="products" item-title="name" item-value="_id" density="compact" hide-details variant="underlined" />
                  </td>
                  <td><v-text-field v-model.number="item.price" type="number" step="0.01" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="item.minQuantity" type="number" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="item.discount" type="number" suffix="%" density="compact" hide-details variant="underlined" /></td>
                  <td><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.items.splice(idx, 1)" /></td>
                </tr>
              </tbody>
            </v-table>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('warehouse.deletePriceListConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
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
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'

interface Item { _id: string; name: string; currency: string; validFrom?: string; validTo?: string; isActive: boolean; itemCount?: number; items?: any[] }
interface Product { _id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()

const products = ref<Product[]>([])
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const formRef = ref()
const selectedId = ref('')

const emptyItem = () => ({ productId: '', price: 0, minQuantity: 1, discount: 0 })
const form = ref({
  name: '', currency: 'EUR', validFrom: '', validTo: '', isActive: true,
  items: [] as any[],
})

const rules = { required: (v: string) => !!v || t('validation.required') }

const url = computed(() => `${appStore.orgUrl()}/warehouse/price-list`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'priceLists',
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('warehouse.validFrom'), key: 'validFrom', sortable: true },
  { title: t('warehouse.validTo'), key: 'validTo', sortable: true },
  { title: t('warehouse.itemCount'), key: 'itemCount', align: 'end' as const },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function addItem() { form.value.items.push(emptyItem()) }
function onExport(format: string) { console.log('Export price lists as', format) }

function openCreate() {
  editing.value = false
  form.value = { name: '', currency: 'EUR', validFrom: '', validTo: '', isActive: true, items: [emptyItem()] }
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = {
    name: item.name, currency: item.currency, validFrom: item.validFrom?.split('T')[0] || '',
    validTo: item.validTo?.split('T')[0] || '', isActive: item.isActive,
    items: item.items || [],
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  saving.value = true
  try {
    if (editing.value) await httpClient.put(`${appStore.orgUrl()}/warehouse/price-list/${selectedId.value}`, form.value)
    else await httpClient.post(`${appStore.orgUrl()}/warehouse/price-list`, form.value)
    await fetchItems(); dialog.value = false
  } finally { saving.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await httpClient.delete(`${appStore.orgUrl()}/warehouse/price-list/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }

async function fetchProducts() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`); products.value = data.products || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchProducts() })
</script>
