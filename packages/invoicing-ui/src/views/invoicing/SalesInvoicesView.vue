<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.salesInvoices') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'invoicing.sales.new' }">
        {{ $t('common.create') }}
      </v-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="search"
              prepend-inner-icon="mdi-magnify"
              :label="$t('common.search')"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-select
              v-model="statusFilter"
              :label="$t('common.status')"
              :items="statusOptions"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateFrom" :label="$t('invoicing.dateFrom')" type="date" hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateTo" :label="$t('invoicing.dateTo')" type="date" hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="1" class="d-flex align-center">
            <v-btn icon="mdi-filter" variant="text" @click="fetchItems" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Data Table -->
    <v-card>
      <v-card-text>
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
          <template #item.issueDate="{ item }">
            {{ item.issueDate?.split('T')[0] }}
          </template>
          <template #item.dueDate="{ item }">
            {{ item.dueDate?.split('T')[0] }}
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">
              {{ item.status }}
            </v-chip>
          </template>
          <template #item.total="{ item }">
            {{ fmtCurrency(item.total, item.currency) }}
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'invoicing.sales.edit', params: { id: item._id } }" />
            <v-btn
              v-if="item.status === 'draft'"
              icon="mdi-send"
              size="small"
              variant="text"
              color="info"
              :title="$t('invoicing.send')"
              @click="sendInvoice(item)"
            />
            <v-btn
              v-if="item.status === 'sent' || item.status === 'partially_paid'"
              icon="mdi-cash"
              size="small"
              variant="text"
              color="success"
              :title="$t('invoicing.recordPayment')"
              @click="openPaymentDialog(item)"
            />
            <v-btn
              v-if="item.status === 'draft'"
              icon="mdi-cancel"
              size="small"
              variant="text"
              color="error"
              :title="$t('invoicing.void')"
              @click="voidInvoice(item)"
            />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Payment Dialog -->
    <v-dialog v-model="paymentDialog" max-width="500">
      <v-card>
        <v-card-title>{{ $t('invoicing.recordPayment') }}</v-card-title>
        <v-card-text>
          <v-form ref="paymentFormRef">
            <v-text-field
              v-model.number="paymentForm.amount"
              :label="$t('common.amount')"
              type="number"
              :rules="[rules.required]"
            />
            <v-select
              v-model="paymentForm.method"
              :label="$t('invoicing.paymentMethod')"
              :items="['bank_transfer', 'cash', 'card', 'check']"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="paymentForm.date"
              :label="$t('common.date')"
              type="date"
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="paymentForm.reference"
              :label="$t('invoicing.reference')"
            />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="paymentDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="recordPayment">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteInvoiceConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'

interface Invoice {
  _id: string
  number: string
  contactName: string
  issueDate: string
  dueDate: string
  currency: string
  exchangeRate?: number
  total: number
  status: string
  paidAmount?: number
}

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const deleteDialog = ref(false)
const paymentDialog = ref(false)
const selectedId = ref('')
const statusFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')
const paymentFormRef = ref()

const statusOptions = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided']

const filters = computed(() => {
  const f: Record<string, any> = { direction: 'sales' }
  if (statusFilter.value) f.status = statusFilter.value
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/invoice`),
  entityKey: 'invoices',
  filters,
})

const paymentForm = ref({
  amount: 0,
  method: 'bank_transfer',
  date: new Date().toISOString().split('T')[0],
  reference: '',
})

const rules = {
  required: (v: string | number) => (v !== '' && v !== null && v !== 0) || t('validation.required'),
}

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.dueDate'), key: 'dueDate', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number, currency?: string) {
  return formatCurrency(amount, currency || baseCurrency.value, localeCode.value)
}

function statusColor(s: string) {
  const map: Record<string, string> = {
    draft: 'grey',
    sent: 'info',
    partially_paid: 'warning',
    paid: 'success',
    overdue: 'error',
    voided: 'grey-darken-1',
  }
  return map[s] || 'grey'
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

async function sendInvoice(item: Invoice) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoices/${item._id}/send`)
    await fetchItems()
  } finally {
    loading.value = false
  }
}

function openPaymentDialog(item: Invoice) {
  selectedId.value = item._id
  paymentForm.value = {
    amount: (item.total || 0) - (item.paidAmount || 0),
    method: 'bank_transfer',
    date: new Date().toISOString().split('T')[0],
    reference: '',
  }
  paymentDialog.value = true
}

async function recordPayment() {
  const { valid } = await paymentFormRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoices/${selectedId.value}/payments`, paymentForm.value)
    paymentDialog.value = false
    await fetchItems()
  } finally {
    loading.value = false
  }
}

async function voidInvoice(item: Invoice) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoices/${item._id}/void`)
    await fetchItems()
  } finally {
    loading.value = false
  }
}

function confirmDelete(item: Invoice) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  await httpClient.delete(`${orgUrl()}/invoices/${selectedId.value}`)
  await fetchItems()
  deleteDialog.value = false
}

function onExport(format: string) {
  console.log('Export sales invoices as', format)
}

onMounted(() => {
  fetchItems()
})
</script>
