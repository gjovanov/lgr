<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.salesInvoices') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.sales.new' }">
          {{ $t('common.create') }}
        </responsive-btn>
      </div>
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
          <v-col cols="12" md="3">
            <TagInput v-model="tagFilter" type="invoice" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
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
          <template #item.number="{ item }">
            <entity-link :label="item.number" :to="{ name: 'invoicing.sales.edit', params: { id: item._id } }" />
          </template>
          <template #item.contactName="{ item }">
            <entity-link v-if="item.contactId" :label="item.contactName" :to="{ name: 'invoicing.contacts.edit', params: { id: item.contactId } }" />
            <span v-else>{{ item.contactName }}</span>
          </template>
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
          <template #item.proformaNumber="{ item }">
            <span v-if="item.proformaNumber">{{ item.proformaNumber }}</span>
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

    <!-- Stock Transfer Dialog -->
    <StockTransferDialog
      v-model="transferDialog"
      :shortfalls="transferShortfalls"
      :proposals="transferProposals"
      :all-resolvable="transferAllResolvable"
      :confirming="transferConfirming"
      @confirm="confirmTransferAndSend"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'
import StockTransferDialog from 'ui-shared/components/StockTransferDialog.vue'
import EntityLink from 'ui-shared/components/EntityLink'

interface Invoice {
  _id: string
  number: string
  contactName: string
  contactId?: string
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
const { showSuccess, showError } = useSnackbar()
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
const tagFilter = ref<string[]>([])
const paymentFormRef = ref()

const transferDialog = ref(false)
const transferShortfalls = ref<any[]>([])
const transferProposals = ref<any[]>([])
const transferAllResolvable = ref(false)
const transferConfirming = ref(false)
const transferInvoiceId = ref('')

const statusOptions = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided']

const filters = computed(() => {
  const f: Record<string, any> = { direction: 'outgoing' }
  if (statusFilter.value) f.status = statusFilter.value
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
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
  { title: t('invoicing.proformaRef'), key: 'proformaNumber' },
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
    // First fetch full invoice to get lines with warehouseId
    const { data: invoiceData } = await httpClient.get(`${orgUrl()}/invoices/${item._id}`)
    const invoice = invoiceData.invoice
    const lines = (invoice.lines || []).filter((l: any) => l.productId && l.warehouseId)

    if (lines.length > 0 && invoice.direction === 'outgoing') {
      // Check stock availability
      const { data: stockResult } = await httpClient.post(`${orgUrl()}/invoicing/stock-availability/check`, {
        lines: lines.map((l: any) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity })),
      })

      if (!stockResult.sufficient) {
        // Show transfer dialog
        transferShortfalls.value = stockResult.shortfalls
        transferProposals.value = stockResult.proposals
        transferAllResolvable.value = stockResult.allResolvable
        transferInvoiceId.value = item._id
        transferDialog.value = true
        loading.value = false
        return
      }
    }

    // Stock sufficient — send directly
    await httpClient.post(`${orgUrl()}/invoices/${item._id}/send`)
    showSuccess(t('invoicing.invoiceSent'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function confirmTransferAndSend(proposals: any[]) {
  transferConfirming.value = true
  try {
    // Create transfer movements
    const { data: transferResult } = await httpClient.post(`${orgUrl()}/invoicing/stock-availability/create-transfers`, { proposals })

    // Send invoice with pending transfer IDs (backend confirms transfers first)
    await httpClient.post(`${orgUrl()}/invoices/${transferInvoiceId.value}/send`, { pendingTransferIds: transferResult.transferIds })
    showSuccess(t('invoicing.invoiceSent'))
    transferDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    transferConfirming.value = false
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
    showSuccess(t('invoicing.paymentRecorded'))
    paymentDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function voidInvoice(item: Invoice) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoices/${item._id}/void`)
    showSuccess(t('invoicing.invoiceVoided'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

function confirmDelete(item: Invoice) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/invoices/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function onExport(format: string) {
  console.log('Export sales invoices as', format)
}

onMounted(() => {
  fetchItems()
})
</script>
