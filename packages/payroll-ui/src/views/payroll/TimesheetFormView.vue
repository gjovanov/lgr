<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('payroll.timesheetEntry') : $t('common.create') + ' ' + $t('payroll.timesheetEntry')"
    :subtitle="isEdit ? (form.date || '') : ''"
    :actions="formActions"
    :loading="loading"
    back-to="/timesheets"
    :back-label="$t('payroll.timesheets')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-select v-model="form.employeeId" :label="$t('payroll.employee')" :items="employees" item-title="name" item-value="_id" density="compact" class="mb-2" />
      <v-text-field v-model="form.date" :label="$t('common.date')" type="date" density="compact" class="mb-2" />
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field v-model.number="form.hoursWorked" :label="$t('payroll.hoursWorked')" type="number" step="0.5" min="0" max="24" density="compact" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model.number="form.overtime" :label="$t('payroll.overtime')" type="number" step="0.5" min="0" max="24" density="compact" />
        </v-col>
      </v-row>
      <v-select v-model="form.type" :label="$t('common.type')" :items="['Regular', 'Overtime', 'Holiday', 'Sick Leave', 'Vacation']" density="compact" class="mb-2" />
      <v-select v-model="form.status" :label="$t('common.status')" :items="['Draft', 'Submitted', 'Approved', 'Rejected']" density="compact" />
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
const { showSuccess, showError } = useSnackbar()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const employees = ref<any[]>([])

const emptyForm = () => ({
  _id: '', employeeId: '', date: '', hoursWorked: 8, overtime: 0, type: 'Regular', status: 'Draft',
})
const form = ref(emptyForm())

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'payroll',
  entityType: 'timesheet',
  icon: 'mdi-clock-outline',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Date', value: form.value.date || '' },
    { label: 'Hours', value: String(form.value.hoursWorked || 0) },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value },
])

async function fetchEmployees() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/payroll/employee`)
    employees.value = (data.employees || []).map((e: any) => ({ ...e, name: `${e.firstName} ${e.lastName}` }))
  } catch { /* */ }
}

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/payroll/timesheet/${route.params.id}`)
    const item = data.timesheet || data
    form.value = {
      _id: item._id,
      employeeId: item.employeeId || '',
      date: item.date?.split?.('T')?.[0] || item.date || '',
      hoursWorked: item.hoursWorked ?? 8,
      overtime: item.overtime ?? 0,
      type: item.type || 'Regular',
      status: item.status || 'Draft',
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  saving.value = true
  try {
    const payload = { ...form.value }
    if (isEdit.value) {
      await store.updateTimesheet(route.params.id as string, payload)
    } else {
      const result = await store.createTimesheet(payload)
      const newId = result?._id
      if (newId) {
        markSaved()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'payroll.timesheets.edit', params: { id: newId } })
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

onMounted(async () => {
  await fetchEmployees()
  if (tryRestore()) return
  fetchItem()
})
</script>
