<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.proformaInvoices') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="['draft', 'sent', 'accepted', 'converted', 'expired']" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="loading" item-value="_id" hover>
          <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
          <template #item.validUntil="{ item }">{{ item.validUntil?.split('T')[0] }}</template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn v-if="item.status !== 'converted'" icon="mdi-swap-horizontal" size="small" variant="text" color="success" :title="$t('invoicing.convertToInvoice')" @click="convert(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="900" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.proformaInvoices') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="4">
                <v-autocomplete v-model="form.contactId" :label="$t('invoicing.contact')" :items="contacts" item-title="companyName" item-value="_id" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model="form.validUntil" :label="$t('invoicing.validUntil')" type="date" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="4">
                <v-select v-model="form.currency" :label="$t('common.currency')" :items="['EUR','USD','GBP','CHF','MKD','BGN','RSD']" />
              </v-col>
              <v-col cols="12" md="4">
                <v-text-field v-model.number="form.exchangeRate" :label="$t('invoicing.exchangeRate')" type="number" step="0.0001" />
              </v-col>
            </v-row>

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
                  <th class="text-end" style="width:80px">{{ $t('invoicing.discount') }}</th>
                  <th class="text-end" style="width:80px">{{ $t('invoicing.taxRate') }}</th>
                  <th class="text-end" style="width:110px">{{ $t('common.total') }}</th>
                  <th style="width:40px"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, idx) in form.lines" :key="idx">
                  <td style="min-width:200px">
                    <ProductLineDescription
                      :description="line.description"
                      :product-id="line.productId"
                      price-field="sellingPrice"
                      @update:description="line.description = $event"
                      @update:product-id="line.productId = $event"
                      @product-selected="onProductSelected(idx, $event)"
                      @product-cleared="onProductCleared(idx)"
                    />
                  </td>
                  <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="line.unitPrice" type="number" step="0.01" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="line.discount" type="number" suffix="%" density="compact" hide-details variant="underlined" /></td>
                  <td><v-text-field v-model.number="line.taxRate" type="number" suffix="%" density="compact" hide-details variant="underlined" /></td>
                  <td class="text-end">{{ fmtCurrency(calcLineTotal(line), form.currency) }}</td>
                  <td><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5" class="text-end text-subtitle-2">{{ $t('common.total') }}</td>
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
import ExportMenu from 'ui-shared/components/ExportMenu'
import ProductLineDescription from '../../components/ProductLineDescription.vue'

interface Item { _id: string; number: string; contactName: string; contactId?: string; issueDate: string; validUntil: string; status: string; total: number; currency: string; exchangeRate?: number; notes?: string; lines?: any[] }
interface Contact { _id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const loading = ref(false)
const items = ref<Item[]>([])
const contacts = ref<Contact[]>([])
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const statusFilter = ref<string | null>(null)

const emptyLine = () => ({ description: '', quantity: 1, unitPrice: 0, discount: 0, taxRate: 0, productId: undefined as string | undefined })
const form = ref({
  contactId: '', issueDate: new Date().toISOString().split('T')[0], validUntil: '',
  currency: baseCurrency.value, exchangeRate: 1, notes: '', lines: [emptyLine()] as any[],
})

const rules = { required: (v: string) => !!v || t('validation.required') }

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.validUntil'), key: 'validUntil', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const filteredItems = computed(() => {
  let r = items.value
  if (statusFilter.value) r = r.filter(i => i.status === statusFilter.value)
  return r
})

function fmtCurrency(amount: number, currency?: string) { return formatCurrency(amount, currency || baseCurrency.value, localeCode.value) }
function statusColor(s: string) { return ({ draft: 'grey', sent: 'info', accepted: 'primary', converted: 'success', expired: 'error' }[s] || 'grey') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function calcLineTotal(l: any) { const sub = l.quantity * l.unitPrice; return (sub - sub * l.discount / 100) * (1 + l.taxRate / 100) }
const computedTotal = computed(() => form.value.lines.reduce((s: number, l: any) => s + calcLineTotal(l), 0))
function addLine() { form.value.lines.push(emptyLine()) }

function openCreate() {
  editing.value = false
  form.value = { contactId: '', issueDate: new Date().toISOString().split('T')[0], validUntil: '', currency: baseCurrency.value, exchangeRate: 1, notes: '', lines: [emptyLine()] }
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = { contactId: item.contactId || '', issueDate: item.issueDate?.split('T')[0] || '', validUntil: item.validUntil?.split('T')[0] || '', currency: item.currency || baseCurrency.value, exchangeRate: item.exchangeRate || 1, notes: item.notes || '', lines: item.lines || [emptyLine()] }
  dialog.value = true
}

function onProductSelected(idx: number, product: any) {
  const line = form.value.lines[idx]
  if (!line) return
  line.unitPrice = product.sellingPrice ?? 0
  line.discount = 0
  line.taxRate = product.taxRate ?? line.taxRate
}

function onProductCleared(idx: number) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = undefined
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    const payload = { ...form.value, total: computedTotal.value, type: 'proforma' }
    if (editing.value) await httpClient.put(`${orgUrl()}/invoices/${selectedId.value}`, payload)
    else await httpClient.post(`${orgUrl()}/invoices`, payload)
    await fetchItems(); dialog.value = false
  } finally { loading.value = false }
}

async function convert(item: Item) {
  loading.value = true
  try { await httpClient.post(`${orgUrl()}/invoices/${item._id}/convert`); await fetchItems() }
  finally { loading.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() { await httpClient.delete(`${orgUrl()}/invoices/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }
function onExport(format: string) { console.log('Export proforma invoices as', format) }

async function fetchItems() {
  loading.value = true
  try { const { data } = await httpClient.get(`${orgUrl()}/invoices`, { params: { type: 'proforma' } }); items.value = data.invoices || [] }
  finally { loading.value = false }
}

async function fetchContacts() {
  try { const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`); contacts.value = data.contacts || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchContacts() })
</script>
