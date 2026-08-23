<template>
  <ListScaffold
    :title="$t('nav.cashOrders')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-cash-multiple', title: $t('list.empty.cashOrders'), description: $t('list.empty.cashOrdersHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <responsive-btn color="primary" icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</responsive-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="3">
          <v-select v-model="typeFilter" :label="$t('common.type')" :items="typeFilterOptions" clearable />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <responsive-btn color="primary" icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</responsive-btn>
    </template>

    <!-- Cell renderers -->
    <template #item.date="{ item }">{{ formatDate(item.date) }}</template>
    <template #item.type="{ item }">
      <v-chip size="small" label :color="item.type === 'receipt' ? 'success' : 'error'">
        {{ item.type === 'receipt' ? $t('invoicing.receipt') : $t('invoicing.disbursement') }}
      </v-chip>
    </template>
    <template #item.amount="{ item }">{{ fmtCurrency(item.amount) }}</template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-pencil" size="small" variant="text" :title="$t('common.edit')" :aria-label="$t('common.edit')" @click="openEdit(item)" />
      <v-btn icon="mdi-delete" size="small" variant="text" color="error" :title="$t('common.delete')" :aria-label="$t('common.delete')" @click="confirmDelete(item)" />
    </template>

    <!-- Create/Edit Dialog -->
    <v-dialog v-model="dialog" max-width="600" persistent>
      <v-card>
        <v-card-title>{{ editing ? $t('common.edit') : $t('common.create') }} {{ $t('nav.cashOrders') }}</v-card-title>
        <v-card-text>
          <v-form ref="formRef">
            <v-select
              v-model="form.type"
              :label="$t('common.type')"
              :items="typeOptions"
              :rules="[rules.required]"
            />
            <v-text-field v-model="form.party" :label="$t('invoicing.party')" :rules="[rules.required]" />
            <v-row>
              <v-col cols="6">
                <v-text-field v-model.number="form.amount" :label="$t('common.amount')" type="number" step="0.01" :rules="[rules.required]" />
              </v-col>
              <v-col cols="6">
                <DateField v-model="form.date" :label="$t('common.date')" :rules="[rules.required]" />
              </v-col>
            </v-row>
            <v-autocomplete v-model="form.accountId" :label="$t('invoicing.cashAccount')" :items="cashAccounts" :item-title="accountTitle" item-value="_id" clearable />
            <v-autocomplete v-model="form.counterAccountId" :label="$t('invoicing.counterAccount')" :items="accounts" :item-title="accountTitle" item-value="_id" clearable />
            <v-textarea v-model="form.description" :label="$t('common.description')" rows="2" />
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
        <v-card-text>{{ $t('invoicing.deleteCashOrderConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
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
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import DateField from 'ui-shared/components/DateField.vue'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import { useDialogPendingChanges } from 'ui-shared/composables/useDialogPendingChanges'

interface Item { _id: string; number: string; type: string; party: string; date: string; amount: number; description?: string; accountId?: string; counterAccountId?: string; accountName?: string; counterAccountName?: string }
interface Account { _id: string; code: string; name: string; type: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const dialog = ref(false)
const deleteDialog = ref(false)
const editing = ref(false)
const formRef = ref()
const selectedId = ref('')
const typeFilter = ref<string | null>(null)
const accounts = ref<Account[]>([])
const cashAccounts = computed(() => accounts.value.filter(a => a.type === 'asset'))

const typeFilterOptions = ['receipt', 'disbursement']
const typeOptions = computed(() => [
  { title: t('invoicing.receipt'), value: 'receipt' },
  { title: t('invoicing.disbursement'), value: 'disbursement' },
])

const hasActiveFilters = computed(() => !!debouncedSearch.value || !!typeFilter.value)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (typeFilter.value) f.type = typeFilter.value
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'type', ref: typeFilter },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/cash-order`),
  entityKey: 'cashOrders',
  filters,
  urlSync: true,
})

const emptyForm = () => ({ type: 'receipt', party: '', date: new Date().toISOString().split('T')[0], amount: 0, accountId: '', counterAccountId: '', description: '' })
const form = ref(emptyForm())

const { markSaved } = useDialogPendingChanges({
  appId: 'invoicing',
  entityType: 'cashOrder',
  dialogId: 'invoicing-cash-orders',
  icon: 'mdi-cash',
  dialogVisible: dialog,
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Type', value: form.value.type },
    { label: 'Party', value: form.value.party },
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
  { title: t('invoicing.party'), key: 'party', sortable: true },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('common.amount'), key: 'amount', align: 'end' as const },
  { title: t('invoicing.cashAccount'), key: 'accountName' },
  { title: t('common.description'), key: 'description' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function accountTitle(item: Account) { return `${item.code} - ${item.name}` }
function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function formatDate(d: string) { return d ? d.split('T')[0] : '' }

function openCreate() {
  editing.value = false
  form.value = emptyForm()
  dialog.value = true
}

function openEdit(item: Item) {
  editing.value = true; selectedId.value = item._id
  form.value = { type: item.type, party: item.party, date: item.date?.split('T')[0] || '', amount: item.amount, accountId: item.accountId || '', counterAccountId: item.counterAccountId || '', description: item.description || '' }
  dialog.value = true
}

async function save() {
  const { valid } = await formRef.value.validate(); if (!valid) return
  loading.value = true
  try {
    const payload: any = { ...form.value }
    if (!payload.accountId) delete payload.accountId
    if (!payload.counterAccountId) delete payload.counterAccountId
    if (editing.value) await httpClient.put(`${appStore.orgUrl()}/invoicing/cash-order/${selectedId.value}`, payload)
    else await httpClient.post(`${appStore.orgUrl()}/invoicing/cash-order`, payload)
    showSuccess(t('common.savedSuccessfully'))
    await fetchItems()
    markSaved()
    dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/invoicing/cash-order/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchAccounts() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/accounting/account`); accounts.value = data.accounts || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchAccounts() })
</script>
