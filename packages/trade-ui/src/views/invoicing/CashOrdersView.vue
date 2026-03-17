<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.cashOrders') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" @click="openCreate">{{ $t('common.create') }}</responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="typeFilter" :label="$t('common.type')" :items="typeFilterOptions" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server :headers="headers" :items="items" :items-length="pagination.total" :loading="loading" :page="pagination.page + 1" :items-per-page="pagination.size" @update:options="onUpdateOptions" item-value="_id" hover>
          <template #item.date="{ item }">{{ formatDate(item.date) }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label :color="item.type === 'receipt' ? 'success' : 'error'">
              {{ item.type === 'receipt' ? $t('invoicing.receipt') : $t('invoicing.disbursement') }}
            </v-chip>
          </template>
          <template #item.amount="{ item }">{{ fmtCurrency(item.amount) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEdit(item)" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

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
                <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" />
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

interface Item { _id: string; number: string; type: string; party: string; date: string; amount: number; description?: string; accountId?: string; counterAccountId?: string; accountName?: string; counterAccountName?: string }
interface Account { _id: string; code: string; name: string; type: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
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

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (search.value) f.search = search.value
  if (typeFilter.value) f.type = typeFilter.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/cash-order`),
  entityKey: 'cashOrders',
  filters,
})

const emptyForm = () => ({ type: 'receipt', party: '', date: new Date().toISOString().split('T')[0], amount: 0, accountId: '', counterAccountId: '', description: '' })
const form = ref(emptyForm())

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
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

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
    if (editing.value) await httpClient.put(`${orgUrl()}/invoicing/cash-order/${selectedId.value}`, payload)
    else await httpClient.post(`${orgUrl()}/invoicing/cash-order`, payload)
    showSuccess(t('common.savedSuccessfully'))
    await fetchItems(); dialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/invoicing/cash-order/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
function onExport(format: string) { console.log('Export cash orders as', format) }

async function fetchAccounts() {
  try { const { data } = await httpClient.get(`${orgUrl()}/accounting/account`); accounts.value = data.accounts || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchAccounts() })
</script>
