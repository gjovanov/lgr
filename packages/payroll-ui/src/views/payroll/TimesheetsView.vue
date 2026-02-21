<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('payroll.timesheets') }}</h1>
      <v-spacer />
      <ExportMenu class="mr-2" @export="handleExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.create') }}
      </v-btn>
    </div>

    <v-row class="mb-4">
      <v-col cols="12" sm="4">
        <v-select v-model="filterEmployee" :label="$t('payroll.employee')" :items="employees" item-title="name" item-value="_id" clearable density="compact" />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field v-model="filterDateFrom" :label="$t('common.from')" type="date" density="compact" />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field v-model="filterDateTo" :label="$t('common.to')" type="date" density="compact" />
      </v-col>
    </v-row>

    <DataTable :headers="headers" :items="store.timesheets" :loading="store.loading">
      <template #item.type="{ item }">
        <v-chip :color="typeColor(item.type)" size="small">{{ item.type }}</v-chip>
      </template>
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
      </template>
    </DataTable>

    <v-dialog v-model="dialog" max-width="500" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('payroll.timesheetEntry') }}</v-card-title>
        <v-card-text>
          <v-select v-model="form.employeeId" :label="$t('payroll.employee')" :items="employees" item-title="name" item-value="_id" class="mb-2" />
          <v-text-field v-model="form.date" :label="$t('common.date')" type="date" class="mb-2" />
          <v-row>
            <v-col cols="6"><v-text-field v-model.number="form.hoursWorked" :label="$t('payroll.hoursWorked')" type="number" step="0.5" min="0" max="24" /></v-col>
            <v-col cols="6"><v-text-field v-model.number="form.overtime" :label="$t('payroll.overtime')" type="number" step="0.5" min="0" max="24" /></v-col>
          </v-row>
          <v-select v-model="form.type" :label="$t('common.type')" :items="['Regular', 'Overtime', 'Holiday', 'Sick Leave', 'Vacation']" class="mb-2" />
          <v-select v-model="form.status" :label="$t('common.status')" :items="['Draft', 'Submitted', 'Approved', 'Rejected']" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import DataTable from 'ui-shared/components/DataTable'
import ExportMenu from 'ui-shared/components/ExportMenu'

const { t } = useI18n()
const store = usePayrollStore()

const dialog = ref(false)
const editing = ref(false)
const saving = ref(false)
const filterEmployee = ref('')
const filterDateFrom = ref('')
const filterDateTo = ref('')
const employees = ref<any[]>([])

const headers = [
  { title: t('payroll.employee'), key: 'employeeName' },
  { title: t('common.date'), key: 'date' },
  { title: t('payroll.hoursWorked'), key: 'hoursWorked', align: 'end' as const },
  { title: t('payroll.overtime'), key: 'overtime', align: 'end' as const },
  { title: t('common.type'), key: 'type' },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

const emptyForm = () => ({
  _id: '', employeeId: '', date: '', hoursWorked: 8, overtime: 0, type: 'Regular', status: 'Draft',
})

const form = reactive(emptyForm())

function openDialog(item?: any) {
  if (item) {
    editing.value = true
    Object.assign(form, item)
  } else {
    editing.value = false
    Object.assign(form, emptyForm())
  }
  dialog.value = true
}

async function save() {
  saving.value = true
  try {
    await store.saveTimesheet({ ...form })
    dialog.value = false
    await store.fetchTimesheets()
  } finally {
    saving.value = false
  }
}

function typeColor(type: string) {
  const colors: Record<string, string> = { Regular: 'primary', Overtime: 'warning', Holiday: 'info', 'Sick Leave': 'error', Vacation: 'success' }
  return colors[type] || 'grey'
}

function statusColor(status: string) {
  const colors: Record<string, string> = { Draft: 'grey', Submitted: 'info', Approved: 'success', Rejected: 'error' }
  return colors[status] || 'grey'
}

function handleExport(format: string) { /* TODO */ }

onMounted(() => store.fetchTimesheets())
</script>
