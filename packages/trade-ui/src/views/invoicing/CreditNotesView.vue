<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.creditNotes') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.credit-notes.new' }">{{ $t('common.create') }}</responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="['draft', 'issued', 'applied', 'voided']" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <TagInput v-model="tagFilter" type="invoice" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server :headers="headers" :items="items" :items-length="pagination.total" :loading="loading" :page="pagination.page + 1" :items-per-page="pagination.size" @update:options="onUpdateOptions" item-value="_id" hover>
          <template #item.number="{ item }">
            <entity-link :label="item.number" :to="{ name: 'invoicing.credit-notes.edit', params: { id: item._id } }" />
          </template>
          <template #item.contactName="{ item }">
            <entity-link v-if="item.contactId" :label="item.contactName" :to="{ name: 'invoicing.contacts.edit', params: { id: item.contactId } }" />
            <span v-else>{{ item.contactName }}</span>
          </template>
          <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
          <template #item.relatedInvoiceNumber="{ item }">
            <entity-link v-if="item.relatedInvoiceId" :label="item.relatedInvoiceNumber || ''" :to="{ name: 'invoicing.sales.edit', params: { id: item.relatedInvoiceId } }" />
            <span v-else-if="item.relatedInvoiceNumber">{{ item.relatedInvoiceNumber }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.credit-notes.edit', params: { id: item._id } }" />
            <v-btn
              v-if="item.status === 'draft'"
              icon="mdi-send"
              size="small"
              variant="text"
              color="info"
              :title="$t('invoicing.send')"
              @click="sendCreditNote(item)"
            />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteCreditNoteConfirm') }}</v-card-text>
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
import TagInput from 'ui-shared/components/TagInput.vue'
import EntityLink from 'ui-shared/components/EntityLink'
interface Item { _id: string; number: string; contactName: string; contactId?: string; relatedInvoiceId?: string; relatedInvoiceNumber?: string; date: string; status: string; total: number; currency: string; exchangeRate?: number; reason?: string; lines?: any[] }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const deleteDialog = ref(false)
const selectedId = ref('')
const statusFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])

const filters = computed(() => {
  const f: Record<string, any> = { type: 'credit_note' }
  if (search.value) f.search = search.value
  if (statusFilter.value) f.status = statusFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
})

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.relatedInvoice'), key: 'relatedInvoiceNumber' },
  { title: t('common.date'), key: 'issueDate', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number, currency?: string) { return formatCurrency(amount, currency || baseCurrency.value, localeCode.value) }
function statusColor(s: string) { return ({ draft: 'grey', issued: 'info', applied: 'success', voided: 'error' }[s] || 'grey') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

async function sendCreditNote(item: Item) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoices/${item._id}/send`)
    showSuccess(t('invoicing.creditNoteIssued') || t('invoicing.invoiceSent'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
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
function onExport(format: string) { console.log('Export credit notes as', format) }

onMounted(() => { fetchItems() })
</script>
