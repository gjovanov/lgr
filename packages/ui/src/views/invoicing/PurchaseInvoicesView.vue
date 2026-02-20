<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.purchaseInvoices') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="statusOptions" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateFrom" :label="$t('invoicing.dateFrom')" type="date" hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateTo" :label="$t('invoicing.dateTo')" type="date" hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Data Table -->
    <v-card>
      <v-card-text>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="loading" item-value="_id" hover>
          <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
          <template #item.dueDate="{ item }">{{ item.dueDate?.split('T')[0] }}</template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn
              v-if="item.status === 'draft' || item.status === 'received'"
              icon="mdi-cash"
              size="small"
              variant="text"
              color="success"
              :title="$t('invoicing.recordPayment')"
              @click="openPaymentDialog(item)"
            />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="900" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.purchaseInvoices') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.supplierInvoiceNumber" :label="$t('invoicing.supplierInvoiceNumber')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-autocomplete v-model="form.contactId" :label="$t('invoicing.supplier')" :items="suppliers" item-title="companyName" item-value="_id" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-select v-model="form.currency" :label="$t('common.currency')" :items="['EUR','USD','GBP','CHF','MKD','BGN','RSD']" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.dueDate" :label="$t('invoicing.dueDate')" type="date" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model.number="form.exchangeRate" :label="$t('invoicing.exchangeRate')" type="number" step="0.0001" />
              </v-col>
            </v-row>

            <!-- Line Items -->
            <div class="d-flex align-center mt-4 mb-2">
              <span class="text-subtitle-2">{{ $t('invoicing.lineItems') }}</span>
              <v-spacer />
              <v-btn variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">{{ $t('invoicing.addLine') }}</v-btn>
            </div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ $t('common.description') }}</th>
                  <th class="text-end" style="width:80px">{{ $t('invoicing.qty') }}</th>
                  <th class="text-end" style="width:110px">{{ $t('invoicing.unitPrice') }}</th>
                  <th class="text-end" style="width:80px">{{ $t('invoicing.taxRate') }}</th>
                  <th class="text-end" style="width:110px">{{ $t('common.total') }}</th>
                  <th style="width:40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td><v-text-field v-model="line.description" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="line.unitPrice" type="number" step="0.01" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="line.taxRate" type="number" suffix="%" density="compact" hide-details variant="underlined" /></td>
                  <td class="text-end">{{ fmtCurrency(line.quantity * line.unitPrice * (1 + line.taxRate / 100), form.currency) }}</td>
                  <td><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="4" class="text-end text-subtitle-2">{{ $t('common.total') }}</td>
                  <td class="text-end text-subtitle-2">{{ fmtCurrency(computedTotal, form.currency) }}</td>
                  <td></td>
                </tr>
              </tfoot>
            </v-table>

            <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Payment Dialog -->
    <v-dialog v-model="paymentDialog" max-width="500">
      <v-card>
        <v-card-title>{{ $t('invoicing.recordPayment') }}</v-card-title>
        <v-card-text>
          <v-form ref="paymentFormRef">
            <v-text-field v-model.number="paymentForm.amount" :label="$t('common.amount')" type="number" :rules="[rules.required]" />
            <v-select v-model="paymentForm.method" :label="$t('invoicing.paymentMethod')" :items="['bank_transfer','cash','card','check']" />
            <v-text-field v-model="paymentForm.date" :label="$t('common.date')" type="date" :rules="[rules.required]" />
            <v-text-field v-model="paymentForm.reference" :label="$t('invoicing.reference')" />
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
import { httpClient } from '../../composables/useHttpClient'
import { useCurrency } from '../../composables/useCurrency'
import ExportMenu from '../../components/shared/ExportMenu.vue'

interface Invoice { _id: string; number: string; supplierInvoiceNumber?: string; contactName: string; contactId?: string; issueDate: string; dueDate: string; status: string; total: number; currency: string; exchangeRate?: number; notes?: string; lines?: any[] }
interface Contact { _id: string; name: string; type: string }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const loading = ref(false)
const items = ref<Invoice[]>([])
const suppliers = ref<Contact[]>([])
const dialog = ref(false)
const deleteDialog = ref(false)
const paymentDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const paymentFormRef = ref()
const selectedId = ref('')
const statusFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')

const statusOptions = ['draft', 'received', 'partially_paid', 'paid', 'overdue', 'cancelled']

const emptyLine = () => ({ description: '', quantity: 1, unitPrice: 0, taxRate: 0 })
const form = ref({
  supplierInvoiceNumber: '',
  contactId: '',
  issueDate: new Date().toISOString().split('T')[0],
  dueDate: '',
  currency: baseCurrency.value,
  exchangeRate: 1,
  notes: '',
  lines: [emptyLine()] as any[],
})
const paymentForm = ref({ amount: 0, method: 'bank_transfer', date: new Date().toISOString().split('T')[0], reference: '' })

const computedTotal = computed(() => form.value.lines.reduce((s: number, l: any) => s + l.quantity * l.unitPrice * (1 + l.taxRate / 100), 0))

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.supplierInvoiceNumber'), key: 'supplierInvoiceNumber' },
  { title: t('invoicing.supplier'), key: 'contactName', sortable: true },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.dueDate'), key: 'dueDate', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const filteredItems = computed(() => {
  let r = items.value
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  if (dateFrom.value) r = r.filter(i => i.issueDate >= dateFrom.value)
  if (dateTo.value) r = r.filter(i => i.issueDate <= dateTo.value)
  return r
})

const rules = { required: (v: string | number) => (v !== '' && v !== null) || t('validation.required') }

function fmtCurrency(amount: number, currency?: string) {
  return formatCurrency(amount, currency || baseCurrency.value, localeCode.value)
}

function statusColor(s: string) {
  return ({ draft: 'grey', received: 'info', partially_paid: 'warning', paid: 'success', overdue: 'error', cancelled: 'grey-darken-1' }[s] || 'grey')
}

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function addLine() { form.value.lines.push(emptyLine()) }

function openCreate() {
  editing.value = false
  form.value = { supplierInvoiceNumber: '', contactId: '', issueDate: new Date().toISOString().split('T')[0], dueDate: '', currency: baseCurrency.value, exchangeRate: 1, notes: '', lines: [emptyLine()] }
  dialog.value = true
}

function openEdit(item: Invoice) {
  editing.value = true
  selectedId.value = item._id
  form.value = {
    supplierInvoiceNumber: item.supplierInvoiceNumber || '',
    contactId: item.contactId || '',
    issueDate: item.issueDate?.split('T')[0] || '',
    dueDate: item.dueDate?.split('T')[0] || '',
    currency: item.currency || baseCurrency.value,
    exchangeRate: item.exchangeRate || 1,
    notes: item.notes || '',
    lines: item.lines || [emptyLine()],
  }
  dialog.value = true
}

function openPaymentDialog(item: Invoice) {
  selectedId.value = item._id
  paymentForm.value = { amount: item.total, method: 'bank_transfer', date: new Date().toISOString().split('T')[0], reference: '' }
  paymentDialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    const payload = { ...form.value, total: computedTotal.value, direction: 'incoming', type: 'invoice' }
    if (editing.value) await httpClient.put(`${orgUrl()}/invoices/${selectedId.value}`, payload)
    else await httpClient.post(`${orgUrl()}/invoices`, payload)
    await fetchItems()
    dialog.value = false
  } finally { loading.value = false }
}

async function recordPayment() {
  const { valid } = await paymentFormRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoices/${selectedId.value}/payments`, paymentForm.value)
    paymentDialog.value = false
    await fetchItems()
  } finally { loading.value = false }
}

function confirmDelete(item: Invoice) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await httpClient.delete(`${orgUrl()}/invoices/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }
function onExport(format: string) { console.log('Export purchase invoices as', format) }

async function fetchItems() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoices`, { params: { direction: 'incoming', type: 'invoice' } })
    items.value = data.invoices || []
  } finally { loading.value = false }
}

async function fetchSuppliers() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params: { type: 'supplier' } })
    suppliers.value = data.contacts || []
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchSuppliers() })
</script>
