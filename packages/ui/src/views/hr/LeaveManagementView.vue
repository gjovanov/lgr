<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-4">
      <h1 class="text-h4">{{ t('hr.leaveManagement') }}</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('hr.requestLeave') }}</v-btn>
    </div>
    <v-tabs v-model="activeTab" class="mb-4">
      <v-tab value="requests">{{ t('hr.leaveRequests') }}</v-tab>
      <v-tab value="balances">{{ t('hr.leaveBalances') }}</v-tab>
    </v-tabs>
    <v-card>
      <v-card-text>
        <template v-if="activeTab === 'requests'">
          <v-data-table-server
            :headers="requestHeaders"
            :items="items"
            :items-length="pagination.total"
            :loading="loading"
            :page="pagination.page + 1"
            :items-per-page="pagination.size"
            @update:options="onUpdateOptions"
            item-value="_id"
            hover
          >
            <template #item.status="{ item }"><v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip></template>
            <template #item.actions="{ item }">
              <v-btn v-if="item.status === 'pending'" icon="mdi-check" size="small" variant="text" color="success" @click="approveReq(item)" />
              <v-btn v-if="item.status === 'pending'" icon="mdi-close" size="small" variant="text" color="error" @click="rejectReq(item)" />
            </template>
          </v-data-table-server>
        </template>
        <template v-else>
          <v-data-table :headers="balanceHeaders" :items="balances" :loading="balancesLoading" item-value="_id" />
        </template>
      </v-card-text>
    </v-card>
    <v-dialog v-model="dialog" max-width="600">
      <v-card>
        <v-card-title>{{ t('hr.requestLeave') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-text-field v-model="form.employeeName" :label="t('payroll.employee')" :rules="[rules.required]" />
            <v-select v-model="form.leaveType" :label="t('hr.leaveType')" :items="['annual', 'sick', 'personal', 'maternity', 'paternity', 'unpaid']" :rules="[rules.required]" />
            <v-text-field v-model="form.startDate" :label="t('common.dateFrom')" type="date" :rules="[rules.required]" />
            <v-text-field v-model="form.endDate" :label="t('common.dateTo')" type="date" :rules="[rules.required]" />
            <v-textarea v-model="form.reason" :label="t('invoicing.reason')" rows="2" />
          </v-form>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn><v-btn color="primary" :loading="loading" @click="save">{{ t('common.save') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from '../../composables/useHttpClient'
import { useSnackbar } from '../../composables/useSnackbar'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'

interface LeaveBalance { _id: string; employeeName: string; leaveType: string; entitled: number; used: number; remaining: number }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const activeTab = ref('requests')
const balances = ref<LeaveBalance[]>([])
const balancesLoading = ref(false)
const dialog = ref(false)
const formRef = ref()
const form = ref({ employeeName: '', leaveType: 'annual', startDate: '', endDate: '', reason: '' })

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/hr/leave-request`),
  entityKey: 'leaveRequests',
})

const requestHeaders = [
  { title: t('payroll.employee'), key: 'employeeName' }, { title: t('hr.leaveType'), key: 'leaveType' },
  { title: t('common.dateFrom'), key: 'startDate' }, { title: t('common.dateTo'), key: 'endDate' },
  { title: t('hr.days'), key: 'days', align: 'end' as const }, { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
]
const balanceHeaders = [
  { title: t('payroll.employee'), key: 'employeeName' }, { title: t('hr.leaveType'), key: 'leaveType' },
  { title: t('hr.entitled'), key: 'entitled', align: 'end' as const }, { title: t('hr.used'), key: 'used', align: 'end' as const },
  { title: t('hr.remaining'), key: 'remaining', align: 'end' as const },
]

function statusColor(s: string) { return ({ pending: 'warning', approved: 'success', rejected: 'error' }[s] || 'grey') }
const rules = { required: (v: string) => !!v || t('validation.required') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreate() { form.value = { employeeName: '', leaveType: 'annual', startDate: '', endDate: '', reason: '' }; dialog.value = true }
async function save() { const { valid } = await formRef.value.validate(); if (!valid) return; try { await httpClient.post(`${orgUrl()}/hr/leave-request`, form.value); showSuccess(t('common.savedSuccessfully')); await fetchItems(); dialog.value = false } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } }
async function approveReq(item: any) { try { await httpClient.post(`${orgUrl()}/hr/leave-request/${item._id}/approve`); showSuccess(t('common.savedSuccessfully')); await fetchItems() } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } }
async function rejectReq(item: any) { try { await httpClient.post(`${orgUrl()}/hr/leave-request/${item._id}/reject`); showSuccess(t('common.savedSuccessfully')); await fetchItems() } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } }

async function fetchBalances() {
  balancesLoading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/hr/leave-balance`)
    balances.value = data.leaveBalances || []
  } finally { balancesLoading.value = false }
}

onMounted(() => { fetchItems(); fetchBalances() })
</script>
