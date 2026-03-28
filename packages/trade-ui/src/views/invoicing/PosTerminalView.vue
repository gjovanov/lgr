<template>
  <v-container fluid>
    <!-- Session Bar -->
    <v-card class="mb-4" v-if="!activeSession">
      <v-card-text class="d-flex align-center justify-space-between">
        <div>
          <h1 class="text-h5">{{ $t('invoicing.posTerminal') }}</h1>
          <p class="text-body-2 text-medium-emphasis">{{ $t('pos.noActiveSession') }}</p>
        </div>
        <v-btn color="primary" @click="openSessionDialog = true">{{ $t('pos.openSession') }}</v-btn>
      </v-card-text>
    </v-card>

    <!-- Active POS Terminal -->
    <template v-if="activeSession">
      <div class="d-flex align-center justify-space-between mb-4">
        <div>
          <h1 class="text-h5">{{ $t('invoicing.posTerminal') }}</h1>
          <span class="text-caption text-medium-emphasis">
            {{ $t('pos.session') }}: {{ activeSession.sessionNumber }} | {{ activeSession.openedAt?.split('T')[0] }}
          </span>
        </div>
        <div class="d-flex align-center ga-3">
          <!-- Non-Fiscal Mode Toggle -->
          <v-switch
            v-model="nonFiscalMode"
            :label="$t('pos.nonFiscalMode')"
            color="warning"
            density="compact"
            hide-details
            class="flex-grow-0"
          />
          <!-- Fiscal Bridge Status -->
          <template v-if="fiscalBridge.isSupported">
            <v-chip v-if="fiscalBridge.status.value === 'connected'" color="success" size="small" prepend-icon="mdi-printer-check">
              {{ fiscalBridge.deviceNumber.value }}
            </v-chip>
            <v-chip v-else-if="fiscalBridge.status.value === 'connecting'" color="warning" size="small" prepend-icon="mdi-printer-search">
              {{ $t('common.connecting') }}...
            </v-chip>
            <v-chip v-else-if="fiscalBridge.status.value === 'error'" color="error" size="small" prepend-icon="mdi-printer-alert" @click="connectFiscalPrinter">
              {{ $t('pos.printerError') }}
            </v-chip>
            <template v-else>
              <v-select v-model="fiscalBridge.selectedBaudRate.value" :items="fiscalBridge.baudRateOptions" density="compact" variant="outlined" hide-details style="max-width: 120px" />
              <v-btn variant="outlined" size="small" prepend-icon="mdi-printer" @click="connectFiscalPrinter">
                {{ $t('pos.connectPrinter') }}
              </v-btn>
            </template>
          </template>
          <v-btn color="error" variant="outlined" @click="closeSessionDialog = true">{{ $t('pos.closeSession') }}</v-btn>
        </div>
      </div>

      <v-row>
        <!-- Product Catalog -->
        <v-col cols="12" md="7">
          <v-card>
            <v-card-text class="pb-2">
              <v-row dense>
                <v-col cols="12" sm="6">
                  <v-text-field v-model="productSearch" prepend-inner-icon="mdi-magnify" :label="$t('pos.searchProducts')" single-line hide-details clearable autofocus @update:model-value="onSearchChange" />
                </v-col>
                <v-col cols="6" sm="3">
                  <v-select v-model="categoryFilter" :items="categoryOptions" :label="$t('warehouse.category')" clearable hide-details density="compact" @update:model-value="fetchCatalog(0)" />
                </v-col>
                <v-col cols="6" sm="3">
                  <v-select v-model="typeFilter" :items="typeOptions" :label="$t('warehouse.type')" clearable hide-details density="compact" @update:model-value="fetchCatalog(0)" />
                </v-col>
              </v-row>
            </v-card-text>
            <v-card-text class="pt-0">
              <v-row>
                <v-col v-for="product in catalogProducts" :key="product.productId" cols="6" sm="4" md="3">
                  <v-card variant="outlined" class="text-center pa-2 cursor-pointer" hover @click="addToCart(product)">
                    <v-icon size="32" class="mb-1">mdi-package-variant</v-icon>
                    <div class="text-caption">{{ product.productName }}</div>
                    <div class="text-body-2 font-weight-bold">{{ fmt(product.unitPrice) }}</div>
                    <div v-if="product.stockAvailable !== null" class="text-caption text-medium-emphasis">{{ $t('pos.stock') }}: {{ product.stockAvailable }}</div>
                  </v-card>
                </v-col>
                <v-col v-if="catalogProducts.length === 0 && !catalogLoading" cols="12">
                  <div class="text-center text-disabled pa-8">{{ $t('common.noData') }}</div>
                </v-col>
              </v-row>
              <div v-if="catalogTotalPages > 1" class="d-flex justify-center mt-4">
                <v-pagination v-model="catalogPage" :length="catalogTotalPages" :total-visible="5" density="compact" @update:model-value="(p: number) => fetchCatalog(p - 1)" />
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- Cart -->
        <v-col cols="12" md="5">
          <v-card>
            <v-card-title>{{ $t('pos.cart') }} ({{ cart.length }})</v-card-title>
            <v-card-text>
              <v-list v-if="cart.length > 0" density="compact">
                <v-list-item v-for="(item, idx) in cart" :key="idx">
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>{{ item.quantity }} x {{ fmt(item.unitPrice) }}</v-list-item-subtitle>
                  <template #prepend>
                    <div class="d-flex align-center mr-2">
                      <v-btn icon="mdi-minus" size="x-small" variant="text" @click="decrementQty(idx)" />
                      <span class="mx-1">{{ item.quantity }}</span>
                      <v-btn icon="mdi-plus" size="x-small" variant="text" @click="item.quantity++" />
                    </div>
                  </template>
                  <template #append>
                    <span class="text-body-2 font-weight-bold mr-2">{{ fmt(item.quantity * item.unitPrice) }}</span>
                    <v-btn icon="mdi-close" size="x-small" variant="text" color="error" @click="cart.splice(idx, 1)" />
                  </template>
                </v-list-item>
              </v-list>
              <div v-else class="text-center text-disabled pa-8">{{ $t('pos.emptyCart') }}</div>
            </v-card-text>
            <v-divider />
            <v-card-text>
              <div class="d-flex justify-space-between mb-1"><span>{{ $t('pos.subtotal') }}</span><span>{{ fmt(subtotal) }}</span></div>
              <div class="d-flex justify-space-between mb-1"><span>{{ $t('pos.tax') }}</span><span>{{ fmt(taxAmount) }}</span></div>
              <v-divider class="my-2" />
              <div class="d-flex justify-space-between text-h6"><span>{{ $t('pos.total') }}</span><span>{{ fmt(total) }}</span></div>
            </v-card-text>
            <v-card-text>
              <v-select v-model="paymentMethod" :label="$t('pos.paymentMethod')" :items="paymentMethods" item-title="title" item-value="value" hide-details class="mb-4" />
              <v-btn color="success" size="large" block :disabled="cart.length === 0" :loading="loading" @click="completeSale">
                {{ $t('pos.completeSale') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </template>

    <!-- Open Session Dialog -->
    <v-dialog v-model="openSessionDialog" max-width="450">
      <v-card>
        <v-card-title>{{ $t('pos.openSession') }}</v-card-title>
        <v-card-text>
          <v-select v-model="sessionWarehouseId" :items="warehouses" item-title="name" item-value="id" :label="$t('warehouse.warehouse')" class="mb-2" />
          <v-text-field v-model.number="openingBalance" :label="$t('pos.openingBalance')" type="number" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="openSessionDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" :disabled="!sessionWarehouseId" @click="doOpenSession">{{ $t('pos.openSession') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Close Session Dialog -->
    <v-dialog v-model="closeSessionDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('pos.closeSession') }}</v-card-title>
        <v-card-text>
          <p class="mb-4">{{ $t('pos.totalSales') }}: {{ fmt(activeSession?.totalSales || 0) }}</p>
          <v-text-field v-model.number="closingBalance" :label="$t('pos.closingBalance')" type="number" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="closeSessionDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="loading" @click="doCloseSession">{{ $t('pos.closeSession') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'

interface CartItem { productId: string; name: string; quantity: number; unitPrice: number; taxRate: number }
interface CatalogProduct { productId: string; productName: string; unitPrice: number; taxRate: number; stockAvailable: number | null; type?: string; category?: string }
interface Session { _id: string; sessionNumber: string; warehouseId: string; openedAt: string; status: string; totalSales: number }
interface Warehouse { id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const fiscalBridge = useFiscalBridge()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const loading = ref(false)
const productSearch = ref('')
const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const categoryOptions = ref<{ title: string; value: string }[]>([])
const typeOptions = [
  { title: t('warehouse.goods'), value: 'goods' },
  { title: t('warehouse.service'), value: 'service' },
]
const catalogPage = ref(1)
const catalogTotalPages = ref(1)
const catalogLoading = ref(false)
const cart = ref<CartItem[]>([])
const paymentMethod = ref('cash')
const openSessionDialog = ref(false)
const closeSessionDialog = ref(false)
const openingBalance = ref(0)
const closingBalance = ref(0)
const catalogProducts = ref<CatalogProduct[]>([])
const warehouses = ref<Warehouse[]>([])
const sessionWarehouseId = ref('')
const sessions = ref<Session[]>([])
const nonFiscalMode = ref(localStorage.getItem('pos.nonFiscalMode') !== 'false')
watch(nonFiscalMode, (v) => localStorage.setItem('pos.nonFiscalMode', String(v)))
watch(() => fiscalBridge.status.value, (val) => {
  if (val === 'error' && fiscalBridge.errorMessage.value) showError(fiscalBridge.errorMessage.value)
})
let searchTimer: ReturnType<typeof setTimeout> | null = null

const paymentMethods = [
  { title: t('pos.cash'), value: 'cash' },
  { title: t('pos.card'), value: 'card' },
  { title: t('pos.mobile'), value: 'mobile' },
  { title: t('pos.voucher'), value: 'voucher' },
]

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function fmt(n: number) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.value }).format(n) }

const activeSession = computed<Session | null>(() => sessions.value.find(s => s.status === 'open') || null)

function onSearchChange() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchCatalog(0), 300)
}

const subtotal = computed(() => cart.value.reduce((s, i) => s + i.quantity * i.unitPrice, 0))
const taxAmount = computed(() => cart.value.reduce((s, i) => s + Math.round(i.quantity * i.unitPrice * (i.taxRate / 100) * 100) / 100, 0))
const total = computed(() => Math.round((subtotal.value + taxAmount.value) * 100) / 100)

function addToCart(p: CatalogProduct) {
  const existing = cart.value.find(c => c.productId === p.productId)
  if (existing) { existing.quantity++ } else {
    cart.value.push({ productId: p.productId, name: p.productName, quantity: 1, unitPrice: p.unitPrice, taxRate: p.taxRate })
  }
}

function decrementQty(idx: number) {
  if (cart.value[idx].quantity > 1) cart.value[idx].quantity--
  else cart.value.splice(idx, 1)
}

async function connectFiscalPrinter() {
  const ok = await fiscalBridge.requestPort()
  if (!ok) return
  try {
    const { data } = await httpClient.get(`${orgUrl()}/fiscal/device`, { params: { isActive: 'true' } })
    const dev = (data.fiscalDevices || []).find((d: any) => d.connectionType === 'browser')
    if (dev) {
      await fiscalBridge.connect(appStore.currentOrg!.id, dev.deviceNumber, dev.warehouseId)
      showSuccess(t('pos.printerConnected'))
    } else {
      showError(t('pos.noFiscalDevice'))
    }
  } catch (e: any) { showError(e.message || t('common.operationFailed')) }
}

async function fetchSessions() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/session`, { params: { size: 10, sortBy: 'openedAt', sortOrder: 'desc' } })
    sessions.value = data.sessions || []
  } catch { sessions.value = [] }
}

async function fetchCatalog(page = 0) {
  catalogLoading.value = true
  try {
    const params: Record<string, any> = { page, size: 24 }
    if (activeSession.value?.warehouseId) params.warehouseId = activeSession.value.warehouseId
    if (productSearch.value) params.search = productSearch.value
    if (categoryFilter.value) params.category = categoryFilter.value
    if (typeFilter.value) params.type = typeFilter.value
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/catalog`, { params })
    catalogProducts.value = data.products || []
    catalogTotalPages.value = data.totalPages || 1
    catalogPage.value = (data.page || 0) + 1
  } catch { catalogProducts.value = [] }
  finally { catalogLoading.value = false }
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/product-category`, { params: { size: 0 } })
    const cats = data.productCategories || data.categories || []
    categoryOptions.value = cats.map((c: any) => ({ title: c.name, value: c.id || c._id }))
  } catch { categoryOptions.value = [] }
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`, { params: { size: 0 } })
    warehouses.value = (data.warehouses || []).filter((w: any) => w.isActive !== false).map((w: any) => ({ id: w.id || w._id, name: w.name }))
  } catch { warehouses.value = [] }
}

async function doOpenSession() {
  if (!sessionWarehouseId.value) return
  loading.value = true
  try {
    const { data } = await httpClient.post(`${orgUrl()}/trade/pos/session`, {
      warehouseId: sessionWarehouseId.value,
      openingBalance: openingBalance.value,
      currency: currency.value,
    })
    sessions.value.unshift(data.session)
    openSessionDialog.value = false
    showSuccess(t('common.savedSuccessfully'))
    await fetchCatalog(0)
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) }
  finally { loading.value = false }
}

async function doCloseSession() {
  if (!activeSession.value) return
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/trade/pos/session/${activeSession.value._id}/close`, { closingBalance: closingBalance.value })
    await fetchSessions()
    closeSessionDialog.value = false
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) }
  finally { loading.value = false }
}

async function completeSale() {
  if (cart.value.length === 0 || !activeSession.value) return
  loading.value = true
  try {
    const lines = cart.value.map(c => ({
      productId: c.productId, name: c.name, quantity: c.quantity, unitPrice: c.unitPrice,
      discount: 0, taxRate: c.taxRate,
      taxAmount: Math.round(c.quantity * c.unitPrice * (c.taxRate / 100) * 100) / 100,
      lineTotal: c.quantity * c.unitPrice,
    }))
    await httpClient.post(`${orgUrl()}/trade/pos/session/${activeSession.value._id}/transaction`, {
      type: 'sale', lines,
      subtotal: subtotal.value, discountTotal: 0, taxTotal: taxAmount.value, total: total.value,
      payments: [{ method: paymentMethod.value, amount: total.value }], changeDue: 0,
      nonFiscal: nonFiscalMode.value,
    })
    cart.value = []
    showSuccess(t('pos.saleCompleted'))
    await fetchCatalog(0)
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) }
  finally { loading.value = false }
}

onMounted(async () => {
  await Promise.all([fetchSessions(), fetchWarehouses(), fetchCategories()])
  if (activeSession.value) await fetchCatalog()
})
</script>
