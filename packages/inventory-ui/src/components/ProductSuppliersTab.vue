<template>
  <v-card-text data-testid="product-suppliers-tab">
    <div class="text-body-2 text-medium-emphasis mb-3">{{ $t('warehouse.supplierFacts.tabIntro') }}</div>

    <v-progress-linear v-if="loading" indeterminate class="mb-3" />
    <v-alert v-else-if="failed" type="warning" variant="tonal" density="compact" data-testid="product-suppliers-tab-failed">
      {{ $t('warehouse.supplierFacts.loadFailed') }}
    </v-alert>
    <v-alert v-else-if="!suppliers.length" type="info" variant="tonal" density="compact" data-testid="product-suppliers-tab-empty">
      {{ $t('warehouse.supplierFacts.empty') }}
    </v-alert>

    <!-- One row per supplier: what the documents say. -->
    <v-table v-if="suppliers.length" density="compact" data-testid="product-supplier-facts">
      <thead>
        <tr>
          <th>{{ $t('warehouse.supplierFacts.supplier') }}</th>
          <th>{{ $t('warehouse.supplierFacts.lastPurchase') }}</th>
          <th v-if="hasPrices" class="text-end">{{ $t('warehouse.supplierFacts.lastCost') }}</th>
          <th class="text-end">{{ $t('warehouse.supplierFacts.quantityBought') }}</th>
          <th class="text-end">{{ $t('warehouse.supplierFacts.documents') }}</th>
          <th>{{ $t('warehouse.supplierFacts.lastDocument') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in suppliers" :key="s.supplierId" data-testid="product-supplier-row">
          <td><entity-link :label="s.supplierName || '—'" :href="contactHref(s.supplierId)" /></td>
          <td class="text-no-wrap">{{ fmtDate(s.lastPurchasedAt) }}</td>
          <td v-if="hasPrices" class="text-end text-no-wrap">{{ s.lastUnitPrice === undefined ? '—' : fmtPrice(s.lastUnitPrice, s.currency) }}</td>
          <td class="text-end">{{ fmtQty(s.quantity) }}</td>
          <td class="text-end">{{ s.documents }}</td>
          <td class="text-no-wrap">
            <v-chip size="x-small" variant="tonal" class="mr-1">{{ kindLabel(s.lastDocument.kind) }}</v-chip>
            <entity-link :label="s.lastDocument.number || '—'" v-bind="documentLink(s.lastDocument.kind, s.lastDocument.id)" />
          </td>
        </tr>
      </tbody>
    </v-table>

    <!-- The documents behind them, newest first: a bill or a receipt, each a link. -->
    <template v-if="documents.length">
      <div class="text-subtitle-2 mt-6 mb-1">{{ $t('warehouse.supplierFacts.recentDocuments') }}</div>
      <v-table density="compact" data-testid="product-supplier-documents">
        <thead>
          <tr>
            <th>{{ $t('warehouse.supplierFacts.date') }}</th>
            <th>{{ $t('warehouse.document') }}</th>
            <th>{{ $t('warehouse.supplierFacts.supplier') }}</th>
            <th class="text-end">{{ $t('warehouse.quantity') }}</th>
            <th v-if="hasPrices" class="text-end">{{ $t('warehouse.supplierFacts.price') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in documents" :key="d.kind + d.id" data-testid="product-supplier-document">
            <td class="text-no-wrap">{{ fmtDate(d.date) }}</td>
            <td class="text-no-wrap">
              <v-chip size="x-small" variant="tonal" class="mr-1">{{ kindLabel(d.kind) }}</v-chip>
              <entity-link :label="d.number || '—'" v-bind="documentLink(d.kind, d.id)" />
            </td>
            <td><entity-link :label="d.supplierName || '—'" :href="contactHref(d.supplierId)" /></td>
            <td class="text-end">{{ fmtQty(d.quantity) }}</td>
            <td v-if="hasPrices" class="text-end text-no-wrap">{{ d.unitPrice === undefined ? '—' : fmtPrice(d.unitPrice, d.currency) }}</td>
          </tr>
        </tbody>
      </v-table>
    </template>
  </v-card-text>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import EntityLink from 'ui-shared/components/EntityLink'
import { appHref } from 'ui-shared/nav/navigate'
import { useAppStore } from '../store/app.store'
import { formatUnitPrice } from '../composables/product-price-columns'

/**
 * FR-28.7 — an article's Suppliers tab: one row per supplier (what the documents say: the date and unit price of
 * the last purchase, how much was bought, in how many documents, and the document last used) and the last ten
 * documents behind them. Read from the received bills and the receipts that name a supplier; nothing here is
 * entered, so there is nothing to save.
 */
interface Fact {
  supplierId: string
  supplierName: string
  lastPurchasedAt: string
  lastUnitPrice?: number
  currency?: string
  quantity: number
  documents: number
  lastDocument: { kind: 'bill' | 'receipt'; id: string; number: string }
}
interface Doc {
  kind: 'bill' | 'receipt'
  id: string
  number: string
  date: string
  supplierId: string
  supplierName: string
  quantity: number
  unitPrice?: number
  currency?: string
}

const props = defineProps<{ productId: string }>()
const { t } = useI18n()
const appStore = useAppStore()

const suppliers = ref<Fact[]>([])
const documents = ref<Doc[]>([])
const loading = ref(false)
const failed = ref(false)

const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
/** The server leaves the price out for a caller who may not see costs (FR-28.6): no column for it then. */
const hasPrices = computed(() => suppliers.value.some((s) => s.lastUnitPrice !== undefined) || documents.value.some((d) => d.unitPrice !== undefined))

const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleDateString(localeCode.value) : '')
const fmtQty = (n: number) => new Intl.NumberFormat(localeCode.value, { maximumFractionDigits: 3 }).format(n || 0)
const fmtPrice = (amount: number, currency?: string) => formatUnitPrice(amount, currency || baseCurrency.value, localeCode.value)
const kindLabel = (kind: 'bill' | 'receipt') => t(kind === 'bill' ? 'warehouse.supplierFacts.kindBill' : 'warehouse.supplierFacts.kindReceipt')
const contactHref = (id: string) => appHref('invoicing', `/invoicing/contacts/${id}/edit`)
/** A bill opens in the invoicing app, a receipt in this one. */
function documentLink(kind: 'bill' | 'receipt', id: string): { href?: string; to?: object } {
  return kind === 'bill'
    ? { href: appHref('invoicing', `/invoicing/bills/${id}/edit`) }
    : { to: { name: 'inventory.movements.view', params: { id } } }
}

// A slower answer for an earlier article never overwrites the current one.
let request = 0
async function load() {
  if (!props.productId) return
  const mine = ++request
  loading.value = true
  failed.value = false
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-supplier/${props.productId}`)
    if (mine !== request) return
    suppliers.value = data.suppliers || []
    documents.value = data.documents || []
  } catch {
    if (mine !== request) return
    suppliers.value = []
    documents.value = []
    failed.value = true
  } finally {
    if (mine === request) loading.value = false
  }
}

watch(() => props.productId, load, { immediate: true })
</script>
