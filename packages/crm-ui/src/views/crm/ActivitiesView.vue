<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('crm.activities') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('common.create') }}</v-btn>
    </div>
    <v-card>
      <v-card-text>
        <v-row class="mb-2">
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="t('common.status')" :items="activityStatuses" clearable hide-details />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="typeFilter" :label="t('common.type')" :items="activityTypes" clearable hide-details />
          </v-col>
        </v-row>
        <v-data-table-server :headers="headers" :items="items" :items-length="pagination.total" :loading="loading" :page="pagination.page + 1" :items-per-page="pagination.size" @update:options="onUpdateOptions" item-value="_id">
          <template #item.type="{ item }">
            <v-chip size="small" :prepend-icon="typeIcon(item.type)">{{ item.type }}</v-chip>
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.dueDate="{ item }">
            <span :class="isOverdue(item) ? 'text-error' : ''">{{ item.dueDate?.split('T')[0] || '-' }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.status === 'pending'" icon="mdi-check" size="small" variant="text" color="success" @click="doComplete(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-select v-model="form.type" :label="t('common.type')" :items="activityTypes" :rules="[rules.required]" />
            <v-text-field v-model="form.subject" :label="t('crm.subject')" :rules="[rules.required]" />
            <v-textarea v-model="form.description" :label="t('common.description')" rows="2" />
            <v-text-field v-model="form.dueDate" :label="t('crm.dueDate')" type="date" />
            <v-select v-model="form.status" :label="t('common.status')" :items="activityStatuses" :rules="[rules.required]" />
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
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useCRMStore, type Activity } from '../../store/crm.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'

const { t } = useI18n()
const appStore = useAppStore()
const store = useCRMStore()

const statusFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')

const activityTypes = ['call', 'email', 'meeting', 'task', 'note']
const activityStatuses = ['pending', 'completed', 'cancelled']

const emptyForm = () => ({ type: 'task', subject: '', description: '', dueDate: '', status: 'pending' })
const form = ref(emptyForm())

const headers = [
  { title: t('common.type'), key: 'type' },
  { title: t('crm.subject'), key: 'subject' },
  { title: t('crm.assignedTo'), key: 'assignedToName' },
  { title: t('crm.dueDate'), key: 'dueDate' },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (statusFilter.value) f.status = statusFilter.value
  if (typeFilter.value) f.type = typeFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/crm/activity`),
  entityKey: 'activities',
  filters,
})

function typeIcon(type: string) {
  return ({ call: 'mdi-phone', email: 'mdi-email', meeting: 'mdi-calendar', task: 'mdi-checkbox-marked', note: 'mdi-note' }[type] || 'mdi-circle')
}

function statusColor(s: string) {
  return ({ pending: 'warning', completed: 'success', cancelled: 'grey' }[s] || 'grey')
}

function isOverdue(item: Activity) {
  if (!item.dueDate || item.status !== 'pending') return false
  return new Date(item.dueDate) < new Date()
}

const rules = { required: (v: string) => !!v || t('validation.required') }

function openCreate() { editing.value = false; form.value = emptyForm(); dialog.value = true }

function openEdit(item: Activity) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    type: item.type, subject: item.subject, description: item.description || '',
    dueDate: item.dueDate?.split('T')[0] || '', status: item.status,
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (editing.value) {
    await store.updateActivity(selectedId.value, form.value)
  } else {
    await store.createActivity(form.value)
  }
  dialog.value = false
  fetchItems()
}

async function doComplete(item: Activity) {
  await store.completeActivity(item._id)
  fetchItems()
}

function confirmDelete(item: Activity) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await store.deleteActivity(selectedId.value); deleteDialog.value = false; fetchItems() }

onMounted(() => { fetchItems() })
</script>
