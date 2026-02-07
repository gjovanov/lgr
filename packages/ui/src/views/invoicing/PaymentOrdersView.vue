<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.paymentOrders') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-0">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="['draft', 'pending', 'executed', 'failed']" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="loading" :no-data-text="$t('common.noData')" item-value="_id" hover>
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label :color="item.type === 'outgoing' ? 'warning' : 'success'">{{ item.type }}</v-chip>
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.amount="{ item }">{{ fmtCurrency(item.amount) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.status === 'draft'" icon="mdi-send" size="small" variant="text" color="primary" :title="$t('invoicing.execute')" @click="execute(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.paymentOrders') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="6">
                <v-autocomplete v-model="form.contactId" :label="$t('invoicing.contact')" :items="contacts" item-title="name" item-value="_id" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-select v-model="form.type" :label="$t('common.type')" :items="['outgoing', 'incoming']" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.bankAccount" :label="$t('invoicing.bankAccount')" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-text-field v-model.number="form.amount" :label="$t('common.amount')" type="number" step="0.01" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field v-model="form.reference" :label="$t('invoicing.reference')" />
              </v-col>
            </v-row>

            <!-- Select invoices to pay -->
            <div class="mt-4 mb-2">
              <span class="text-subtitle-2">{{ $t('invoicing.invoicesToPay') }}</span>
            </div>
            <v-data-table
              v-model="form.selectedInvoiceIds"
              :headers="invoiceHeaders"
              :items="unpaidInvoices"
              item-value="_id"
              show-select
              density="compact"
              :items-per-page="5"
            >
              <template #item.total="{ item }">{{ fmtCurrency(item.total) }}</template>
            </v-data-table>

            <v-textarea v-model="form.description" :label="$t('common.description')" rows="2" class="mt-4" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="save">{{ $t('common.save') }}</v-btn>
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

interface Item { _id: string; number: string; type: string; contactName: string; contactId?: string; bankAccount: string; date: string; amount: number; status: string; reference?: string; description?: string }
interface Contact { _id: string; name: string }
interface Invoice { _id: string; number: string; contactName: string; total: number; status: string }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const loading = ref(false)
const items = ref<Item[]>([])
const contacts = ref<Contact[]>([])
const unpaidInvoices = ref<Invoice[]>([])
const dialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const statusFilter = ref<string | null>(null)

const form = ref({
  contactId: '', type: 'outgoing', bankAccount: '', date: new Date().toISOString().split('T')[0],
  amount: 0, reference: '', description: '', selectedInvoiceIds: [] as string[],
})

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== 0) || t('validation.required') }

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.bankAccount'), key: 'bankAccount' },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('common.amount'), key: 'amount', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const invoiceHeaders = [
  { title: t('invoicing.invoiceNumber'), key: 'number' },
  { title: t('invoicing.contact'), key: 'contactName' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
]

const filteredItems = computed(() => {
  let r = items.value
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  return r
})

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function statusColor(s: string) { return ({ draft: 'grey', pending: 'warning', executed: 'success', failed: 'error' }[s] || 'grey') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function openCreate() {
  editing.value = false
  form.value = { contactId: '', type: 'outgoing', bankAccount: '', date: new Date().toISOString().split('T')[0], amount: 0, reference: '', description: '', selectedInvoiceIds: [] }
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = { contactId: item.contactId || '', type: item.type, bankAccount: item.bankAccount, date: item.date?.split('T')[0] || '', amount: item.amount, reference: item.reference || '', description: item.description || '', selectedInvoiceIds: [] }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    if (editing.value) await httpClient.put(`${orgUrl()}/payment-orders/${selectedId.value}`, form.value)
    else await httpClient.post(`${orgUrl()}/payment-orders`, form.value)
    await fetchItems(); dialog.value = false
  } finally { loading.value = false }
}

async function execute(item: Item) {
  loading.value = true
  try { await httpClient.post(`${orgUrl()}/payment-orders/${item._id}/execute`); await fetchItems() }
  finally { loading.value = false }
}

function onExport(format: string) { console.log('Export payment orders as', format) }

async function fetchItems() {
  loading.value = true
  try { const { data } = await httpClient.get(`${orgUrl()}/payment-orders`); items.value = data.paymentOrders || [] }
  finally { loading.value = false }
}

async function fetchContacts() {
  try { const { data } = await httpClient.get(`${orgUrl()}/contacts`); contacts.value = data.contacts || [] } catch { /* */ }
}

async function fetchUnpaidInvoices() {
  try { const { data } = await httpClient.get(`${orgUrl()}/invoices`, { params: { status: 'sent,partially_paid,overdue' } }); unpaidInvoices.value = data.invoices || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchContacts(); fetchUnpaidInvoices() })
</script>
