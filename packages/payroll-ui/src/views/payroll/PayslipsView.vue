<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('payroll.payslips') }}</h1>
      <v-spacer />
      <PayrollExportMenu cap="payroll-people.view" :loading="exporting" @export="exportList" />
    </div>

    <v-row class="mb-4">
      <v-col cols="12" sm="4">
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
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
      <template #item.grossPay="{ item }">{{ formatCurrency(item.grossPay) }}</template>
      <template #item.deductions="{ item }">{{ formatCurrency(item.deductions) }}</template>
      <template #item.netPay="{ item }">{{ formatCurrency(item.netPay) }}</template>
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.actions="{ item }">
        <v-btn :aria-label="$t('common.view')" :title="$t('common.view')" icon="mdi-eye" size="small" variant="text" @click="viewDetail(item)" />
        <!-- #830: the payslip's PDF; a sealed one asks why and is recorded (PayslipPdfButton). -->
        <PayslipPdfButton :payslip="item" />
      </template>
    </v-data-table-server>

    <v-dialog v-model="detailDialog" max-width="700">
      <v-card v-if="selectedPayslip">
        <v-card-title>{{ $t('payroll.payslipDetail') }} - {{ selectedPayslip.employeeName }}</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="6">
              <div class="text-subtitle-2 mb-2">{{ $t('payroll.period') }}: {{ selectedPayslip.period }}</div>
            </v-col>
            <v-col cols="6" class="text-end">
              <v-chip :color="statusColor(selectedPayslip.status)" size="small">{{ selectedPayslip.status }}</v-chip>
            </v-col>
          </v-row>

          <v-divider class="my-3" />
          <div class="text-subtitle-1 font-weight-bold mb-2">{{ $t('payroll.earnings') }}</div>
          <v-table density="compact">
            <tbody>
              <tr v-for="earning in selectedPayslip.earnings" :key="earning.name">
                <td>{{ earning.name }}</td>
                <td class="text-end">{{ formatCurrency(earning.amount) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('payroll.grossPay') }}</td>
                <td class="text-end">{{ formatCurrency(selectedPayslip.grossPay) }}</td>
              </tr>
            </tbody>
          </v-table>
          <!-- FR-32.12 (D-5): a payslip of the generic run says what it does not compute. -->
          <div v-if="selectedPayslip.engine !== 'bg'" class="text-caption text-medium-emphasis mt-1" data-testid="legacy-not-computed">
            {{ $t('payroll.legacyNotComputed') }}
          </div>

          <v-divider class="my-3" />
          <div class="text-subtitle-1 font-weight-bold mb-2">{{ $t('payroll.deductions') }}</div>
          <v-table density="compact">
            <tbody>
              <tr v-for="ded in selectedPayslip.deductionItems" :key="ded.name">
                <td>{{ ded.name }}</td>
                <td class="text-end">-{{ formatCurrency(ded.amount) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('payroll.totalDeductions') }}</td>
                <td class="text-end">-{{ formatCurrency(selectedPayslip.deductions) }}</td>
              </tr>
            </tbody>
          </v-table>

          <v-divider class="my-3" />
          <div class="d-flex justify-space-between text-h6">
            <span>{{ $t('payroll.netPay') }}</span>
            <span class="text-primary">{{ formatCurrency(selectedPayslip.netPay) }}</span>
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <PayslipPdfButton :payslip="selectedPayslip" wide />
          <v-btn @click="detailDialog = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import EntityLink from 'ui-shared/components/EntityLink'
import PayrollExportMenu from '../../components/PayrollExportMenu.vue'
import PayslipPdfButton from '../../components/PayslipPdfButton.vue'
import { usePayrollExport } from '../../composables/usePayrollExport'

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const { search, debouncedSearch } = useSearchDebounce()

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  return f
})

// FR-31.18: the list's place (search, page, size, sort) in the address; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/payroll/payslip`),
  entityKey: 'payslips',
  filters,
  urlSync: true,
})

// #830: the list as Excel or PDF, on these filters: whose payslip, which month, its status. No amount, sealed or not.
const { exporting, exportList } = usePayrollExport('payslip', {
  filters,
  pagination,
  labels: () => ({
    title: t('payroll.payslips'),
    columns: {
      employee: t('payroll.employee'),
      employeeNumber: t('payroll.employeeNumber'),
      periodFrom: t('payroll.periodStart'),
      periodTo: t('payroll.periodEnd'),
      status: t('common.status'),
      paymentMethod: t('payroll.paymentMethod'),
    },
    filters: { search: t('common.search'), status: t('common.status') },
  }),
})

const detailDialog = ref(false)
const selectedPayslip = ref<any>(null)

const headers = [
  { title: t('payroll.employee'), key: 'employeeName' },
  { title: t('payroll.period'), key: 'period' },
  { title: t('payroll.grossPay'), key: 'grossPay', align: 'end' as const },
  { title: t('payroll.deductions'), key: 'deductions', align: 'end' as const },
  { title: t('payroll.netPay'), key: 'netPay', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]

function viewDetail(item: any) {
  selectedPayslip.value = item
  detailDialog.value = true
}

function statusColor(status: string) {
  const colors: Record<string, string> = { Generated: 'info', Sent: 'success', Paid: 'primary' }
  return colors[status] || 'grey'
}


onMounted(() => fetchItems())
</script>
