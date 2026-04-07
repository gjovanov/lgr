<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('payroll.payrollRuns') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <ExportMenu @export="handleExport" />
        <responsive-btn icon="mdi-plus" color="primary" :to="{ name: 'payroll.runs.new' }">
          {{ $t('common.create') }}
        </responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

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
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.grossPay="{ item }">{{ formatCurrency(item.grossPay) }}</template>
      <template #item.netPay="{ item }">{{ formatCurrency(item.netPay) }}</template>
      <template #item.totalCost="{ item }">{{ formatCurrency(item.totalCost) }}</template>
      <template #item.actions="{ item }">
        <v-btn v-if="item.status === 'Draft'" icon="mdi-calculator" size="small" variant="text" color="info" @click="calculate(item._id)" title="Calculate" />
        <v-btn v-if="item.status === 'Calculated'" icon="mdi-check-circle" size="small" variant="text" color="success" @click="approve(item._id)" title="Approve" />
        <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'payroll.runs.edit', params: { id: item._id } }" />
        <v-btn icon="mdi-chevron-down" size="small" variant="text" @click="toggleExpand(item._id)" />
      </template>
      <template #expanded-row="{ columns, item }">
        <tr>
          <td :colspan="columns.length">
            <v-table density="compact" class="ma-2">
              <thead>
                <tr>
                  <th>{{ $t('payroll.employee') }}</th>
                  <th class="text-end">{{ $t('payroll.grossPay') }}</th>
                  <th class="text-end">{{ $t('payroll.deductions') }}</th>
                  <th class="text-end">{{ $t('payroll.netPay') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="emp in item.employees" :key="emp._id">
                  <td>{{ emp.name }}</td>
                  <td class="text-end">{{ formatCurrency(emp.grossPay) }}</td>
                  <td class="text-end">{{ formatCurrency(emp.deductions) }}</td>
                  <td class="text-end">{{ formatCurrency(emp.netPay) }}</td>
                </tr>
                <tr v-if="!item.employees?.length">
                  <td colspan="4" class="text-center text-grey">{{ $t('common.noData') }}</td>
                </tr>
              </tbody>
            </v-table>
          </td>
        </tr>
      </template>
    </v-data-table-server>

  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import { useAppStore } from '../../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { t } = useI18n()
const store = usePayrollStore()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const statusFilter = ref<string | null>(null)
const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (statusFilter.value) f.status = statusFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/payroll/run`),
  entityKey: 'payrollRuns',
  filters,
})

const expanded = ref<string[]>([])

const headers = [
  { title: t('common.name'), key: 'name' },
  { title: t('payroll.period'), key: 'period' },
  { title: t('common.status'), key: 'status' },
  { title: t('payroll.employeeCount'), key: 'employeeCount', align: 'end' as const },
  { title: t('payroll.grossPay'), key: 'grossPay', align: 'end' as const },
  { title: t('payroll.netPay'), key: 'netPay', align: 'end' as const },
  { title: t('payroll.totalCost'), key: 'totalCost', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

async function calculate(id: string) {
  try {
    await store.calculatePayroll(id)
    await fetchItems()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function approve(id: string) {
  try {
    await store.approvePayroll(id)
    await fetchItems()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function toggleExpand(id: string) {
  const idx = expanded.value.indexOf(id)
  if (idx >= 0) expanded.value.splice(idx, 1)
  else expanded.value.push(id)
}

function statusColor(status: string) {
  const colors: Record<string, string> = { Draft: 'grey', Calculated: 'info', Approved: 'success', Paid: 'primary' }
  return colors[status] || 'grey'
}

function handleExport(format: string) { /* TODO */ }

onMounted(() => fetchItems())
</script>
