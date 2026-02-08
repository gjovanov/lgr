<template>
  <div>
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
          <template #item.plannedStart="{ item }">{{ item.plannedStart?.split('T')[0] }}</template>
          <template #item.plannedEnd="{ item }">{{ item.plannedEnd?.split('T')[0] }}</template>
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
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.number" :label="t('erp.orderNumber')" :rules="[rules.required]" />
            <v-select v-model="form.bomId" :label="t('erp.bom')" :items="store.boms" item-title="name" item-value="_id" :rules="[rules.required]" />
            <v-text-field v-model.number="form.quantity" :label="t('erp.quantity')" type="number" :rules="[rules.required]" />
            <v-text-field v-model="form.plannedStart" :label="t('erp.plannedStart')" type="date" :rules="[rules.required]" />
            <v-text-field v-model="form.plannedEnd" :label="t('erp.plannedEnd')" type="date" :rules="[rules.required]" />
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useERPStore, type ProductionOrder } from '../../store/erp.store'

const { t } = useI18n()
const store = useERPStore()

const search = ref('')
const statusFilter = ref<string | null>(null)
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const orderStatuses = ['planned', 'in_progress', 'completed', 'cancelled']

const emptyForm = () => ({ number: '', bomId: '', quantity: 1, plannedStart: '', plannedEnd: '', notes: '' })
const form = ref(emptyForm())

const headers = [
  { title: t('erp.orderNumber'), key: 'number' },
  { title: t('erp.bom'), key: 'bomName' },
  { title: t('erp.quantity'), key: 'quantity', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('erp.plannedStart'), key: 'plannedStart' },
  { title: t('erp.plannedEnd'), key: 'plannedEnd' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const filteredItems = computed(() => {
  let r = store.productionOrders
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  return r
})

function statusColor(s: string) {
  return ({ planned: 'info', in_progress: 'warning', completed: 'success', cancelled: 'error' }[s] || 'grey')
}

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function openCreate() { editing.value = false; form.value = emptyForm(); dialog.value = true }

function openEdit(item: ProductionOrder) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    number: item.number, bomId: item.bomId, quantity: item.quantity,
    plannedStart: item.plannedStart?.split('T')[0] || '', plannedEnd: item.plannedEnd?.split('T')[0] || '',
    notes: item.notes || '',
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (editing.value) {
    await store.updateProductionOrder(selectedId.value, form.value as unknown as Partial<ProductionOrder>)
  } else {
    await store.createProductionOrder(form.value as unknown as Partial<ProductionOrder>)
  }
  dialog.value = false
}

async function doStart(item: ProductionOrder) { await store.startProduction(item._id) }
async function doComplete(item: ProductionOrder) { await store.completeProduction(item._id) }

function confirmDelete(item: ProductionOrder) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteProductionOrder(selectedId.value); deleteDialog.value = false }

onMounted(() => {
  store.fetchProductionOrders()
  store.fetchBOMs()
})
</script>
