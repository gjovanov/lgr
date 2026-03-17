<template>
  <v-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" max-width="1200" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-book-open-variant</v-icon>
        {{ $t('invoicing.contactLedger') }}
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="$emit('update:modelValue', false)" />
      </v-card-title>

      <v-card-text>
        <p v-if="selectable" class="text-body-2 text-medium-emphasis mb-2">{{ $t('invoicing.selectItemsToAdd') }}</p>

        <!-- Filters -->
        <v-row dense class="mb-2">
          <v-col cols="12" sm="3">
            <v-text-field v-model="dateFrom" :label="$t('common.from')" type="date" density="compact" hide-details clearable />
          </v-col>
          <v-col cols="12" sm="3">
            <v-text-field v-model="dateTo" :label="$t('common.to')" type="date" density="compact" hide-details clearable />
          </v-col>
          <v-col cols="12" sm="6">
            <v-select v-model="docTypes" :label="$t('common.type')" :items="docTypeOptions" multiple chips closable-chips density="compact" hide-details clearable />
          </v-col>
        </v-row>

        <!-- Data Table -->
        <v-data-table-server
          :headers="allHeaders"
          :items="entries"
          :items-length="total"
          :loading="loading"
          :page="page + 1"
          :items-per-page="pageSize"
          @update:options="onUpdateOptions"
          density="compact"
          hover
        >
          <template v-if="selectable" #item.select="{ item }">
            <v-checkbox-btn v-model="selectedIds" :value="item.documentId + '|' + item.productId" density="compact" hide-details />
          </template>
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.documentNumber="{ item }">
            <entity-link v-if="item.documentId" :label="item.documentNumber || ''" :href="documentHref(item)" />
            <span v-else>{{ item.documentNumber }}</span>
          </template>
          <template #item.documentType="{ item }">
            <v-chip size="x-small" label :color="docTypeColor(item.documentType)">{{ docTypeLabel(item.documentType) }}</v-chip>
          </template>
          <template #item.productName="{ item }">
            <entity-link v-if="item.productId" :label="item.productName || ''" :href="`/trade/products/${item.productId}/edit`" />
            <span v-else>{{ item.productName }}</span>
          </template>
          <template #item.unitPrice="{ item }">{{ item.unitPrice?.toFixed(2) }}</template>
          <template #item.lineTotal="{ item }">{{ item.lineTotal?.toFixed(2) }}</template>
        </v-data-table-server>

        <!-- Summary -->
        <v-card variant="outlined" class="mt-3">
          <v-card-text class="pa-3">
            <v-row dense>
              <v-col cols="4" class="text-center">
                <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalSales') }}</div>
                <div class="text-subtitle-1 font-weight-bold text-success">{{ summary.totalSales?.toFixed(2) }}</div>
              </v-col>
              <v-col cols="4" class="text-center">
                <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalPurchases') }}</div>
                <div class="text-subtitle-1 font-weight-bold text-error">{{ summary.totalPurchases?.toFixed(2) }}</div>
              </v-col>
              <v-col cols="4" class="text-center">
                <div class="text-caption text-medium-emphasis">{{ $t('invoicing.balance') }}</div>
                <div class="text-subtitle-1 font-weight-bold">{{ summary.balance?.toFixed(2) }}</div>
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>
      </v-card-text>

      <!-- Selection footer -->
      <v-card-actions v-if="selectable">
        <span class="text-body-2 text-medium-emphasis ml-2">{{ selectedIds.length }} selected</span>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :disabled="selectedIds.length === 0" @click="addSelectedLines">
          {{ $t('invoicing.addLineItems') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useContactLedger, type ContactLedgerEntry } from '../composables/useContactLedger'
import EntityLink from './EntityLink.vue'

const props = defineProps<{
  modelValue: boolean
  contactId: string
  orgUrl: string
  selectable?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'add-lines': [entries: ContactLedgerEntry[]]
}>()

const contactIdRef = computed(() => props.contactId)
const orgUrlRef = computed(() => props.orgUrl)

const {
  loading, entries, total, page, pageSize, dateFrom, dateTo, docTypes, summary,
  docTypeOptions, headers, docTypeColor, docTypeLabel,
  fetchLedger, onUpdateOptions,
} = useContactLedger(contactIdRef, orgUrlRef)

const docTypePathMap: Record<string, string> = {
  invoice: 'invoices',
  proforma: 'proforma-invoices',
  credit_note: 'credit-notes',
  cash_sale: 'cash-sales',
}

function documentHref(item: ContactLedgerEntry) {
  const path = docTypePathMap[item.documentType]
  if (path && item.documentId) {
    return `/trade/${path}/${item.documentId}/edit`
  }
  return undefined
}

const selectedIds = ref<string[]>([])

const allHeaders = computed(() => {
  if (props.selectable) {
    return [{ title: '', key: 'select', sortable: false, width: 40 }, ...headers]
  }
  return headers
})

function addSelectedLines() {
  const selected = entries.value.filter(e =>
    selectedIds.value.includes(`${e.documentId}|${e.productId}`)
  )
  emit('add-lines', selected)
  selectedIds.value = []
  emit('update:modelValue', false)
}

watch(() => props.modelValue, (open) => {
  if (open) {
    selectedIds.value = []
    fetchLedger()
  }
})
watch([dateFrom, dateTo, docTypes], () => { page.value = 0; fetchLedger() })
</script>
