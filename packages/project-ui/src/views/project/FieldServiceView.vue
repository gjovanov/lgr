<template>
  <v-container fluid>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h5">{{ t('project.fieldService') }}</h1>
      <responsive-btn icon="mdi-plus" color="primary" @click="openCreate">{{ t('common.create') }}</responsive-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="stateFilter" :label="t('common.state')" :items="fsStates" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="priorityFilter" :label="t('project.priority')" :items="priorities" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="startDateFilter" :label="t('project.startDate')" type="date" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="endDateFilter" :label="t('project.endDate')" type="date" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Table -->
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
          <template #item.name="{ item }">
            <span class="cursor-pointer text-primary" @click="openEdit(item)">{{ item.name }}</span>
          </template>
          <template #item.assignee="{ item }">
            {{ item.assignee ? `${item.assignee.firstName} ${item.assignee.lastName}` : '-' }}
          </template>
          <template #item.partner="{ item }">
            {{ item.partner?.companyName || (item.partner ? `${item.partner.firstName} ${item.partner.lastName}` : '-') }}
          </template>
          <template #item.state="{ item }">
            <v-chip size="small" :color="fsStateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.priority="{ item }">
            <v-chip size="small" :color="priorityColor(item.priority)">{{ item.priority }}</v-chip>
          </template>
          <template #item.dateScheduled="{ item }">{{ item.dateScheduled?.split('T')[0] || '-' }}</template>
          <template #item.actions="{ item }">
            <v-btn v-if="item.state === 'scheduled'" icon="mdi-play" size="small" variant="text" color="primary" :title="t('project.start')" @click="doStart(item)" />
            <v-btn v-if="item.state === 'in_progress'" icon="mdi-check" size="small" variant="text" color="success" :title="t('project.complete')" @click="openComplete(item)" />
            <v-btn v-if="item.state !== 'done' && item.state !== 'cancelled'" icon="mdi-close" size="small" variant="text" color="error" :title="t('common.cancel')" @click="doCancel(item)" />
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.state === 'scheduled'" icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="8">
                <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-select v-model="form.priority" :label="t('project.priority')" :items="priorities" />
              </v-col>
              <v-col cols="12">
                <v-textarea v-model="form.description" :label="t('common.description')" rows="2" auto-grow />
              </v-col>
              <v-col cols="12" md="6">
                <v-autocomplete
                  v-model="form.assigneeId"
                  :label="t('project.assignee')"
                  :items="users"
                  :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
                  item-value="_id"
                  :rules="[rules.required]"
                />
              </v-col>
              <v-col cols="12" md="6">
                <v-autocomplete
                  v-model="form.partnerId"
                  :label="t('project.partner')"
                  :items="contacts"
                  :item-title="(c: any) => c.companyName || `${c.firstName} ${c.lastName}`"
                  item-value="_id"
                  clearable
                />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.dateScheduled" :label="t('project.dateScheduled')" type="date" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.location" :label="t('project.location')" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model.number="form.plannedHours" :label="t('project.plannedHours')" type="number" />
              </v-col>
              <v-col cols="12">
                <TagInput v-model="form.tags" type="field_service" :org-url="appStore.orgUrl()" />
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

    <!-- Complete Dialog -->
    <v-dialog v-model="completeDialog" max-width="500">
      <v-card>
        <v-card-title>{{ t('project.completeTask') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model.number="completeForm.effectiveHours" :label="t('project.effectiveHours')" type="number" />
          <v-text-field v-model.number="completeForm.laborRate" :label="t('project.laborRate')" type="number" />
          <v-textarea v-model="completeForm.worksheetNotes" :label="t('project.worksheetNotes')" rows="3" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="completeDialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="success" :loading="store.loading" @click="doComplete">{{ t('project.complete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Dialog -->
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
import { useProjectStore } from '../../store/project.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'

const { t } = useI18n()
const appStore = useAppStore()
const store = useProjectStore()
const { showSuccess, showError } = useSnackbar()
const { search, debouncedSearch } = useSearchDebounce()

const stateFilter = ref<string | null>(null)
const priorityFilter = ref<string | null>(null)
const startDateFilter = ref('')
const endDateFilter = ref('')
const dialog = ref(false)
const completeDialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const users = ref<any[]>([])
const contacts = ref<any[]>([])

const fsStates = ['scheduled', 'in_progress', 'done', 'cancelled']
const priorities = ['low', 'normal', 'high', 'urgent']

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (stateFilter.value) f.state = stateFilter.value
  if (priorityFilter.value) f.priority = priorityFilter.value
  if (startDateFilter.value) f.startDate = startDateFilter.value
  if (endDateFilter.value) f.endDate = endDateFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/project/field-service`),
  entityKey: 'tasks',
  filters,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('project.assignee'), key: 'assignee' },
  { title: t('project.partner'), key: 'partner' },
  { title: t('project.location'), key: 'location' },
  { title: t('common.state'), key: 'state' },
  { title: t('project.priority'), key: 'priority' },
  { title: t('project.dateScheduled'), key: 'dateScheduled' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fsStateColor(state: string) {
  return ({ scheduled: 'info', in_progress: 'primary', done: 'success', cancelled: 'error' }[state] || 'grey')
}

function priorityColor(priority: string) {
  return ({ low: 'grey', normal: 'info', high: 'warning', urgent: 'error' }[priority] || 'grey')
}

const emptyForm = () => ({
  name: '',
  description: '',
  assigneeId: '',
  partnerId: '',
  dateScheduled: '',
  location: '',
  priority: 'normal',
  plannedHours: 0,
  tags: [] as string[],
})
const form = ref(emptyForm())

const completeForm = ref({ effectiveHours: 0, laborRate: 0, worksheetNotes: '' })

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

function openCreate() {
  editing.value = false
  form.value = emptyForm()
  dialog.value = true
}

function openEdit(item: any) {
  editing.value = true
  selectedId.value = item._id || item.id
  form.value = {
    name: item.name || '',
    description: item.description || '',
    assigneeId: item.assigneeId || '',
    partnerId: item.partnerId || '',
    dateScheduled: item.dateScheduled?.split('T')[0] || '',
    location: item.location || '',
    priority: item.priority || 'normal',
    plannedHours: item.plannedHours || 0,
    tags: item.tags || [],
  }
  dialog.value = true
}

function openComplete(item: any) {
  selectedId.value = item._id || item.id
  completeForm.value = { effectiveHours: item.plannedHours || 0, laborRate: 0, worksheetNotes: '' }
  completeDialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    if (editing.value) {
      await store.updateFieldServiceTask(selectedId.value, form.value)
    } else {
      await store.createFieldServiceTask(form.value)
    }
    dialog.value = false
    fetchItems()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doStart(item: any) {
  try {
    await store.startFieldServiceTask(item._id || item.id)
    fetchItems()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doComplete() {
  try {
    await store.completeFieldServiceTask(selectedId.value, completeForm.value)
    completeDialog.value = false
    fetchItems()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doCancel(item: any) {
  try {
    await store.cancelFieldServiceTask(item._id || item.id)
    fetchItems()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: any) { selectedId.value = item._id || item.id; deleteDialog.value = true }
async function doDelete() {
  try {
    await store.deleteFieldServiceTask(selectedId.value)
    deleteDialog.value = false
    fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchLookups() {
  try {
    const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
    const [usersRes, contactsRes] = await Promise.all([
      httpClient.get(`${portalBase}/org/${appStore.currentOrg?.id}/users`),
      httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, { params: { pageSize: 200 } }),
    ])
    users.value = usersRes.data.users || usersRes.data || []
    contacts.value = contactsRes.data.contacts || []
  } catch { /* */ }
}

onMounted(async () => {
  await fetchLookups()
  fetchItems()
})
</script>
