<template>
  <ListScaffold
    :title="$t('nav.paymentOrders')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :view="viewMode"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-bank-transfer', title: $t('list.empty.paymentOrders'), description: $t('list.empty.paymentOrdersHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <ViewSwitcher v-model="viewMode" :views="['list', 'kanban']" />
      <responsive-btn color="primary" icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</responsive-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="3">
          <v-select v-model="statusFilter" :label="$t('common.status')" :items="statusOptions" item-title="title" item-value="value" clearable />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <responsive-btn color="primary" icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</responsive-btn>
    </template>

    <!-- Cell renderers -->
    <template #item.contactName="{ item }">
      <entity-link v-if="item.contactId" :label="item.contactName" :to="{ name: 'invoicing.contacts.edit', params: { id: item.contactId } }" />
      <span v-else>{{ item.contactName }}</span>
    </template>
    <template #item.date="{ item }">{{ formatDate(item.date) }}</template>
    <template #item.type="{ item }">
      <v-chip size="small" label :color="item.type === 'outgoing' ? 'warning' : 'success'">
        {{ item.type === 'outgoing' ? $t('invoicing.payment') : $t('invoicing.receipt') }}
      </v-chip>
    </template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :color-fn="statusColor" />
    </template>
    <template #item.amount="{ item }">{{ fmtCurrency(item.amount) }}</template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-pencil" size="small" variant="text" :title="$t('common.edit')" :aria-label="$t('common.edit')" @click="openEdit(item)" />
      <v-btn
        v-if="item.status === 'draft'"
        icon="mdi-send"
        size="small"
        variant="text"
        color="primary"
        :title="$t('invoicing.execute')"
        :aria-label="$t('invoicing.execute')"
        @click="execute(item)"
      />
    </template>

    <!-- Kanban view -->
    <template #view>
      <KanbanBoard :columns="kanbanColumns" :items="kanbanItems" item-key="_id" :drag-enabled="false">
        <template #card="{ item: ord }">
          <div class="d-flex flex-column ga-1">
            <div class="d-flex align-center justify-space-between">
              <span class="text-subtitle-2 font-weight-bold cursor-pointer" @click="openEdit(ord)">
                {{ ord.number }}
              </span>
              <span class="text-body-2 font-weight-medium">{{ fmtCurrency(ord.amount) }}</span>
            </div>
            <span class="text-body-2 text-medium-emphasis">{{ ord.contactName || '' }}</span>
            <div class="d-flex align-center ga-1 mt-1">
              <v-chip size="x-small" variant="tonal" :color="ord.type === 'outgoing' ? 'warning' : 'success'">
                {{ ord.type === 'outgoing' ? $t('invoicing.payment') : $t('invoicing.receipt') }}
              </v-chip>
              <v-chip size="x-small" variant="tonal">{{ formatDate(ord.date) }}</v-chip>
            </div>
          </div>
        </template>
      </KanbanBoard>
    </template>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="700" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.paymentOrders') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-row>
              <v-col cols="12" md="6">
                <v-autocomplete v-model="form.contactId" :label="$t('invoicing.contact')" :items="contacts" item-title="companyName" item-value="_id" :rules="[rules.required]" />
              </v-col>
              <v-col cols="12" md="6">
                <v-select v-model="form.type" :label="$t('common.type')" :items="typeOptions" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-row>
              <v-col cols="12" md="6">
                <v-autocomplete v-model="form.bankAccountId" :label="$t('invoicing.bankAccount')" :items="bankAccounts" :item-title="bankAccountTitle" item-value="_id" clearable />
              </v-col>
              <v-col cols="12" md="6">
                <DateField v-model="form.date" :label="$t('common.date')" :rules="[rules.required]" />
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
              v-model="form.invoiceIds"
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
  </ListScaffold>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import DateField from 'ui-shared/components/DateField.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import { useDialogPendingChanges } from 'ui-shared/composables/useDialogPendingChanges'

interface Item { _id: string; number: string; type: string; contactName: string; contactId?: string; bankAccountId?: string; bankAccountName?: string; date: string; amount: number; status: string; reference?: string; description?: string; invoiceIds?: string[] }
interface Contact { _id: string; companyName: string }
interface BankAccount { _id: string; name: string; iban?: string; accountNumber: string }
interface Invoice { _id: string; number: string; contactName: string; total: number; status: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref('list')
const contacts = ref<Contact[]>([])
const bankAccounts = ref<BankAccount[]>([])
const unpaidInvoices = ref<Invoice[]>([])
const dialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const statusFilter = ref<string | null>(null)
const statusOptions = computed(() => [
  { value: 'draft',     title: t('invoicing.status.draft') },
  { value: 'approved',  title: t('invoicing.status.approved') },
  { value: 'executed',  title: t('invoicing.status.executed') },
  { value: 'cancelled', title: t('invoicing.status.cancelled') },
])

const hasActiveFilters = computed(() => !!debouncedSearch.value || !!statusFilter.value)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (statusFilter.value) f.status = statusFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/payment-order`),
  entityKey: 'paymentOrders',
  filters,
})

const typeOptions = computed(() => [
  { title: t('invoicing.payment'), value: 'outgoing' },
  { title: t('invoicing.receipt'), value: 'incoming' },
])

const emptyForm = () => ({
  contactId: '', type: 'outgoing', bankAccountId: '', date: new Date().toISOString().split('T')[0],
  amount: 0, reference: '', description: '', invoiceIds: [] as string[],
})
const form = ref(emptyForm())

const { markSaved } = useDialogPendingChanges({
  appId: 'invoicing',
  entityType: 'paymentOrder',
  dialogId: 'invoicing-payment-orders',
  icon: 'mdi-bank-transfer',
  dialogVisible: dialog,
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Type', value: form.value.type },
    { label: 'Amount', value: String(form.value.amount) },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => editing.value,
  entityId: () => selectedId.value,
})

const rules = { required: (v: string | number) => (v !== '' && v !== null && v !== 0) || t('validation.required') }

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.bankAccount'), key: 'bankAccountName' },
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

const kanbanColumns = computed(() => [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'approved', title: t('invoicing.status.approved'), color: 'blue' },
  { id: 'executed', title: t('invoicing.status.executed'), color: 'green' },
])

const kanbanItems = computed(() => {
  const grouped: Record<string, any[]> = { draft: [], approved: [], executed: [] }
  for (const ord of items.value) {
    const s = ord.status
    if (s === 'draft') grouped.draft.push(ord)
    else if (s === 'approved') grouped.approved.push(ord)
    else if (s === 'executed') grouped.executed.push(ord)
  }
  return grouped
})

function bankAccountTitle(item: BankAccount) { return item.name + (item.iban ? ` (${item.iban})` : ` (${item.accountNumber})`) }
function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function formatDate(d: string) { return d ? d.split('T')[0] : '' }
function statusColor(s: string) { return ({ draft: 'grey', approved: 'info', executed: 'success', cancelled: 'error' }[s] || 'grey') }

function openCreate() {
  editing.value = false
  form.value = emptyForm()
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = {
    contactId: item.contactId || '', type: item.type, bankAccountId: item.bankAccountId || '',
    date: item.date?.split('T')[0] || '', amount: item.amount, reference: item.reference || '',
    description: item.description || '', invoiceIds: item.invoiceIds || [],
  }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    const payload = { ...form.value }
    if (!payload.bankAccountId) delete (payload as any).bankAccountId
    if (editing.value) await httpClient.put(`${appStore.orgUrl()}/invoicing/payment-order/${selectedId.value}`, payload)
    else await httpClient.post(`${appStore.orgUrl()}/invoicing/payment-order`, payload)
    showSuccess(t('common.savedSuccessfully'))
    await fetchItems()
    markSaved()
    dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

async function execute(item: Item) {
  loading.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoicing/payment-order/${item._id}/execute`)
    showSuccess(t('invoicing.orderExecuted'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

async function fetchContacts() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`); contacts.value = data.contacts || [] } catch { /* */ }
}

async function fetchBankAccounts() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/accounting/bank-account`); bankAccounts.value = data.bankAccounts || [] } catch { /* */ }
}

async function fetchUnpaidInvoices() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/invoices`, { params: { status: 'sent,partially_paid,overdue' } }); unpaidInvoices.value = data.invoices || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchContacts(); fetchBankAccounts(); fetchUnpaidInvoices() })
</script>
