<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ $t('warehouse.productStock') }}: {{ product?.name || '' }}</h1>
    </div>

    <v-card>
      <v-tabs v-model="activeTab">
        <v-tab value="levels">{{ $t('warehouse.stockLevels') }}</v-tab>
        <v-tab value="ledger">{{ $t('warehouse.productLedger') }}</v-tab>
        <v-tab value="movements">{{ $t('nav.stockMovements') }}</v-tab>
        <v-tab value="counts">{{ $t('nav.inventoryCount') }}</v-tab>
      </v-tabs>

      <v-tabs-window v-model="activeTab">
        <!-- Stock Levels -->
        <v-tabs-window-item value="levels">
          <v-card-text>
            <v-data-table
              :headers="stockLevelHeaders"
              :items="stockLevels"
              :loading="stockLoading"
              density="compact"
              hover
            >
              <template #item.quantity="{ item }">{{ item.quantity }}</template>
              <template #item.availableQuantity="{ item }">{{ item.availableQuantity ?? item.quantity }}</template>
              <template #item.avgCost="{ item }">{{ fmtCurrency(item.avgCost || 0) }}</template>
              <template #item.value="{ item }">{{ fmtCurrency((item.quantity || 0) * (item.avgCost || 0)) }}</template>
            </v-data-table>
          </v-card-text>
        </v-tabs-window-item>

        <!-- Product Ledger -->
        <v-tabs-window-item value="ledger">
          <v-card-text class="pb-2">
            <v-row>
              <v-col cols="12" md="3">
                <v-select
                  v-model="warehouseFilter"
                  :label="$t('warehouse.warehouse')"
                  :items="warehouses"
                  item-title="name"
                  item-value="_id"
                  clearable
                  hide-details
                  density="compact"
                />
              </v-col>
              <v-col cols="12" md="2">
                <v-text-field v-model="dateFrom" :label="$t('invoicing.dateFrom')" type="date" hide-details density="compact" />
              </v-col>
              <v-col cols="12" md="2">
                <v-text-field v-model="dateTo" :label="$t('invoicing.dateTo')" type="date" hide-details density="compact" />
              </v-col>
              <v-col cols="12" md="3">
                <v-autocomplete
                  v-model="contactFilter"
                  v-model:search="contactSearch"
                  :items="contactItems"
                  :loading="contactLoading"
                  item-title="displayName"
                  item-value="_id"
                  :label="$t('warehouse.filterByContact')"
                  clearable
                  hide-details
                  density="compact"
                  no-filter
                />
              </v-col>
              <v-col cols="12" md="2">
                <v-select
                  v-model="eventTypeFilter"
                  :label="$t('warehouse.filterByEventType')"
                  :items="eventTypeItems"
                  multiple
                  chips
                  closable-chips
                  clearable
                  hide-details
                  density="compact"
                />
              </v-col>
            </v-row>
          </v-card-text>
          <v-card-text>
            <v-data-table-server
              :headers="ledgerHeaders"
              :items="entries"
              :items-length="totalEntries"
              :loading="ledgerLoading"
              :page="currentPage + 1"
              :items-per-page="pageSize"
              @update:options="onUpdateOptions"
              item-value="documentId"
              hover
              density="compact"
            >
              <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
              <template #item.contactName="{ item }">
                <entity-link v-if="item.contactId" :label="item.contactName || ''" :href="`/trade/contacts/${item.contactId}/edit`" />
                <span v-else>{{ item.contactName || '' }}</span>
              </template>
              <template #item.eventType="{ item }">
                <v-chip size="x-small" label :color="eventColor(item.eventType)">{{ eventLabel(item.eventType) }}</v-chip>
              </template>
              <template #item.quantityChange="{ item }">
                <span :class="item.quantityChange > 0 ? 'text-success' : 'text-error'">
                  {{ item.quantityChange > 0 ? '+' : '' }}{{ item.quantityChange }}
                </span>
              </template>
              <template #item.unitCost="{ item }">{{ fmtCurrency(item.unitCost) }}</template>
              <template #item.lineTotalCost="{ item }">{{ fmtCurrency(item.lineTotalCost) }}</template>
              <template #item.runningQty="{ item }">
                <strong>{{ item.runningQty }}</strong>
              </template>
              <template #item.runningValue="{ item }">
                <strong>{{ fmtCurrency(item.runningValue) }}</strong>
              </template>
              <template #item.invoiceNumber="{ item }">
                <entity-link v-if="item.invoiceId" :label="item.invoiceNumber || ''" :href="`/trade/invoices/${item.invoiceId}/edit`" />
                <span v-else-if="item.invoiceNumber">{{ item.invoiceNumber }}</span>
              </template>
            </v-data-table-server>

            <!-- Summary -->
            <v-divider class="my-3" />
            <v-row dense>
              <v-col cols="6" md="3">
                <span class="text-caption text-medium-emphasis">{{ $t('warehouse.totalIn') }}:</span>
                <strong class="ml-1 text-success">+{{ summary.totalIn }}</strong>
              </v-col>
              <v-col cols="6" md="3">
                <span class="text-caption text-medium-emphasis">{{ $t('warehouse.totalOut') }}:</span>
                <strong class="ml-1 text-error">-{{ summary.totalOut }}</strong>
              </v-col>
              <v-col cols="6" md="3">
                <span class="text-caption text-medium-emphasis">{{ $t('warehouse.quantity') }}:</span>
                <strong class="ml-1">{{ summary.currentQty }}</strong>
              </v-col>
              <v-col cols="6" md="3">
                <span class="text-caption text-medium-emphasis">{{ $t('warehouse.currentValue') }}:</span>
                <strong class="ml-1">{{ fmtCurrency(summary.currentValue) }}</strong>
              </v-col>
            </v-row>
            <v-row dense>
              <v-col cols="6" md="3">
                <span class="text-caption text-medium-emphasis">{{ $t('warehouse.totalCashRegisterSales') }}:</span>
                <strong class="ml-1">{{ fmtCurrency(summary.totalCashRegisterSales) }}</strong>
              </v-col>
              <v-col cols="6" md="3">
                <span class="text-caption text-medium-emphasis">{{ $t('warehouse.totalInvoiceSales') }}:</span>
                <strong class="ml-1">{{ fmtCurrency(summary.totalInvoiceSales) }}</strong>
              </v-col>
              <v-col cols="6" md="3">
                <span class="text-caption text-medium-emphasis">{{ $t('warehouse.totalSales') }}:</span>
                <strong class="ml-1">{{ fmtCurrency(summary.totalSales) }}</strong>
              </v-col>
            </v-row>
          </v-card-text>
        </v-tabs-window-item>

        <!-- Stock Movements -->
        <v-tabs-window-item value="movements">
          <v-card-text>
            <v-data-table
              :headers="movementHeaders"
              :items="stockMovements"
              :loading="stockLoading"
              density="compact"
              hover
            >
              <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
              <template #item.type="{ item }">
                <v-chip size="x-small" label :color="eventColor(item.type)">{{ eventLabel(item.type) }}</v-chip>
              </template>
              <template #item.status="{ item }">
                <v-chip size="x-small" :color="item.status === 'confirmed' ? 'success' : 'warning'">{{ item.status }}</v-chip>
              </template>
            </v-data-table>
          </v-card-text>
        </v-tabs-window-item>

        <!-- Inventory Counts -->
        <v-tabs-window-item value="counts">
          <v-card-text>
            <v-data-table
              :headers="countHeaders"
              :items="stockCounts"
              :loading="stockLoading"
              density="compact"
              hover
            >
              <template #item.status="{ item }">
                <v-chip size="x-small" :color="item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'info' : 'warning'">{{ item.status }}</v-chip>
              </template>
              <template #item.countDate="{ item }">{{ item.countDate?.split('T')[0] || '' }}</template>
            </v-data-table>
          </v-card-text>
        </v-tabs-window-item>
      </v-tabs-window>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import EntityLink from 'ui-shared/components/EntityLink'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const productId = computed(() => route.params.id as string)
const product = ref<any>(null)
const activeTab = ref('levels')

// ── Stock Levels tab ──
const stockLoading = ref(false)
const stockLevels = ref<any[]>([])
const stockMovements = ref<any[]>([])
const stockCounts = ref<any[]>([])

const stockLevelHeaders = computed(() => [
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('warehouse.quantity'), key: 'quantity', align: 'end' as const },
  { title: t('warehouse.unitCost'), key: 'avgCost', align: 'end' as const },
  { title: t('warehouse.value'), key: 'value', align: 'end' as const },
])

const movementHeaders = computed(() => [
  { title: '#', key: 'movementNumber' },
  { title: t('common.type'), key: 'type' },
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('warehouse.quantity'), key: 'quantity', align: 'end' as const },
  { title: t('common.date'), key: 'date' },
  { title: t('common.status'), key: 'status' },
])

const countHeaders = computed(() => [
  { title: '#', key: 'countNumber' },
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('common.date'), key: 'countDate' },
  { title: t('common.status'), key: 'status' },
])

// ── Product Ledger tab ──
const ledgerLoading = ref(false)
const entries = ref<any[]>([])
const totalEntries = ref(0)
const currentPage = ref(0)
const pageSize = ref(25)
const summary = ref({
  totalIn: 0, totalOut: 0, currentQty: 0, currentValue: 0,
  totalCashRegisterSales: 0, totalInvoiceSales: 0, totalSales: 0,
})

const warehouseFilter = ref<string | null>(null)
const dateFrom = ref('')
const dateTo = ref('')
const contactFilter = ref<string | null>(null)
const contactSearch = ref('')
const contactItems = ref<any[]>([])
const contactLoading = ref(false)
const eventTypeFilter = ref<string[]>([])
const warehouses = ref<any[]>([])

let contactDebounce: ReturnType<typeof setTimeout> | null = null

const eventTypeItems = computed(() => [
  { title: t('warehouse.received'), value: 'received' },
  { title: t('warehouse.dispatched'), value: 'dispatched' },
  { title: t('warehouse.transferredIn'), value: 'transferred_in' },
  { title: t('warehouse.transferredOut'), value: 'transferred_out' },
  { title: t('warehouse.adjusted'), value: 'adjusted' },
  { title: t('warehouse.countAdjusted'), value: 'count_adjusted' },
  { title: t('warehouse.returned'), value: 'returned' },
  { title: t('warehouse.producedIn'), value: 'produced_in' },
  { title: t('warehouse.producedOut'), value: 'produced_out' },
])

const ledgerHeaders = computed(() => [
  { title: t('common.date'), key: 'date', width: '100px' },
  { title: t('warehouse.document'), key: 'documentRef' },
  { title: t('invoicing.contact'), key: 'contactName' },
  { title: t('warehouse.event'), key: 'eventType' },
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('warehouse.qtyChange'), key: 'quantityChange', align: 'end' as const },
  { title: t('warehouse.unitCost'), key: 'unitCost', align: 'end' as const },
  { title: t('common.total'), key: 'lineTotalCost', align: 'end' as const },
  { title: t('warehouse.runningQty'), key: 'runningQty', align: 'end' as const },
  { title: t('warehouse.runningValue'), key: 'runningValue', align: 'end' as const },
  { title: t('invoicing.invoice'), key: 'invoiceNumber' },
])

function fmtCurrency(amount: number) {
  return formatCurrency(amount, baseCurrency.value, localeCode.value)
}

function eventColor(eventType: string) {
  const map: Record<string, string> = {
    received: 'success', dispatched: 'error', transferred_in: 'info',
    transferred_out: 'orange', adjusted: 'amber', count_adjusted: 'purple',
    returned: 'teal', produced_in: 'light-green', produced_out: 'deep-orange',
  }
  return map[eventType] || 'grey'
}

function eventLabel(eventType: string) {
  const map: Record<string, string> = {
    received: t('warehouse.received'), dispatched: t('warehouse.dispatched'),
    transferred_in: t('warehouse.transferredIn'), transferred_out: t('warehouse.transferredOut'),
    adjusted: t('warehouse.adjusted'), count_adjusted: t('warehouse.countAdjusted'),
    returned: t('warehouse.returned'), produced_in: t('warehouse.producedIn'),
    produced_out: t('warehouse.producedOut'),
  }
  return map[eventType] || eventType
}

// ── Data fetching ──
async function fetchProduct() {
  if (!productId.value) return
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product/${productId.value}`)
    product.value = data.product || data
  } catch { /* */ }
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`)
    warehouses.value = data.warehouses || []
  } catch { /* */ }
}

async function fetchStockData() {
  if (!productId.value) return
  stockLoading.value = true
  try {
    const [levelsRes, movementsRes, countsRes] = await Promise.all([
      httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level`, { params: { productId: productId.value, size: 0 } }),
      httpClient.get(`${appStore.orgUrl()}/warehouse/movement`, { params: { productId: productId.value, size: 0 } }),
      httpClient.get(`${appStore.orgUrl()}/warehouse/inventory-count`, { params: { productId: productId.value, size: 0 } }),
    ])
    stockLevels.value = levelsRes.data.stockLevels || []
    stockMovements.value = movementsRes.data.stockMovements || []
    stockCounts.value = countsRes.data.inventoryCounts || []
  } catch { /* */ }
  stockLoading.value = false
}

async function fetchLedger() {
  if (!productId.value) return
  ledgerLoading.value = true
  try {
    const params: Record<string, string> = {
      page: String(currentPage.value),
      size: String(pageSize.value),
    }
    if (warehouseFilter.value) params.warehouseId = warehouseFilter.value
    if (dateFrom.value) params.dateFrom = dateFrom.value
    if (dateTo.value) params.dateTo = dateTo.value
    if (contactFilter.value) params.contactId = contactFilter.value
    if (eventTypeFilter.value.length) params.eventTypes = eventTypeFilter.value.join(',')

    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-ledger/${productId.value}`, { params })
    entries.value = data.entries || []
    totalEntries.value = data.total ?? 0
    summary.value = data.summary || summary.value
  } catch {
    entries.value = []
    totalEntries.value = 0
  }
  ledgerLoading.value = false
}

function onUpdateOptions(opts: any) {
  currentPage.value = (opts.page ?? 1) - 1
  pageSize.value = opts.itemsPerPage ?? 25
  fetchLedger()
}

// Contact search with debounce
watch(contactSearch, (q) => {
  if (contactDebounce) clearTimeout(contactDebounce)
  if (!q || q.length < 2) {
    contactItems.value = []
    return
  }
  contactDebounce = setTimeout(async () => {
    contactLoading.value = true
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, { params: { search: q, size: 10 } })
      contactItems.value = (data.contacts || []).map((c: any) => ({
        ...c,
        displayName: c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id,
      }))
    } catch { /* */ } finally {
      contactLoading.value = false
    }
  }, 300)
})

// Refetch ledger when filters change
watch([warehouseFilter, dateFrom, dateTo, contactFilter, eventTypeFilter], () => {
  currentPage.value = 0
  fetchLedger()
})

onMounted(() => {
  fetchProduct()
  fetchWarehouses()
  fetchStockData()
  fetchLedger()
})
</script>
