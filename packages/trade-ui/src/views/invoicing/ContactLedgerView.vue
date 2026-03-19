<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ $t('invoicing.contactLedger') }}: {{ contactName }}</h1>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row dense>
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
      </v-card-text>
    </v-card>

    <!-- Data Table -->
    <v-card class="mb-4">
      <v-card-text>
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
          <template #item.documentNumber="{ item }">
            <entity-link v-if="item.documentId" :label="item.documentNumber || ''" :to="documentRoute(item)" />
            <span v-else>{{ item.documentNumber }}</span>
          </template>
          <template #item.documentType="{ item }">
            <v-chip size="x-small" label :color="docTypeColor(item.documentType)">{{ docTypeLabel(item.documentType) }}</v-chip>
          </template>
          <template #item.productName="{ item }">
            <entity-link v-if="item.productId" :label="item.productName || ''" :to="{ name: 'warehouse.products.edit', params: { id: item.productId } }" />
            <span v-else>{{ item.productName }}</span>
          </template>
          <template #item.unitPrice="{ item }">{{ item.unitPrice?.toFixed(2) }}</template>
          <template #item.lineTotal="{ item }">{{ item.lineTotal?.toFixed(2) }}</template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Summary -->
    <v-card variant="outlined">
      <v-card-text class="pa-3">
        <v-row dense>
          <v-col cols="6" sm="3" class="text-center">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalSalesNet') }}</div>
            <div class="text-subtitle-1 font-weight-bold text-success">{{ fmtCurrency(summary.totalSalesNet) }}</div>
          </v-col>
          <v-col cols="6" sm="3" class="text-center">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalTax') }}</div>
            <div class="text-subtitle-1 font-weight-bold">{{ fmtCurrency(summary.totalTax) }}</div>
          </v-col>
          <v-col cols="6" sm="3" class="text-center">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalSalesGross') }}</div>
            <div class="text-subtitle-1 font-weight-bold text-success">{{ fmtCurrency(summary.totalSalesGross) }}</div>
          </v-col>
          <v-col cols="6" sm="3" class="text-center">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.totalPurchases') }}</div>
            <div class="text-subtitle-1 font-weight-bold text-error">{{ fmtCurrency(summary.totalPurchases) }}</div>
          </v-col>
        </v-row>
        <v-divider class="my-2" />
        <v-row dense>
          <v-col cols="6" sm="3" class="text-center">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.profitabilityNet') }}</div>
            <div class="text-subtitle-1 font-weight-bold" :class="(summary.profitabilityNet || 0) >= 0 ? 'text-success' : 'text-error'">{{ fmtCurrency(summary.profitabilityNet) }}</div>
          </v-col>
          <v-col cols="6" sm="3" class="text-center">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.profitabilityGross') }}</div>
            <div class="text-subtitle-1 font-weight-bold" :class="(summary.profitabilityGross || 0) >= 0 ? 'text-success' : 'text-error'">{{ fmtCurrency(summary.profitabilityGross) }}</div>
          </v-col>
          <v-col cols="6" sm="3" class="text-center">
            <div class="text-caption text-medium-emphasis">{{ $t('invoicing.balance') }}</div>
            <div class="text-subtitle-1 font-weight-bold">{{ fmtCurrency(summary.balance) }}</div>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useContactLedger, type ContactLedgerEntry } from 'ui-shared/composables/useContactLedger'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import EntityLink from 'ui-shared/components/EntityLink'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))
function fmtCurrency(val: number | undefined) { return formatCurrency(val || 0, baseCurrency.value, localeCode.value) }

const contactId = computed(() => route.params.id as string)
const orgUrl = computed(() => `/org/${appStore.currentOrg?.id}`)
const contactName = ref('')

const {
  loading, entries, total, page, pageSize, dateFrom, dateTo, docTypes, summary,
  docTypeOptions, headers, docTypeColor, docTypeLabel,
  fetchLedger, onUpdateOptions,
} = useContactLedger(contactId, orgUrl)

const docTypeRouteMap: Record<string, string> = {
  invoice: 'invoicing.sales.edit',
  proforma: 'invoicing.proforma.edit',
  credit_note: 'invoicing.credit-notes.edit',
  debit_note: 'invoicing.debit-notes.edit',
  cash_sale: 'invoicing.cash-sales.edit',
}

function documentRoute(item: ContactLedgerEntry) {
  const routeName = docTypeRouteMap[item.documentType]
  if (routeName && item.documentId) {
    return { name: routeName, params: { id: item.documentId } }
  }
  return undefined
}

async function fetchContactName() {
  try {
    const { data } = await httpClient.get(`${orgUrl.value}/invoicing/contact/${contactId.value}`)
    const c = data.contact || data
    contactName.value = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || ''
  } catch { /* */ }
}

onMounted(async () => {
  await fetchContactName()
  await fetchLedger()
})

watch([dateFrom, dateTo, docTypes], () => { page.value = 0; fetchLedger() })
</script>
