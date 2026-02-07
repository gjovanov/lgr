<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('crm.leads') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-row class="mb-2">
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" single-line hide-details clearable />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="t('common.status')" :items="statuses" clearable hide-details />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="sourceFilter" :label="t('crm.source')" :items="sources" clearable hide-details />
          </v-col>
        </v-row>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="store.loading" :no-data-text="t('common.noData')" item-value="_id">
          <template #item.status="{ item }">
            <v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.createdAt="{ item }">{{ item.createdAt?.split('T')[0] }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.status === 'qualified'" icon="mdi-swap-horizontal" size="small" variant="text" color="success" :title="t('crm.convert')" @click="doConvert(item)" />
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
            <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
            <v-text-field v-model="form.email" :label="t('common.email')" type="email" />
            <v-text-field v-model="form.phone" :label="t('common.phone')" />
            <v-text-field v-model="form.company" :label="t('crm.company')" />
            <v-select v-model="form.source" :label="t('crm.source')" :items="sources" :rules="[rules.required]" />
            <v-select v-model="form.status" :label="t('common.status')" :items="statuses" :rules="[rules.required]" />
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
import { useCRMStore, type Lead } from '../../store/crm.store'

const { t } = useI18n()
const store = useCRMStore()

const search = ref('')
const statusFilter = ref<string | null>(null)
const sourceFilter = ref<string | null>(null)
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const statuses = ['new', 'contacted', 'qualified', 'unqualified', 'converted']
const sources = ['website', 'referral', 'advertisement', 'cold_call', 'social_media', 'other']

const emptyForm = () => ({ name: '', email: '', phone: '', company: '', source: '', status: 'new', notes: '' })
const form = ref(emptyForm())

const headers = [
  { title: t('common.name'), key: 'name' },
  { title: t('crm.company'), key: 'company' },
  { title: t('crm.source'), key: 'source' },
  { title: t('common.status'), key: 'status' },
  { title: t('common.email'), key: 'email' },
  { title: t('common.date'), key: 'createdAt' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const filteredItems = computed(() => {
  let r = store.leads
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  if (sourceFilter.value) r = r.filter(i => i.source === sourceFilter.value)
  return r
})

function statusColor(s: string) {
  return ({ new: 'info', contacted: 'primary', qualified: 'success', unqualified: 'grey', converted: 'warning' }[s] || 'grey')
}

const rules = { required: (v: string) => !!v || t('validation.required') }

function openCreate() { editing.value = false; form.value = emptyForm(); dialog.value = true }

function openEdit(item: Lead) {
  editing.value = true
  selectedId.value = item._id
  form.value = { name: item.name, email: item.email || '', phone: item.phone || '', company: item.company || '', source: item.source, status: item.status, notes: item.notes || '' }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (editing.value) {
    await store.updateLead(selectedId.value, form.value)
  } else {
    await store.createLead(form.value)
  }
  dialog.value = false
}

async function doConvert(item: Lead) {
  await store.convertLead(item._id, { createDeal: true })
}

function confirmDelete(item: Lead) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteLead(selectedId.value); deleteDialog.value = false }

onMounted(() => { store.fetchLeads() })
</script>
