<template>
  <v-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" max-width="1000" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-book-open-variant</v-icon>
        {{ $t('invoicing.contactLedger') || 'Contact Ledger' }}
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="$emit('update:modelValue', false)" />
      </v-card-title>

      <v-card-text>
        <!-- Filters -->
        <v-row dense class="mb-2">
          <v-col cols="12" sm="3">
            <v-text-field v-model="dateFrom" label="From" type="date" density="compact" hide-details clearable />
          </v-col>
          <v-col cols="12" sm="3">
            <v-text-field v-model="dateTo" label="To" type="date" density="compact" hide-details clearable />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select v-model="docTypes" label="Document Types" :items="docTypeOptions" multiple chips closable-chips density="compact" hide-details clearable />
          </v-col>
        </v-row>

        <!-- Data Table -->
        <v-data-table-server
          :headers="headers"
          :items="entries"
          :items-length="total"
          :loading="loading"
          :page="page + 1"
          :items-per-page="pageSize"
          @update:options="onUpdateOptions"
          density="compact"
          hover
        >
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.documentType="{ item }">
            <v-chip size="x-small" label :color="docTypeColor(item.documentType)">{{ docTypeLabel(item.documentType) }}</v-chip>
          </template>
          <template #item.unitPrice="{ item }">{{ item.unitPrice?.toFixed(2) }}</template>
          <template #item.lineTotal="{ item }">{{ item.lineTotal?.toFixed(2) }}</template>
        </v-data-table-server>

        <!-- Summary -->
        <v-card variant="outlined" class="mt-3">
          <v-card-text class="pa-3">
            <v-row dense>
              <v-col cols="4" class="text-center">
                <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalSales') || 'Total Sales' }}</div>
                <div class="text-subtitle-1 font-weight-bold text-success">{{ summary.totalSales?.toFixed(2) }}</div>
              </v-col>
              <v-col cols="4" class="text-center">
                <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalPurchases') || 'Total Purchases' }}</div>
                <div class="text-subtitle-1 font-weight-bold text-error">{{ summary.totalPurchases?.toFixed(2) }}</div>
              </v-col>
              <v-col cols="4" class="text-center">
                <div class="text-caption text-medium-emphasis">{{ $t('invoicing.balance') || 'Balance' }}</div>
                <div class="text-subtitle-1 font-weight-bold">{{ summary.balance?.toFixed(2) }}</div>
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../composables/useHttpClient'

const props = defineProps<{
  modelValue: boolean
  contactId: string
  orgUrl: string
}>()

defineEmits<{ 'update:modelValue': [value: boolean] }>()

const { t } = useI18n()

const loading = ref(false)
const entries = ref<any[]>([])
const total = ref(0)
const page = ref(0)
const pageSize = ref(25)
const dateFrom = ref('')
const dateTo = ref('')
const docTypes = ref<string[]>([])
const summary = ref({ totalSales: 0, totalPurchases: 0, balance: 0 })

const docTypeOptions = [
  { title: 'Invoice', value: 'invoice' },
  { title: 'Cash Sale', value: 'cash_sale' },
  { title: 'Proforma', value: 'proforma' },
  { title: 'Credit Note', value: 'credit_note' },
  { title: 'Debit Note', value: 'debit_note' },
]

const headers = [
  { title: t('common.date'), key: 'date', sortable: false },
  { title: t('invoicing.invoiceNumber'), key: 'documentNumber', sortable: false },
  { title: t('common.type'), key: 'documentType', sortable: false },
  { title: t('warehouse.product') || 'Product', key: 'productName', sortable: false },
  { title: t('invoicing.qty'), key: 'quantity', sortable: false, align: 'end' as const },
  { title: t('invoicing.unitPrice'), key: 'unitPrice', sortable: false, align: 'end' as const },
  { title: t('invoicing.taxRate'), key: 'taxRate', sortable: false, align: 'end' as const },
  { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: false },
  { title: t('common.total'), key: 'lineTotal', sortable: false, align: 'end' as const },
]

function docTypeColor(type: string) {
  return ({ invoice: 'primary', cash_sale: 'success', proforma: 'info', credit_note: 'warning', debit_note: 'error' }[type] || 'grey')
}

function docTypeLabel(type: string) {
  return ({ invoice: 'Invoice', cash_sale: 'Cash Sale', proforma: 'Proforma', credit_note: 'Credit Note', debit_note: 'Debit Note' }[type] || type)
}

async function fetchLedger() {
  if (!props.contactId || !props.orgUrl) return
  loading.value = true
  try {
    const params: Record<string, any> = { page: page.value, size: pageSize.value }
    if (dateFrom.value) params.dateFrom = dateFrom.value
    if (dateTo.value) params.dateTo = dateTo.value
    if (docTypes.value.length) params.documentTypes = docTypes.value.join(',')

    const { data } = await httpClient.get(`${props.orgUrl}/invoicing/contact-ledger/${props.contactId}`, { params })
    entries.value = data.entries || []
    total.value = data.total || 0
    summary.value = data.summary || { totalSales: 0, totalPurchases: 0, balance: 0 }
  } catch { /* */ } finally {
    loading.value = false
  }
}

function onUpdateOptions(opts: any) {
  page.value = (opts.page || 1) - 1
  pageSize.value = opts.itemsPerPage || 25
  fetchLedger()
}

watch(() => props.modelValue, (open) => { if (open) fetchLedger() })
watch([dateFrom, dateTo, docTypes], () => { page.value = 0; fetchLedger() })
</script>
