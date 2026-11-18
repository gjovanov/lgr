<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('payroll.timesheetEntry') : $t('common.create') + ' ' + $t('payroll.timesheetEntry')"
    :subtitle="isEdit ? (form.date || '') : ''"
    :actions="formActions"
    :loading="loading"
    :load-error="loadError"
    :refusal="refusal"
    @retry="fetchItem"
    @dismiss-refusal="dismissRefusal"
    back-to="/timesheets"
    :back-label="$t('payroll.timesheets')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <!-- FR-31.10: searched on the server. It offered the ten newest employees and nothing else. -->
      <v-autocomplete
        v-model="form.employeeId"
        :label="$t('payroll.employee')"
        :items="employees"
        item-title="name"
        item-value="_id"
        :placeholder="$t('payroll.searchEmployee')"
        :loading="employeesLoading"
        no-filter
        density="compact"
        class="mb-2"
        data-testid="timesheet-employee"
        @update:search="onEmployeeSearch"
      />
      <v-text-field v-model="form.date" :label="$t('common.date')" type="date" density="compact" class="mb-2" />
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field v-model.number="form.hoursWorked" :label="$t('payroll.hoursWorked')" type="number" step="0.5" min="0" max="24" density="compact" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model.number="form.overtimeHours" :label="$t('payroll.overtime')" type="number" step="0.5" min="0" max="24" density="compact" />
        </v-col>
      </v-row>
      <!-- #675: the model's own values (`timesheet.model.ts`): lower case, and no draft. -->
      <v-select v-model="form.type" :label="$t('common.type')" :items="typeItems" density="compact" class="mb-2" />
      <v-select v-model="form.status" :label="$t('common.status')" :items="statusItems" density="compact" />
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePayrollStore } from '../../store/payroll.store'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useFormFeedback } from 'ui-shared/composables/useFormFeedback'
import { latestOnly } from 'ui-shared/composables/latest-only'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const store = usePayrollStore()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
// FR-31.6 / .8: a record that did not load says so; a refused action stays at the top of the form.
const { loadError, refusal, loadStarted, loadFailed, refused, succeeded, dismissRefusal } = useFormFeedback()

const isEdit = computed(() => !!route.params.id)
const TYPES = ['regular', 'overtime', 'holiday', 'sick', 'vacation'] as const
const STATUSES = ['submitted', 'approved', 'rejected'] as const
const typeItems = computed(() => TYPES.map(value => ({ value, title: t(`payroll.timesheetTypes.${value}`) })))
const statusItems = computed(() => STATUSES.map(value => ({ value, title: t(`payroll.timesheetStatuses.${value}`) })))
/** A stored value read as the model's: an edit before #675 could store `Approved` or `Sick Leave` as typed. */
function valueOf(values: readonly string[], stored: unknown, fallback: string): string {
  const v = String(stored ?? '').toLowerCase().replace(/ leave$/, '')
  return values.includes(v) ? v : fallback
}
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const employees = ref<any[]>([])

const emptyForm = () => ({
  _id: '', employeeId: '', date: '', hoursWorked: 8, overtimeHours: 0, type: 'regular', status: 'submitted',
})
const form = ref(emptyForm())

const { markSaved, markLoaded, tryRestore } = usePendingChanges({
  appId: 'payroll',
  entityType: 'timesheet',
  icon: 'mdi-clock-outline',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: t('common.date'), value: form.value.date || '' },
    { label: t('payroll.hoursWorked'), value: String(form.value.hoursWorked || 0) },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const formActions = computed<FormAction[]>(() => [
  // FR-27.7: a timesheet is a person's (`payroll-people`).
  { label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, cap: 'payroll-people.edit', loading: saving.value },
])

/**
 * The employee picker, searched on the server (FR-31.10): a page of 20 by name, the newest first, and the one the
 * timesheet names fetched by id when the page does not hold it, so it shows by name.
 */
const EMPLOYEE_PAGE = 20
const employeesLoading = ref(false)
const employeeRequest = latestOnly((signal, params: Record<string, string | number>) =>
  httpClient.get(`${appStore.orgUrl()}/payroll/employee`, { params, signal }))
const named = (e: any) => ({ ...e, _id: String(e._id || e.id), name: [e.firstName, e.lastName].filter(Boolean).join(' ') })
async function fetchEmployees(text?: string | null) {
  employeesLoading.value = true
  try {
    const params: Record<string, string | number> = { size: EMPLOYEE_PAGE }
    const q = (text ?? '').trim()
    if (q) params.search = q
    const answer = await employeeRequest(params)
    if (!answer.latest) return
    const found = (answer.value.data?.employees || []).map(named)
    const chosen = employees.value.find(e => e._id === form.value.employeeId && !found.some((f: any) => f._id === e._id))
    employees.value = chosen ? [chosen, ...found] : found
    employeesLoading.value = false
  } catch {
    // A failed or replaced search keeps what is shown.
    employeesLoading.value = false
  }
}
let employeeTimer: ReturnType<typeof setTimeout> | null = null
function onEmployeeSearch(text: string | null) {
  // Vuetify writes the chosen employee's name back into the search box: that is no query.
  const chosen = employees.value.find(e => e._id === form.value.employeeId)
  if (chosen && text === chosen.name) return
  if (employeeTimer) clearTimeout(employeeTimer)
  employeeTimer = setTimeout(() => { void fetchEmployees(text) }, 300)
}
/** The timesheet's own employee, by id, when the list does not hold it. */
async function ensureEmployee() {
  const id = form.value.employeeId
  if (!id || employees.value.some(e => e._id === id)) return
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/payroll/employee/${id}`)
    if (data?.employee && !employees.value.some(e => e._id === id)) employees.value = [named(data.employee), ...employees.value]
  } catch { /* the field shows the id, as before */ }
}
watch(() => form.value.employeeId, () => { void ensureEmployee() })

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  loadStarted()
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/payroll/timesheet/${route.params.id}`)
    const item = data.timesheet || data
    await markLoaded(() => {
      form.value = {
        _id: item._id,
        employeeId: item.employeeId || '',
        date: item.date?.split?.('T')?.[0] || item.date || '',
        hoursWorked: item.hoursWorked ?? 8,
        overtimeHours: item.overtimeHours ?? item.overtime ?? 0,
        type: valueOf(TYPES, item.type, 'regular'),
        status: valueOf(STATUSES, item.status, 'submitted'),
      }
    })
  } catch (e: any) {
    loadFailed(e)
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
        succeeded()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'payroll.timesheets.edit', params: { id: newId } })
        return
      }
    }
    markSaved()
    succeeded()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    refused(e?.response?.data?.message || t('common.operationFailed'))
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
