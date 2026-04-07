<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('payroll.timesheets') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <ExportMenu @export="handleExport" />
        <responsive-btn icon="mdi-plus" color="primary" :to="{ name: 'payroll.timesheets.new' }">
          {{ $t('common.create') }}
        </responsive-btn>
      </div>
    </div>

    <v-row class="mb-4">
      <v-col cols="12" sm="3">
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
      </v-col>
      <v-col cols="12" sm="3">
        <v-select v-model="filterEmployee" :label="$t('payroll.employee')" :items="employees" item-title="name" item-value="_id" clearable density="compact" />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field v-model="filterDateFrom" :label="$t('common.from')" type="date" density="compact" />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field v-model="filterDateTo" :label="$t('common.to')" type="date" density="compact" />
      </v-col>
    </v-row>

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
      <template #item.employeeName="{ item }">
        <entity-link v-if="item.employeeId" :label="item.employeeName" :to="{ name: 'payroll.employee-edit', params: { id: item.employeeId } }" />
        <span v-else>{{ item.employeeName }}</span>
      </template>
      <template #item.type="{ item }">
        <v-chip :color="typeColor(item.type)" size="small">{{ item.type }}</v-chip>
      </template>
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'payroll.timesheets.edit', params: { id: item._id } }" />
      </template>
    </v-data-table-server>

  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'

const { t } = useI18n()
const appStore = useAppStore()

const { search, debouncedSearch } = useSearchDebounce()
const filterEmployee = ref('')
const filterDateFrom = ref('')
const filterDateTo = ref('')
const employees = ref<any[]>([])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (filterEmployee.value) f.employeeId = filterEmployee.value
  if (filterDateFrom.value) f.dateFrom = filterDateFrom.value
  if (filterDateTo.value) f.dateTo = filterDateTo.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/payroll/timesheet`),
  entityKey: 'timesheets',
  filters,
})

const headers = [
  { title: t('payroll.employee'), key: 'employeeName' },
  { title: t('common.date'), key: 'date' },
  { title: t('payroll.hoursWorked'), key: 'hoursWorked', align: 'end' as const },
  { title: t('payroll.overtime'), key: 'overtime', align: 'end' as const },
  { title: t('common.type'), key: 'type' },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

function typeColor(type: string) {
  const colors: Record<string, string> = { Regular: 'primary', Overtime: 'warning', Holiday: 'info', 'Sick Leave': 'error', Vacation: 'success' }
  return colors[type] || 'grey'
}

function statusColor(status: string) {
  const colors: Record<string, string> = { Draft: 'grey', Submitted: 'info', Approved: 'success', Rejected: 'error' }
  return colors[status] || 'grey'
}

function handleExport(format: string) { /* TODO */ }

onMounted(() => fetchItems())
</script>
