<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('planning.appointments') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'planning.appointments.new' }">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="3">
            <v-select v-model="stateFilter" :label="$t('common.state')" :items="apptStates" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field v-model="assigneeFilter" :label="$t('planning.assignee')" clearable hide-details density="compact" />
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
          <template #item.typeName="{ item }">
            <router-link :to="{ name: 'planning.appointments.edit', params: { id: item._id } }" class="text-decoration-none">{{ item.typeName || item.typeId }}</router-link>
          </template>
          <template #item.dateStart="{ item }">{{ formatDt(item.dateStart) }}</template>
          <template #item.dateEnd="{ item }">{{ formatDt(item.dateEnd) }}</template>
          <template #item.state="{ item }">
            <v-chip size="small" :color="stateColor(item.state)">{{ item.state }}</v-chip>
          </template>
          <template #item.meetingUrl="{ item }">
            <a v-if="item.meetingUrl" :href="item.meetingUrl" target="_blank" class="text-decoration-none">{{ $t('planning.join') }}</a>
            <span v-else>-</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'planning.appointments.edit', params: { id: item._id } }" />
            <v-btn v-if="item.state === 'scheduled'" icon="mdi-check" size="small" variant="text" color="success" :title="$t('planning.confirm')" @click="doConfirm(item)" />
            <v-btn v-if="item.state !== 'done' && item.state !== 'cancelled'" icon="mdi-cancel" size="small" variant="text" color="error" :title="$t('common.cancel')" @click="doCancelAppt(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Delete Dialog -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('planning.deleteAppointmentConfirm') }}</v-card-text>
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
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlanningStore, type Appointment } from '../../store/planning.store'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const store = usePlanningStore()
const { showSuccess, showError } = useSnackbar()

const apptStates = ['scheduled', 'confirmed', 'done', 'cancelled', 'no_show']
const stateFilter = ref<string | null>(null)
const assigneeFilter = ref('')
const items = ref<Appointment[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(10)
const deleteDialog = ref(false)
const deleteId = ref('')

const headers = computed(() => [
  { title: t('planning.type'), key: 'typeName' },
  { title: t('planning.partner'), key: 'partnerName' },
  { title: t('planning.assignee'), key: 'assigneeName' },
  { title: t('planning.dateStart'), key: 'dateStart', sortable: true },
  { title: t('planning.dateEnd'), key: 'dateEnd' },
  { title: t('common.state'), key: 'state', sortable: true },
  { title: t('planning.meetingUrl'), key: 'meetingUrl', sortable: false },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function stateColor(state: string) {
  const map: Record<string, string> = { scheduled: 'info', confirmed: 'success', done: 'info', cancelled: 'error', no_show: 'warning' }
  return map[state] || 'grey'
}

function formatDt(dt: string) {
  if (!dt) return '-'
  return new Date(dt).toLocaleString()
}

async function fetchData() {
  const params: Record<string, any> = { page: page.value, size: pageSize.value }
  if (stateFilter.value) params.state = stateFilter.value
  if (assigneeFilter.value) params.assigneeId = assigneeFilter.value
  const data = await store.fetchAppointments(params)
  items.value = store.appointments
  total.value = data?.total || 0
}

function onUpdateOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 10
  fetchData()
}

watch([stateFilter], () => { page.value = 0; fetchData() })

async function doConfirm(item: Appointment) {
  try {
    await store.confirmAppointment(item._id)
    showSuccess(t('planning.appointmentConfirmed'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doCancelAppt(item: Appointment) {
  try {
    await store.cancelAppointment(item._id)
    showSuccess(t('planning.appointmentCancelled'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: Appointment) {
  deleteId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await store.deleteAppointment(deleteId.value)
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
    await fetchData()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchData() })
</script>
