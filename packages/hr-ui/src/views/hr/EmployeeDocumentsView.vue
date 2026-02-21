<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('hr.employeeDocuments') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.upload') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-row class="mb-2">
          <v-col cols="12" md="5"><v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable /></v-col>
          <v-col cols="12" md="3"><v-select v-model="typeFilter" :label="t('common.type')" :items="docTypes" clearable hide-details /></v-col>
        </v-row>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="loading" item-value="_id">
          <template #item.uploadDate="{ item }">{{ item.uploadDate?.split('T')[0] }}</template>
          <template #item.expiryDate="{ item }">
            <span :class="isExpired(item.expiryDate) ? 'text-error' : ''">{{ item.expiryDate?.split('T')[0] || '-' }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-download" size="small" variant="text" @click="download(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ t('common.upload') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.employeeName" :label="t('payroll.employee')" :rules="[rules.required]" />
            <v-select v-model="form.type" :label="t('common.type')" :items="docTypes" :rules="[rules.required]" />
            <v-text-field v-model="form.title" :label="t('common.name')" :rules="[rules.required]" />
            <v-text-field v-model="form.expiryDate" :label="t('hr.expiryDate')" type="date" />
            <v-file-input v-model="form.file" :label="t('hr.file')" />
          </v-form>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn><v-btn color="primary" :loading="loading" @click="save">{{ t('common.upload') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card><v-card-title>{{ t('common.confirmDelete') }}</v-card-title><v-card-text>{{ t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="deleteDialog = false">{{ t('common.cancel') }}</v-btn><v-btn color="error" @click="doDelete">{{ t('common.delete') }}</v-btn></v-card-actions></v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'

interface Doc { _id: string; employeeName: string; type: string; title: string; uploadDate: string; expiryDate?: string; fileUrl: string }

const { t } = useI18n()
const appStore = useAppStore()
const search = ref(''); const loading = ref(false); const items = ref<Doc[]>([]); const dialog = ref(false); const deleteDialog = ref(false); const formRef = ref(); const selectedId = ref('')
const typeFilter = ref<string | null>(null)
const docTypes = ['contract', 'id_document', 'certificate', 'medical', 'performance_review', 'other']
const form = ref({ employeeName: '', type: '', title: '', expiryDate: '', file: null as File | null })

const headers = [
  { title: t('payroll.employee'), key: 'employeeName' }, { title: t('common.type'), key: 'type' },
  { title: t('common.name'), key: 'title' }, { title: t('hr.uploadDate'), key: 'uploadDate' },
  { title: t('hr.expiryDate'), key: 'expiryDate' }, { title: t('common.actions'), key: 'actions', sortable: false },
]
const filteredItems = computed(() => { let r = items.value; if (typeFilter.value) r = r.filter(i => i.type === typeFilter.value); return r })
function isExpired(date?: string) { if (!date) return false; return new Date(date) < new Date() }
const rules = { required: (v: string) => !!v || t('validation.required') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreate() { form.value = { employeeName: '', type: '', title: '', expiryDate: '', file: null }; dialog.value = true }
async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    const fd = new FormData()
    if (form.value.employeeName) fd.append('employeeName', form.value.employeeName)
    if (form.value.type) fd.append('type', form.value.type)
    if (form.value.title) fd.append('title', form.value.title)
    if (form.value.expiryDate) fd.append('expiryDate', form.value.expiryDate)
    if (form.value.file) fd.append('file', form.value.file)
    await httpClient.post(`${orgUrl()}/employee-documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    await fetchItems(); dialog.value = false
  } finally { loading.value = false }
}
function download(item: Doc) { window.open(`/api${orgUrl()}/employee-documents/${item._id}/download`, '_blank') }
function confirmDelete(item: Doc) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await httpClient.delete(`${orgUrl()}/employee-documents/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }
async function fetchItems() { loading.value = true; try { const { data } = await httpClient.get(`${orgUrl()}/employee-documents`); items.value = data.documents || [] } finally { loading.value = false } }

onMounted(() => { fetchItems() })
</script>
