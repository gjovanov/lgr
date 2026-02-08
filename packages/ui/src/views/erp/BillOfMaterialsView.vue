<template>
  <div>
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
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="store.loading" item-value="_id">
          <template #item.status="{ item }">
            <v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.lines="{ item }">{{ item.lines?.length || 0 }} {{ t('erp.components') }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-eye" size="small" variant="text" @click="viewBOM(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="800">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model="form.version" :label="t('erp.version')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-select v-model="form.status" :label="t('common.status')" :items="bomStatuses" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.productName" :label="t('erp.outputProduct')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model.number="form.outputQuantity" :label="t('erp.outputQuantity')" type="number" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model="form.unit" :label="t('erp.unit')" :rules="[rules.required]" />
              </v-col>
            </v-row>

            <!-- BOM Lines -->
            <div class="d-flex align-center mt-4 mb-2">
              <h3 class="text-subtitle-1">{{ t('erp.components') }}</h3>
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-plus" @click="addLine">{{ t('common.add') }}</v-btn>
            </div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ t('erp.component') }}</th>
                  <th>{{ t('erp.quantity') }}</th>
                  <th>{{ t('erp.unit') }}</th>
                  <th>{{ t('erp.wastage') }} %</th>
                  <th style="width: 50px;"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td><v-text-field v-model="line.productName" density="compact" variant="plain" hide-details /></td>
                  <td><v-text-field v-model.number="line.quantity" type="number" density="compact" variant="plain" hide-details /></td>
                  <td><v-text-field v-model="line.unit" density="compact" variant="plain" hide-details /></td>
                  <td><v-text-field v-model.number="line.wastagePercent" type="number" density="compact" variant="plain" hide-details /></td>
                  <td><v-btn icon="mdi-close" size="x-small" variant="text" color="error" @click="form.lines.splice(idx, 1)" /></td>
                </tr>
              </tbody>
            </v-table>
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
    <v-dialog v-model="viewDialog" max-width="700">
      <v-card v-if="viewItem">
        <v-card-title>{{ viewItem.name }} (v{{ viewItem.version }})</v-card-title>
        <v-card-text>
          <p class="mb-2"><strong>{{ t('erp.outputProduct') }}:</strong> {{ viewItem.productName }} - {{ viewItem.outputQuantity }} {{ viewItem.unit }}</p>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ t('erp.component') }}</th>
                <th class="text-end">{{ t('erp.quantity') }}</th>
                <th>{{ t('erp.unit') }}</th>
                <th class="text-end">{{ t('erp.wastage') }} %</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in viewItem.lines" :key="line.productId">
                <td>{{ line.productName }}</td>
                <td class="text-end">{{ line.quantity }}</td>
                <td>{{ line.unit }}</td>
                <td class="text-end">{{ line.wastagePercent || 0 }}</td>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useERPStore, type BOM } from '../../store/erp.store'

const { t } = useI18n()
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

const bomStatuses = ['draft', 'active', 'obsolete']

interface FormLine { productName: string; quantity: number; unit: string; wastagePercent: number }
const emptyForm = () => ({ name: '', version: '1.0', status: 'draft', productName: '', outputQuantity: 1, unit: 'pcs', lines: [] as FormLine[] })
const form = ref(emptyForm())

const headers = [
  { title: t('common.name'), key: 'name' },
  { title: t('erp.outputProduct'), key: 'productName' },
  { title: t('erp.version'), key: 'version' },
  { title: t('common.status'), key: 'status' },
  { title: t('erp.components'), key: 'lines' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const filteredItems = computed(() => {
  let r = store.boms
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  return r
})

function statusColor(s: string) {
  return ({ draft: 'warning', active: 'success', obsolete: 'grey' }[s] || 'grey')
}

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function addLine() { form.value.lines.push({ productName: '', quantity: 1, unit: 'pcs', wastagePercent: 0 }) }

function openCreate() { editing.value = false; form.value = emptyForm(); dialog.value = true }

function openEdit(item: BOM) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    name: item.name, version: item.version, status: item.status,
    productName: item.productName || '', outputQuantity: item.outputQuantity, unit: item.unit,
    lines: (item.lines || []).map(l => ({ productName: l.productName || '', quantity: l.quantity, unit: l.unit, wastagePercent: l.wastagePercent || 0 })),
  }
  dialog.value = true
}

function viewBOM(item: BOM) { viewItem.value = item; viewDialog.value = true }

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (editing.value) {
    await store.updateBOM(selectedId.value, form.value as unknown as Partial<BOM>)
  } else {
    await store.createBOM(form.value as unknown as Partial<BOM>)
  }
  dialog.value = false
}

function confirmDelete(item: BOM) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteBOM(selectedId.value); deleteDialog.value = false }

onMounted(() => { store.fetchBOMs() })
</script>
