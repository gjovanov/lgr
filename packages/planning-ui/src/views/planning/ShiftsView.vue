<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('planning.shifts') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="filters.employeeId" :label="$t('planning.employee')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="filters.projectId" :label="$t('planning.project')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="filters.state" :label="$t('common.state')" :items="shiftStates" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="filters.startDate" :label="$t('planning.dateFrom')" type="date" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="filters.endDate" :label="$t('planning.dateTo')" type="date" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="1" class="d-flex align-center">
            <v-btn icon="mdi-magnify" variant="text" @click="fetchData" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="total"
          :loading="store.loading"
          :page="page + 1"
          :items-per-page="pageSize"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.color="{ item }">
            <v-icon v-if="item.color" :color="item.color" size="small">mdi-circle</v-icon>
          </template>
          <template #item.dateStart="{ item }">{{ formatDt(item.dateStart) }}</template>
          <template #item.dateEnd="{ item }">{{ formatDt(item.dateEnd) }}</template>
          <template #item.state="{ item }">
            <v-chip size="small" :color="stateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Create / Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.employeeId" :label="$t('planning.employee')" />
            <v-text-field v-model="form.projectId" :label="$t('planning.project')" />
            <v-row>
              <v-col cols="6">
                <v-text-field v-model="form.dateStart" :label="$t('planning.dateStart')" type="datetime-local" :rules="[v => !!v || $t('required')]" />
              </v-col>
              <v-col cols="6">
                <v-text-field v-model="form.dateEnd" :label="$t('planning.dateEnd')" type="datetime-local" :rules="[v => !!v || $t('required')]" />
              </v-col>
            </v-row>
            <v-text-field v-model.number="form.hours" :label="$t('planning.hours')" type="number" :rules="[v => v >= 0 || $t('required')]" />
            <v-select v-if="editing" v-model="form.state" :label="$t('common.state')" :items="shiftStates" />
            <v-text-field v-model="form.color" :label="$t('planning.color')" placeholder="#4CAF50" />
            <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="2" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('planning.deleteShiftConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="store.loading" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlanningStore, type Shift } from '../../store/planning.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const store = usePlanningStore()
const { showSuccess, showError } = useSnackbar()

const shiftStates = ['draft', 'published', 'confirmed', 'cancelled']
const items = ref<Shift[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(10)

const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const editId = ref('')
const formRef = ref()

const filters = reactive({ employeeId: '', projectId: '', state: '' as string, startDate: '', endDate: '' })

const form = ref({
  employeeId: '',
  projectId: '',
  dateStart: '',
  dateEnd: '',
  hours: 0,
  state: 'draft',
  color: '',
  notes: '',
})

const headers = computed(() => [
  { title: '', key: 'color', width: 40, sortable: false },
  { title: t('planning.employee'), key: 'employeeName' },
  { title: t('planning.dateStart'), key: 'dateStart', sortable: true },
  { title: t('planning.dateEnd'), key: 'dateEnd', sortable: true },
  { title: t('planning.hours'), key: 'hours', sortable: true },
  { title: t('common.state'), key: 'state', sortable: true },
  { title: t('planning.project'), key: 'projectName' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function stateColor(state: string) {
  const map: Record<string, string> = { draft: 'grey', published: 'info', confirmed: 'success', cancelled: 'error' }
  return map[state] || 'grey'
}

function formatDt(dt: string) {
  if (!dt) return '-'
  return new Date(dt).toLocaleString()
}

async function fetchData() {
  const params: Record<string, any> = { page: page.value, size: pageSize.value }
  if (filters.employeeId) params.employeeId = filters.employeeId
  if (filters.projectId) params.projectId = filters.projectId
  if (filters.state) params.state = filters.state
  if (filters.startDate) params.startDate = filters.startDate
  if (filters.endDate) params.endDate = filters.endDate
  const data = await store.fetchShifts(params)
  items.value = store.shifts
  total.value = data?.total || 0
}

function onUpdateOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 10
  fetchData()
}

function openCreate() {
  editing.value = false
  editId.value = ''
  form.value = { employeeId: '', projectId: '', dateStart: '', dateEnd: '', hours: 0, state: 'draft', color: '', notes: '' }
  dialog.value = true
}

function openEdit(item: Shift) {
  editing.value = true
  editId.value = item._id
  form.value = {
    employeeId: item.employeeId || '',
    projectId: item.projectId || '',
    dateStart: item.dateStart ? new Date(item.dateStart).toISOString().slice(0, 16) : '',
    dateEnd: item.dateEnd ? new Date(item.dateEnd).toISOString().slice(0, 16) : '',
    hours: item.hours,
    state: item.state,
    color: item.color || '',
    notes: item.notes || '',
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    const payload: any = { ...form.value }
    if (!payload.employeeId) delete payload.employeeId
    if (!payload.projectId) delete payload.projectId
    if (!payload.color) delete payload.color
    if (!payload.notes) delete payload.notes

    if (editing.value) {
      await store.updateShift(editId.value, payload)
      showSuccess(t('common.savedSuccessfully'))
    } else {
      delete payload.state
      await store.createShift(payload)
      showSuccess(t('common.createdSuccessfully'))
    }
    dialog.value = false
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: Shift) {
  editId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await store.deleteShift(editId.value)
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchData() })
</script>
