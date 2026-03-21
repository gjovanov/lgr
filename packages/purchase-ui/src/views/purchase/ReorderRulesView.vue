<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('purchase.reorderRules') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">{{ $t('common.create') }}</v-btn>
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
          <template #item.productId="{ item }">
            {{ getProductName(item.productId) }}
          </template>
          <template #item.warehouseId="{ item }">
            {{ getWarehouseName(item.warehouseId) }}
          </template>
          <template #item.vendorId="{ item }">
            {{ getContactName(item.vendorId) }}
          </template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ editId ? $t('purchase.editReorderRule') : $t('purchase.newReorderRule') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-autocomplete
              v-model="form.productId"
              :items="products"
              item-title="name"
              item-value="_id"
              :label="$t('common.product')"
              :rules="[rules.required]"
              clearable
              class="mb-2"
            />
            <v-autocomplete
              v-model="form.warehouseId"
              :items="warehouses"
              item-title="name"
              item-value="_id"
              :label="$t('purchase.warehouse')"
              :rules="[rules.required]"
              clearable
              class="mb-2"
            />
            <v-row>
              <v-col cols="6">
                <v-text-field v-model.number="form.minQty" :label="$t('purchase.minQty')" type="number" min="0" :rules="[rules.required]" />
              </v-col>
              <v-col cols="6">
                <v-text-field v-model.number="form.maxQty" :label="$t('purchase.maxQty')" type="number" min="0" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-text-field v-model.number="form.leadTimeDays" :label="$t('purchase.leadTimeDays')" type="number" min="0" :rules="[rules.required]" class="mb-2" />
            <v-autocomplete
              v-model="form.vendorId"
              :items="contacts"
              item-title="companyName"
              item-value="_id"
              :label="$t('purchase.vendor')"
              clearable
              class="mb-2"
            />
            <v-switch v-if="editId" v-model="form.isActive" :label="$t('common.active')" color="success" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="handleSave">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirm -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('purchase.deleteReorderRuleConfirm') }}</v-card-text>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const dialog = ref(false)
const deleteDialog = ref(false)
const saving = ref(false)
const editId = ref<string | null>(null)
const deleteId = ref('')
const formRef = ref()
const contacts = ref<any[]>([])
const products = ref<any[]>([])
const warehouses = ref<any[]>([])

const form = reactive({
  productId: '',
  warehouseId: '',
  minQty: 0,
  maxQty: 0,
  leadTimeDays: 0,
  vendorId: '',
  isActive: true,
})

const rules = {
  required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required'),
}

const url = computed(() => `${appStore.orgUrl()}/purchase/reorder-rules`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'reorderRules',
  defaultSize: 50,
})

const headers = computed(() => [
  { title: t('common.product'), key: 'productId', sortable: false },
  { title: t('purchase.warehouse'), key: 'warehouseId', sortable: false },
  { title: t('purchase.minQty'), key: 'minQty', sortable: false, align: 'end' as const },
  { title: t('purchase.maxQty'), key: 'maxQty', sortable: false, align: 'end' as const },
  { title: t('purchase.leadTimeDays'), key: 'leadTimeDays', sortable: false, align: 'end' as const },
  { title: t('purchase.vendor'), key: 'vendorId', sortable: false },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function getProductName(id?: string) {
  if (!id) return '-'
  return products.value.find(p => p._id === id)?.name || id
}

function getWarehouseName(id?: string) {
  if (!id) return '-'
  return warehouses.value.find(w => w._id === id)?.name || id
}

function getContactName(id?: string) {
  if (!id) return '-'
  return contacts.value.find(c => c._id === id)?.companyName || id
}

function resetForm() {
  form.productId = ''
  form.warehouseId = ''
  form.minQty = 0
  form.maxQty = 0
  form.leadTimeDays = 0
  form.vendorId = ''
  form.isActive = true
}

function openDialog(item?: any) {
  if (item) {
    editId.value = item._id || item.id
    form.productId = item.productId || ''
    form.warehouseId = item.warehouseId || ''
    form.minQty = item.minQty ?? 0
    form.maxQty = item.maxQty ?? 0
    form.leadTimeDays = item.leadTimeDays ?? 0
    form.vendorId = item.vendorId || ''
    form.isActive = item.isActive !== false
  } else {
    editId.value = null
    resetForm()
  }
  dialog.value = true
}

async function handleSave() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  saving.value = true
  try {
    if (editId.value) {
      await httpClient.put(`${appStore.orgUrl()}/purchase/reorder-rules/${editId.value}`, {
        minQty: form.minQty,
        maxQty: form.maxQty,
        leadTimeDays: form.leadTimeDays,
        vendorId: form.vendorId || undefined,
        isActive: form.isActive,
      })
    } else {
      await httpClient.post(`${appStore.orgUrl()}/purchase/reorder-rules`, {
        productId: form.productId,
        warehouseId: form.warehouseId,
        minQty: form.minQty,
        maxQty: form.maxQty,
        leadTimeDays: form.leadTimeDays,
        vendorId: form.vendorId || undefined,
      })
    }
    showSuccess(t('common.savedSuccessfully'))
    dialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

function confirmDelete(item: any) {
  deleteId.value = item._id || item.id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/purchase/reorder-rules/${deleteId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    deleteDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchContacts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`)
    contacts.value = data.contacts || []
  } catch { /* */ }
}

async function fetchProducts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`, { params: { size: 100 } })
    products.value = data.products || []
  } catch { /* */ }
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`)
    warehouses.value = data.warehouses || []
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchContacts(); fetchProducts(); fetchWarehouses() })
</script>
