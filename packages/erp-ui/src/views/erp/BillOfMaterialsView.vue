<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('erp.billOfMaterials') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-row class="mb-2">
          <v-col cols="12" md="5">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="t('common.status')" :items="bomStatuses" clearable hide-details />
          </v-col>
        </v-row>
        <v-data-table-server :headers="headers" :items="items" :items-length="pagination.total" :loading="loading" :page="pagination.page + 1" :items-per-page="pagination.size" @update:options="onUpdateOptions" item-value="_id">
          <template #item.productId="{ item }">{{ productName(item.productId) }}</template>
          <template #item.status="{ item }">
            <v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.materials="{ item }">{{ item.materials?.length || 0 }} {{ t('erp.components') }}</template>
          <template #item.totalCost="{ item }">{{ item.totalCost?.toFixed(2) || '0.00' }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-eye" size="small" variant="text" @click="viewBOM(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="900">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="6">
                <v-autocomplete
                  v-model="form.productId"
                  :items="products"
                  item-title="name"
                  item-value="_id"
                  :label="t('erp.outputProduct')"
                  :rules="[rules.required]"
                  prepend-inner-icon="mdi-package-variant"
                  clearable
                />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model="form.version" :label="t('erp.version')" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="3">
                <v-select v-model="form.status" :label="t('common.status')" :items="bomStatuses" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model.number="form.laborHours" :label="t('erp.laborHours')" type="number" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model.number="form.laborCostPerHour" :label="t('erp.laborCostPerHour')" type="number" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model.number="form.overheadCost" :label="t('erp.overheadCost')" type="number" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12">
                <v-textarea v-model="form.instructions" :label="t('erp.instructions')" rows="2" auto-grow />
              </v-col>
            </v-row>

            <!-- Materials -->
            <div class="d-flex align-center mt-4 mb-2">
              <h3 class="text-subtitle-1">{{ t('erp.materials') }}</h3>
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click="addMaterial">{{ t('common.add') }}</v-btn>
            </div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ t('erp.component') }}</th>
                  <th>{{ t('erp.quantity') }}</th>
                  <th>{{ t('erp.unit') }}</th>
                  <th>{{ t('erp.wastage') }} %</th>
                  <th>{{ t('erp.cost') }}</th>
                  <th>{{ t('erp.notes') }}</th>
                  <th style="width: 50px;"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(mat, idx) in form.materials" :key="idx">
                  <td style="min-width: 200px;">
                    <v-autocomplete
                      v-model="mat.productId"
                      :items="products"
                      item-title="name"
                      item-value="_id"
                      density="compact"
                      variant="plain"
                      hide-details
                    />
                  </td>
                  <td><v-text-field v-model.number="mat.quantity" type="number" density="compact" variant="plain" hide-details /></td>
                  <td><v-text-field v-model="mat.unit" density="compact" variant="plain" hide-details /></td>
                  <td><v-text-field v-model.number="mat.wastagePercent" type="number" density="compact" variant="plain" hide-details /></td>
                  <td><v-text-field v-model.number="mat.cost" type="number" density="compact" variant="plain" hide-details /></td>
                  <td><v-text-field v-model="mat.notes" density="compact" variant="plain" hide-details /></td>
                  <td><v-btn icon="mdi-close" size="x-small" variant="text" color="error" @click="form.materials.splice(idx, 1)" /></td>
                </tr>
              </tbody>
            </v-table>

            <!-- Computed Costs -->
            <v-row class="mt-4">
              <v-col cols="12" md="4">
                <v-text-field :model-value="computedTotalMaterialCost.toFixed(2)" :label="t('erp.totalMaterialCost')" readonly variant="outlined" density="compact" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field :model-value="computedLaborCost.toFixed(2)" :label="t('erp.laborCost')" readonly variant="outlined" density="compact" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field :model-value="computedTotalCost.toFixed(2)" :label="t('erp.totalCost')" readonly variant="outlined" density="compact" />
              </v-col>
            </v-row>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- View BOM Dialog -->
    <v-dialog v-model="viewDialog" max-width="800">
      <v-card v-if="viewItem">
        <v-card-title>{{ viewItem.name }} (v{{ viewItem.version }})</v-card-title>
        <v-card-text>
          <p class="mb-1"><strong>{{ t('erp.outputProduct') }}:</strong> {{ productName(viewItem.productId) }}</p>
          <p class="mb-1"><strong>{{ t('erp.laborHours') }}:</strong> {{ viewItem.laborHours }}h @ {{ viewItem.laborCostPerHour }}/h</p>
          <p class="mb-1"><strong>{{ t('erp.overheadCost') }}:</strong> {{ viewItem.overheadCost?.toFixed(2) || '0.00' }}</p>
          <p class="mb-1"><strong>{{ t('erp.totalMaterialCost') }}:</strong> {{ viewItem.totalMaterialCost?.toFixed(2) || '0.00' }}</p>
          <p class="mb-2"><strong>{{ t('erp.totalCost') }}:</strong> {{ viewItem.totalCost?.toFixed(2) || '0.00' }}</p>
          <p v-if="viewItem.instructions" class="mb-4"><strong>{{ t('erp.instructions') }}:</strong> {{ viewItem.instructions }}</p>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ t('erp.component') }}</th>
                <th class="text-end">{{ t('erp.quantity') }}</th>
                <th>{{ t('erp.unit') }}</th>
                <th class="text-end">{{ t('erp.wastage') }} %</th>
                <th class="text-end">{{ t('erp.cost') }}</th>
                <th>{{ t('erp.notes') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="mat in viewItem.materials" :key="mat.productId">
                <td>{{ productName(mat.productId) }}</td>
                <td class="text-end">{{ mat.quantity }}</td>
                <td>{{ mat.unit }}</td>
                <td class="text-end">{{ mat.wastagePercent || 0 }}</td>
                <td class="text-end">{{ mat.cost?.toFixed(2) || '0.00' }}</td>
                <td>{{ mat.notes || '' }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="viewDialog = false">{{ t('common.close') }}</v-btn></v-card-actions>
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
import { useAppStore } from '../../store/app.store'
import { useERPStore, type BOM } from '../../store/erp.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'

interface Product {
  _id: string
  name: string
  sku: string
  unit: string
}

interface FormMaterial {
  productId: string
  quantity: number
  unit: string
  wastagePercent: number
  cost: number
  notes: string
}

const { t } = useI18n()
const appStore = useAppStore()
const store = useERPStore()

const search = ref('')
const statusFilter = ref<string | null>(null)
const dialog = ref(false)
const viewDialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const viewItem = ref<BOM | null>(null)
const products = ref<Product[]>([])

const bomStatuses = ['draft', 'active', 'obsolete']

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (statusFilter.value) f.status = statusFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/erp/bom`),
  entityKey: 'boms',
  filters,
})

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

const emptyForm = () => ({
  productId: '',
  name: '',
  version: '1.0',
  status: 'draft',
  laborHours: 0,
  laborCostPerHour: 0,
  overheadCost: 0,
  instructions: '',
  materials: [] as FormMaterial[],
})
const form = ref(emptyForm())

const headers = [
  { title: t('common.name'), key: 'name' },
  { title: t('erp.outputProduct'), key: 'productId' },
  { title: t('erp.version'), key: 'version' },
  { title: t('common.status'), key: 'status' },
  { title: t('erp.materials'), key: 'materials' },
  { title: t('erp.totalCost'), key: 'totalCost' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const computedTotalMaterialCost = computed(() => {
  return form.value.materials.reduce((sum, m) => sum + (m.cost || 0) * (m.quantity || 0), 0)
})

const computedLaborCost = computed(() => {
  return (form.value.laborHours || 0) * (form.value.laborCostPerHour || 0)
})

const computedTotalCost = computed(() => {
  return computedTotalMaterialCost.value + computedLaborCost.value + (form.value.overheadCost || 0)
})

function productName(id: string): string {
  const p = products.value.find(p => p._id === id)
  return p ? p.name : id || '-'
}

function statusColor(s: string) {
  return ({ draft: 'warning', active: 'success', obsolete: 'grey' }[s] || 'grey')
}

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function addMaterial() {
  form.value.materials.push({ productId: '', quantity: 1, unit: 'pcs', wastagePercent: 0, cost: 0, notes: '' })
}

function openCreate() {
  editing.value = false
  form.value = emptyForm()
  dialog.value = true
}

function openEdit(item: BOM) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    productId: item.productId || '',
    name: item.name,
    version: item.version,
    status: item.status,
    laborHours: item.laborHours || 0,
    laborCostPerHour: item.laborCostPerHour || 0,
    overheadCost: item.overheadCost || 0,
    instructions: item.instructions || '',
    materials: (item.materials || []).map(m => ({
      productId: m.productId || '',
      quantity: m.quantity,
      unit: m.unit,
      wastagePercent: m.wastagePercent || 0,
      cost: m.cost || 0,
      notes: m.notes || '',
    })),
  }
  dialog.value = true
}

function viewBOM(item: BOM) { viewItem.value = item; viewDialog.value = true }

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  const payload = {
    ...form.value,
    totalMaterialCost: computedTotalMaterialCost.value,
    totalCost: computedTotalCost.value,
  }
  if (editing.value) {
    await store.updateBOM(selectedId.value, payload as unknown as Partial<BOM>)
  } else {
    await store.createBOM(payload as unknown as Partial<BOM>)
  }
  dialog.value = false
  await fetchItems()
}

function confirmDelete(item: BOM) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteBOM(selectedId.value); deleteDialog.value = false; await fetchItems() }

async function fetchProducts() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/product`, { params: { pageSize: 500 } })
    products.value = data.products || []
  } catch {
    products.value = []
  }
}

onMounted(async () => {
  await Promise.all([fetchItems(), fetchProducts()])
})
</script>
