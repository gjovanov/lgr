<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('invoicing.cashSales') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.cash-sales.new' }">{{ $t('common.create') }}</responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field v-model="dateFrom" :label="$t('invoicing.dateFrom')" type="date" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field v-model="dateTo" :label="$t('invoicing.dateTo')" type="date" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server :headers="headers" :items="items" :items-length="pagination.total" :loading="loading" :page="pagination.page + 1" :items-per-page="pagination.size" @update:options="onUpdateOptions" item-value="_id" hover>
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'invoicing.cash-sales.edit', params: { id: item._id } }" />
            <v-btn v-if="item.status === 'paid'" icon="mdi-cancel" size="small" variant="text" color="warning" :title="$t('invoicing.void')" @click="voidCashSale(item)" />
            <v-btn v-if="item.status === 'draft'" icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteCashSaleConfirm') }}</v-card-text>
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
interface Item { _id: string; number: string; contactName: string; contactId?: string; date: string; status: string; total: number; currency: string; exchangeRate?: number; notes?: string; lines?: any[]; paymentMethod?: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const search = ref('')
const dateFrom = ref<string | null>(null)
const dateTo = ref<string | null>(null)
const deleteDialog = ref(false)
const selectedId = ref('')

const filters = computed(() => {
  const f: Record<string, any> = { type: 'cash_sale' }
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
})

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number, currency?: string) { return formatCurrency(amount, currency || baseCurrency.value, localeCode.value) }
function statusColor(s: string) { return ({ paid: 'success', voided: 'error', draft: 'grey' }[s] || 'grey') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

async function voidCashSale(item: Item) {
  try {
    await httpClient.post(`${orgUrl()}/invoices/${item._id}/void`)
    showSuccess(t('invoicing.cashSaleVoided'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/invoices/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems(); deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
function onExport(format: string) { console.log('Export cash sales as', format) }

onMounted(() => { fetchItems() })
</script>
