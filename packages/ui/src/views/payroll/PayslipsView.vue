<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('payroll.payslips') }}</h1>
      <v-spacer />
      <ExportMenu @export="handleExport" />
    </div>

    <DataTable :headers="headers" :items="store.payslips" :loading="store.loading">
      <template #item.grossPay="{ item }">{{ formatCurrency(item.grossPay) }}</template>
      <template #item.deductions="{ item }">{{ formatCurrency(item.deductions) }}</template>
      <template #item.netPay="{ item }">{{ formatCurrency(item.netPay) }}</template>
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-eye" size="small" variant="text" @click="viewDetail(item)" />
        <v-btn icon="mdi-file-pdf-box" size="small" variant="text" color="error" @click="downloadPdf(item._id)" />
      </template>
    </DataTable>

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
          <v-btn prepend-icon="mdi-file-pdf-box" color="error" variant="outlined" @click="downloadPdf(selectedPayslip._id)">
            {{ $t('payroll.downloadPdf') }}
          </v-btn>
          <v-btn @click="detailDialog = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import { useCurrency } from '../../composables/useCurrency'
import DataTable from '../../components/shared/DataTable.vue'
import ExportMenu from '../../components/shared/ExportMenu.vue'

const { t } = useI18n()
const store = usePayrollStore()
const { formatCurrency } = useCurrency()

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

function downloadPdf(id: string) {
  // TODO: API call to download PDF
}

function statusColor(status: string) {
  const colors: Record<string, string> = { Generated: 'info', Sent: 'success', Paid: 'primary' }
  return colors[status] || 'grey'
}

function handleExport(format: string) { /* TODO */ }

onMounted(() => store.fetchPayslips())
</script>
