<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('hr.departments') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable class="mb-4" />
        <v-data-table :headers="headers" :items="items" :search="search" :loading="loading" item-value="_id">
          <template #item.name="{ item }">
            <span :style="{ paddingLeft: getDepth(item) * 20 + 'px' }">{{ item.name }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
            <v-text-field v-model="form.code" :label="t('common.code')" />
            <v-select v-model="form.parentId" :label="t('hr.parentDepartment')" :items="parentOptions" item-title="name" item-value="_id" clearable />
            <v-text-field v-model="form.managerName" :label="t('hr.manager')" />
            <v-textarea v-model="form.description" :label="t('common.description')" rows="2" />
          </v-form>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn><v-btn color="primary" :loading="loading" @click="save">{{ t('common.save') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card><v-card-title>{{ t('common.confirmDelete') }}</v-card-title><v-card-text>{{ t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="deleteDialog = false">{{ t('common.cancel') }}</v-btn><v-btn color="error" @click="doDelete">{{ t('common.delete') }}</v-btn></v-card-actions></v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'

interface Dept { _id: string; code: string; name: string; parentId?: string; managerName: string; employeeCount: number; description?: string }

const { t } = useI18n()
const appStore = useAppStore()
const search = ref('')
const loading = ref(false)
const items = ref<Dept[]>([])
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const form = ref({ name: '', code: '', parentId: '', managerName: '', description: '' })

const headers = [
  { title: t('common.code'), key: 'code' },
  { title: t('common.name'), key: 'name' },
  { title: t('hr.manager'), key: 'managerName' },
  { title: t('hr.employeeCount'), key: 'employeeCount', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const parentOptions = computed(() => items.value.map(d => ({ _id: d._id, name: d.name })))

function getDepth(item: Dept) {
  let depth = 0
  let current = item
  while (current.parentId) {
    depth++
    const p = items.value.find(d => d._id === current.parentId)
    if (!p) break
    current = p
  }
  return depth
}

const rules = { required: (v: string) => !!v || t('validation.required') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreate() { editing.value = false; form.value = { name: '', code: '', parentId: '', managerName: '', description: '' }; dialog.value = true }
function openEdit(item: Dept) { editing.value = true; selectedId.value = item._id; form.value = { name: item.name, code: item.code, parentId: item.parentId || '', managerName: item.managerName, description: item.description || '' }; dialog.value = true }

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    if (editing.value) await httpClient.put(`${orgUrl()}/hr/department/${selectedId.value}`, form.value)
    else await httpClient.post(`${orgUrl()}/hr/department`, form.value)
    await fetchItems()
    dialog.value = false
  } finally { loading.value = false }
}

function confirmDelete(item: Dept) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await httpClient.delete(`${orgUrl()}/hr/department/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }
async function fetchItems() { loading.value = true; try { const { data } = await httpClient.get(`${orgUrl()}/hr/department`); items.value = data.departments || [] } finally { loading.value = false } }

onMounted(() => { fetchItems() })
</script>
