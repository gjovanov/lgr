<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('payroll.payrollRun') : $t('common.create') + ' ' + $t('payroll.payrollRun')"
    :subtitle="isEdit ? form.name : ''"
    :status="isEdit && runStatus ? { steps: ['Draft', 'Calculated', 'Approved', 'Paid'], current: runStatus } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/runs"
    :back-label="$t('payroll.payrollRuns')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-text-field v-model="form.name" :label="$t('common.name')" density="compact" />
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.periodStart" :label="$t('payroll.periodStart')" type="date" density="compact" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.periodEnd" :label="$t('payroll.periodEnd')" type="date" density="compact" />
        </v-col>
      </v-row>

      <!-- Employees breakdown (edit mode) -->
      <template v-if="isEdit && employees.length">
        <div class="text-subtitle-2 mt-4 mb-2">{{ $t('payroll.employees') }}</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ $t('payroll.employee') }}</th>
              <th class="text-end">{{ $t('payroll.grossPay') }}</th>
              <th class="text-end">{{ $t('payroll.deductions') }}</th>
              <th class="text-end">{{ $t('payroll.netPay') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="emp in employees" :key="emp._id">
              <td>{{ emp.name }}</td>
              <td class="text-end">{{ formatCurrency(emp.grossPay) }}</td>
              <td class="text-end">{{ formatCurrency(emp.deductions) }}</td>
              <td class="text-end">{{ formatCurrency(emp.netPay) }}</td>
            </tr>
            <tr v-if="!employees.length">
              <td colspan="4" class="text-center text-grey">{{ $t('common.noData') }}</td>
            </tr>
          </tbody>
        </v-table>
      </template>
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import { useAppStore } from '../../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const store = usePayrollStore()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const { showSuccess, showError } = useSnackbar()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const runStatus = ref('')
const employees = ref<any[]>([])

const form = ref({ _id: '', name: '', periodStart: '', periodEnd: '' })

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'payroll',
  entityType: 'payrollRun',
  icon: 'mdi-calculator',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Name', value: form.value.name || '' },
    { label: 'Period', value: form.value.periodStart || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = [
    { label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value },
  ]
  if (isEdit.value && runStatus.value === 'Draft') {
    actions.push({ label: t('payroll.calculate'), color: 'info', icon: 'mdi-calculator', handler: calculate })
  }
  if (isEdit.value && runStatus.value === 'Calculated') {
    actions.push({ label: t('payroll.approve'), color: 'success', icon: 'mdi-check-circle', handler: approve })
  }
  return actions
})

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/payroll/run/${route.params.id}`)
    const item = data.payrollRun || data
    form.value = { _id: item._id, name: item.name || '', periodStart: item.periodStart || '', periodEnd: item.periodEnd || '' }
    runStatus.value = item.status || ''
    employees.value = item.employees || []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  saving.value = true
  try {
    const payload = { name: form.value.name, periodStart: form.value.periodStart, periodEnd: form.value.periodEnd }
    if (isEdit.value) {
      await httpClient.put(`${appStore.orgUrl()}/payroll/run/${route.params.id}`, payload)
    } else {
      const { data } = await httpClient.post(`${appStore.orgUrl()}/payroll/run`, payload)
      const newId = data.payrollRun?._id || data._id
      if (newId) {
        markSaved()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'payroll.runs.edit', params: { id: newId } })
        return
      }
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function calculate() {
  try {
    await store.calculatePayroll(route.params.id as string)
    await fetchItem()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function approve() {
  try {
    await store.approvePayroll(route.params.id as string)
    await fetchItem()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(async () => {
  if (tryRestore()) return
  fetchItem()
})
</script>
