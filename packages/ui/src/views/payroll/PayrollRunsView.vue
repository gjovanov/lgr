<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">{{ $t('payroll.payrollRuns') }}</h1>
      <v-spacer />
      <ExportMenu class="mr-2" @export="handleExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openDialog()">
        {{ $t('common.create') }}
      </v-btn>
    </div>

    <DataTable :headers="headers" :items="store.payrollRuns" :loading="store.loading">
      <template #item.status="{ item }">
        <v-chip :color="statusColor(item.status)" size="small">{{ item.status }}</v-chip>
      </template>
      <template #item.grossPay="{ item }">{{ formatCurrency(item.grossPay) }}</template>
      <template #item.netPay="{ item }">{{ formatCurrency(item.netPay) }}</template>
      <template #item.totalCost="{ item }">{{ formatCurrency(item.totalCost) }}</template>
      <template #item.actions="{ item }">
        <v-btn v-if="item.status === 'Draft'" icon="mdi-calculator" size="small" variant="text" color="info" @click="calculate(item._id)" title="Calculate" />
        <v-btn v-if="item.status === 'Calculated'" icon="mdi-check-circle" size="small" variant="text" color="success" @click="approve(item._id)" title="Approve" />
        <v-btn icon="mdi-pencil" size="small" variant="text" @click="openDialog(item)" />
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
    </DataTable>

    <v-dialog v-model="dialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('payroll.payrollRun') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="form.name" :label="$t('common.name')" class="mb-2" />
          <v-row>
            <v-col cols="6"><v-text-field v-model="form.periodStart" :label="$t('payroll.periodStart')" type="date" /></v-col>
            <v-col cols="6"><v-text-field v-model="form.periodEnd" :label="$t('payroll.periodEnd')" type="date" /></v-col>
          </v-row>
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
import { useCurrency } from '../../composables/useCurrency'
import DataTable from '../../components/shared/DataTable.vue'
import ExportMenu from '../../components/shared/ExportMenu.vue'
import { useSnackbar } from '../../composables/useSnackbar'

const { t } = useI18n()
const store = usePayrollStore()
const { formatCurrency } = useCurrency()
const { showSuccess, showError } = useSnackbar()

const dialog = ref(false)
const editing = ref(false)
const saving = ref(false)
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

const form = reactive({ _id: '', name: '', periodStart: '', periodEnd: '' })

function openDialog(item?: any) {
  if (item) {
    editing.value = true
    Object.assign(form, { _id: item._id, name: item.name, periodStart: item.periodStart, periodEnd: item.periodEnd })
  } else {
    editing.value = false
    Object.assign(form, { _id: '', name: '', periodStart: '', periodEnd: '' })
  }
  dialog.value = true
}

async function save() {
  saving.value = true
  try {
    await store.savePayrollRun({ ...form })
    showSuccess(t('common.savedSuccessfully'))
    dialog.value = false
    await store.fetchPayrollRuns()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function calculate(id: string) {
  try {
    await store.calculatePayroll(id)
    showSuccess(t('common.savedSuccessfully'))
    await store.fetchPayrollRuns()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function approve(id: string) {
  try {
    await store.approvePayroll(id)
    showSuccess(t('common.savedSuccessfully'))
    await store.fetchPayrollRuns()
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

onMounted(() => store.fetchPayrollRuns())
</script>
