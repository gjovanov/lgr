<template>
  <v-container :fluid="embedded" :class="{ 'pa-0': embedded }">
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 v-if="!embedded" class="text-h5">{{ t('project.timesheets') }}</h1>
      <div class="d-flex align-center ga-2">
        <v-btn-toggle v-model="viewMode" mandatory density="compact" variant="outlined">
          <v-btn value="grid" size="small"><v-icon start>mdi-table</v-icon>{{ t('timetracking.gridView') }}</v-btn>
          <v-btn value="calendar" size="small"><v-icon start>mdi-calendar</v-icon>{{ t('timetracking.calendarView') }}</v-btn>
        </v-btn-toggle>
        <responsive-btn icon="mdi-plus" color="primary" @click="openCreate">{{ t('common.create') }}</responsive-btn>
      </div>
    </div>

    <!-- Calendar View -->
    <TickyTackCalendarEmbed v-if="viewMode === 'calendar'" :org-id="appStore.currentOrg?.id || ''" :project-id="projectId" />

    <!-- Filters (grid mode only) -->
    <v-card v-if="viewMode === 'grid'" class="mb-4">
      <v-card-text>
        <v-row>
          <v-col v-if="!projectId" cols="12" md="3">
            <v-autocomplete
              v-model="projectFilter"
              :label="t('project.project')"
              :items="projectOptions"
              item-title="name"
              :item-value="(p: any) => p._id || p.id"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-autocomplete
              v-model="employeeFilter"
              :label="t('project.employee')"
              :items="users"
              :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
              item-value="_id"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field v-model="startDateFilter" :label="t('project.startDate')" type="date" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field v-model="endDateFilter" :label="t('project.endDate')" type="date" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Table (grid mode only) -->
    <v-card v-if="viewMode === 'grid'">
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
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.employeeId="{ item }">{{ userNameById(item.employeeId) }}</template>
          <template #item.projectId="{ item }">{{ projectNameById(item.projectId) }}</template>
          <template #item.unitAmount="{ item }">{{ fmtCurrency(item.unitAmount || 0) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? t('common.edit') : t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.date" :label="t('project.date')" type="date" :rules="[rules.required]" />
            <v-autocomplete
              v-model="form.employeeId"
              :label="t('project.employee')"
              :items="users"
              :item-title="(u: any) => `${u.firstName} ${u.lastName}`"
              item-value="_id"
              :rules="[rules.required]"
            />
            <v-autocomplete
              v-model="form.projectId"
              :label="t('project.project')"
              :items="projectOptions"
              item-title="name"
              :item-value="(p: any) => p._id || p.id"
              :rules="[rules.required]"
            />
            <v-autocomplete
              v-model="form.taskId"
              :label="t('project.task')"
              :items="taskOptions"
              item-title="name"
              :item-value="(t: any) => t._id || t.id"
              clearable
            />
            <v-text-field v-model.number="form.hours" :label="t('project.hours')" type="number" step="0.25" :rules="[rules.required]" />
            <v-text-field v-model="form.description" :label="t('common.description')" />
            <v-text-field v-model.number="form.unitAmount" :label="t('project.unitAmount')" type="number" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.save') }}</v-btn>
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
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useProjectStore } from '../../store/project.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TickyTackCalendarEmbed from 'ui-shared/components/TickyTackCalendarEmbed.vue'

interface Props {
  projectId?: string
  embedded?: boolean
}

const props = withDefaults(defineProps<Props>(), { embedded: false })

const { t } = useI18n()
const appStore = useAppStore()
const store = useProjectStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const viewMode = ref<'grid' | 'calendar'>('grid')
const projectFilter = ref(props.projectId || '')
const employeeFilter = ref('')
const startDateFilter = ref('')
const endDateFilter = ref('')
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const users = ref<any[]>([])
const projectOptions = ref<any[]>([])
const taskOptions = ref<any[]>([])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (props.projectId) f.projectId = props.projectId
  else if (projectFilter.value) f.projectId = projectFilter.value
  if (employeeFilter.value) f.employeeId = employeeFilter.value
  if (startDateFilter.value) f.startDate = startDateFilter.value
  if (endDateFilter.value) f.endDate = endDateFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/project/timesheets`),
  entityKey: 'timesheets',
  filters,
})

const headers = computed(() => [
  { title: t('project.date'), key: 'date', sortable: true },
  { title: t('project.employee'), key: 'employeeId' },
  { title: t('project.project'), key: 'projectId' },
  { title: t('project.task'), key: 'taskId' },
  { title: t('project.hours'), key: 'hours', align: 'end' as const },
  { title: t('common.description'), key: 'description' },
  { title: t('project.unitAmount'), key: 'unitAmount', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

function userNameById(id: string) {
  const u = users.value.find((u: any) => u._id === id || u.id === id)
  return u ? `${u.firstName} ${u.lastName}` : id
}

function projectNameById(id: string) {
  const p = projectOptions.value.find((p: any) => (p._id || p.id) === id)
  return p?.name || id
}

const emptyForm = () => ({
  date: new Date().toISOString().split('T')[0],
  employeeId: '',
  projectId: props.projectId || '',
  taskId: '',
  hours: 0,
  description: '',
  unitAmount: 0,
})
const form = ref(emptyForm())

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined && v !== 0) || t('validation.required') }

function openCreate() {
  editing.value = false
  form.value = emptyForm()
  dialog.value = true
}

function openEdit(item: any) {
  editing.value = true
  selectedId.value = item._id || item.id
  form.value = {
    date: item.date?.split('T')[0] || '',
    employeeId: item.employeeId || '',
    projectId: item.projectId || '',
    taskId: item.taskId || '',
    hours: item.hours || 0,
    description: item.description || '',
    unitAmount: item.unitAmount || 0,
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    if (editing.value) {
      await store.updateTimesheet(selectedId.value, form.value)
    } else {
      await store.createTimesheet(form.value)
    }
    dialog.value = false
    fetchItems()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: any) { selectedId.value = item._id || item.id; deleteDialog.value = true }
async function doDelete() {
  try {
    await store.deleteTimesheet(selectedId.value)
    deleteDialog.value = false
    fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

// Load tasks when project changes in form
watch(() => form.value.projectId, async (pid) => {
  if (!pid) { taskOptions.value = []; return }
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/project/tasks`, { params: { projectId: pid, size: 100 } })
    taskOptions.value = data.tasks || []
  } catch { taskOptions.value = [] }
})

async function fetchLookups() {
  try {
    const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
    const [usersRes, projectsRes] = await Promise.all([
      httpClient.get(`/org/${appStore.currentOrg?.id}/user`),
      httpClient.get(`${appStore.orgUrl()}/project/projects`, { params: { size: 100 } }),
    ])
    users.value = usersRes.data.users || usersRes.data || []
    projectOptions.value = projectsRes.data.projects || []
  } catch { /* */ }
}

onMounted(async () => {
  await fetchLookups()
  fetchItems()
})
</script>
