<template>
  <v-container fluid>
    <!-- Session Bar -->
    <v-card class="mb-4" v-if="!activeSession">
      <v-card-text class="d-flex align-center justify-space-between">
        <div>
          <h1 class="text-h5">{{ t('erp.pos') }}</h1>
          <p class="text-body-2 text-medium-emphasis">{{ t('erp.noActiveSession') }}</p>
        </div>
        <v-btn color="primary" @click="openSessionDialog = true">{{ t('erp.openSession') }}</v-btn>
      </v-card-text>
    </v-card>

    <!-- Active POS Terminal -->
    <template v-if="activeSession">
      <div class="d-flex align-center justify-space-between mb-4">
        <div>
          <h1 class="text-h5">{{ t('erp.pos') }}</h1>
          <span class="text-caption text-medium-emphasis">
            {{ t('erp.session') }}: {{ activeSession.sessionNumber }} | {{ t('erp.openedAt') }}: {{ activeSession.openedAt?.split('T')[0] }}
          </span>
        </div>
        <v-btn color="error" variant="outlined" @click="closeSessionDialog = true">{{ t('erp.closeSession') }}</v-btn>
      </div>

      <v-row>
        <!-- Product Search / Catalog -->
        <v-col cols="12" md="7">
          <v-card>
            <v-card-text>
              <v-text-field v-model="productSearch" prepend-inner-icon="mdi-magnify" :label="t('erp.searchProducts')" single-line hide-details clearable class="mb-4" autofocus />
              <v-row>
                <v-col v-for="product in filteredProducts" :key="product.productId" cols="6" sm="4" md="3">
                  <v-card variant="outlined" class="text-center pa-2 cursor-pointer" hover @click="addToCart(product)">
                    <v-icon size="32" class="mb-1">mdi-package-variant</v-icon>
                    <div class="text-caption">{{ product.productName }}</div>
                    <div class="text-body-2 font-weight-bold">{{ formatCurrency(product.unitPrice, currency, localeCode) }}</div>
                    <div v-if="product.stockAvailable !== null" class="text-caption text-medium-emphasis">{{ t('erp.stock') }}: {{ product.stockAvailable }}</div>
                  </v-card>
                </v-col>
                <v-col v-if="filteredProducts.length === 0" cols="12">
                  <div class="text-center text-disabled pa-8">{{ t('common.noData') }}</div>
                </v-col>
              </v-row>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- Cart -->
        <v-col cols="12" md="5">
          <v-card>
            <v-card-title>{{ t('erp.cart') }} ({{ cart.length }})</v-card-title>
            <v-card-text>
              <v-list v-if="cart.length > 0" density="compact">
                <v-list-item v-for="(item, idx) in cart" :key="idx">
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle>
                    {{ item.quantity }} x {{ formatCurrency(item.unitPrice, currency, localeCode) }}
                  </v-list-item-subtitle>
                  <template #prepend>
                    <div class="d-flex align-center mr-2">
                      <v-btn icon="mdi-minus" size="x-small" variant="text" @click="decrementQty(idx)" />
                      <span class="mx-1">{{ item.quantity }}</span>
                      <v-btn icon="mdi-plus" size="x-small" variant="text" @click="item.quantity++" />
                    </div>
                  </template>
                  <template #append>
                    <div class="d-flex align-center">
                      <span class="text-body-2 font-weight-bold mr-2">{{ formatCurrency(item.lineTotal, currency, localeCode) }}</span>
                      <PriceExplainButton v-if="item.priceExplanation?.length" :steps="item.priceExplanation" :currency="currency" />
                      <v-btn icon="mdi-close" size="x-small" variant="text" color="error" @click="cart.splice(idx, 1)" />
                    </div>
                  </template>
                </v-list-item>
              </v-list>
              <div v-else class="text-center text-disabled pa-8">{{ t('erp.emptyCart') }}</div>
            </v-card-text>
            <v-divider />
            <v-card-text>
              <div class="d-flex justify-space-between mb-1">
                <span>{{ t('erp.subtotal') }}</span>
                <span>{{ formatCurrency(subtotal, currency, localeCode) }}</span>
              </div>
              <div class="d-flex justify-space-between mb-1">
                <span>{{ t('erp.tax') }}</span>
                <span>{{ formatCurrency(taxAmount, currency, localeCode) }}</span>
              </div>
              <v-divider class="my-2" />
              <div class="d-flex justify-space-between text-h6">
                <span>{{ t('erp.total') }}</span>
                <span>{{ formatCurrency(total, currency, localeCode) }}</span>
              </div>
            </v-card-text>
            <v-card-text>
              <v-select v-model="paymentMethod" :label="t('erp.paymentMethod')" :items="paymentMethods" item-title="title" item-value="value" hide-details class="mb-4" />
              <v-btn color="success" size="large" block :disabled="cart.length === 0" :loading="store.loading" @click="completeSale">
                {{ t('erp.completeSale') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </template>

    <!-- Open Session Dialog -->
    <v-dialog v-model="openSessionDialog" max-width="450">
      <v-card>
        <v-card-title>{{ t('erp.openSession') }}</v-card-title>
        <v-card-text>
          <v-select
            v-model="sessionWarehouseId"
            :items="warehouses"
            item-title="name"
            item-value="id"
            :label="t('warehouse.warehouse')"
            :rules="[v => !!v || t('common.required')]"
            class="mb-2"
          />
          <v-text-field v-model.number="openingBalance" :label="t('erp.openingBalance')" type="number" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="openSessionDialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="store.loading" :disabled="!sessionWarehouseId" @click="doOpenSession">{{ t('erp.openSession') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Close Session Dialog -->
    <v-dialog v-model="closeSessionDialog" max-width="400">
      <v-card>
        <v-card-title>{{ t('erp.closeSession') }}</v-card-title>
        <v-card-text>
          <p class="mb-4">{{ t('erp.totalSales') }}: {{ formatCurrency(activeSession?.totalSales || 0, currency, localeCode) }}</p>
          <v-text-field v-model.number="closingBalance" :label="t('erp.closingBalance')" type="number" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="closeSessionDialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="store.loading" @click="doCloseSession">{{ t('erp.closeSession') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useERPStore, type POSSession } from '../../store/erp.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import PriceExplainButton from 'ui-shared/components/PriceExplainButton.vue'

interface PriceStep {
  type: 'base' | 'tag' | 'contact' | 'override'
  label: string
  price: number
}

interface CartItem {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  taxRate: number
  lineTotal: number
  taxAmount: number
  priceExplanation?: PriceStep[]
}

interface CatalogProduct {
  productId: string
  productName: string
  unitPrice: number
  taxRate: number
  barcode?: string
  sku?: string
  unit?: string
  stockAvailable: number | null
}

interface WarehouseItem {
  id: string
  name: string
  code: string
}

const { t } = useI18n()
const appStore = useAppStore()
const store = useERPStore()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const productSearch = ref('')
const cart = ref<CartItem[]>([])
const paymentMethod = ref('cash')
const openSessionDialog = ref(false)
const closeSessionDialog = ref(false)
const openingBalance = ref(0)
const closingBalance = ref(0)
const catalogProducts = ref<CatalogProduct[]>([])
const warehouses = ref<WarehouseItem[]>([])
const sessionWarehouseId = ref('')

const paymentMethods = [
  { title: 'Cash', value: 'cash' },
  { title: 'Card', value: 'card' },
  { title: 'Mobile', value: 'mobile' },
  { title: 'Voucher', value: 'voucher' },
]

const activeSession = computed<POSSession | null>(() => {
  return store.posSessions.find(s => s.status === 'open') || null
})

const filteredProducts = computed(() => {
  if (!productSearch.value) return catalogProducts.value
  const q = productSearch.value.toLowerCase()
  return catalogProducts.value.filter(p => p.productName.toLowerCase().includes(q))
})

// Per-line tax calculation from product taxRate
const subtotal = computed(() => cart.value.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0))
const taxAmount = computed(() => cart.value.reduce((sum, item) => {
  const lineBase = item.quantity * item.unitPrice
  return sum + Math.round(lineBase * (item.taxRate / 100) * 100) / 100
}, 0))
const total = computed(() => Math.round((subtotal.value + taxAmount.value) * 100) / 100)

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function addToCart(product: CatalogProduct) {
  const existing = cart.value.find(c => c.productId === product.productId)
  if (existing) {
    existing.quantity++
    recalcLine(existing)
  } else {
    const item: CartItem = {
      productId: product.productId,
      name: product.productName,
      quantity: 1,
      unitPrice: product.unitPrice,
      taxRate: product.taxRate,
      lineTotal: product.unitPrice,
      taxAmount: Math.round(product.unitPrice * (product.taxRate / 100) * 100) / 100,
      priceExplanation: [{ type: 'base', label: 'Selling price', price: product.unitPrice }],
    }
    cart.value.push(item)
  }
}

function recalcLine(item: CartItem) {
  const base = item.quantity * item.unitPrice
  item.taxAmount = Math.round(base * (item.taxRate / 100) * 100) / 100
  item.lineTotal = base + item.taxAmount
}

function decrementQty(idx: number) {
  if (cart.value[idx].quantity > 1) {
    cart.value[idx].quantity--
    recalcLine(cart.value[idx])
  } else {
    cart.value.splice(idx, 1)
  }
}

// Watch quantity changes to recalculate line totals
watch(cart, () => {
  for (const item of cart.value) recalcLine(item)
}, { deep: true })

async function doOpenSession() {
  if (!sessionWarehouseId.value) return
  try {
    await store.openPOSSession({
      warehouseId: sessionWarehouseId.value,
      openingBalance: openingBalance.value,
      currency: currency.value,
    })
    openSessionDialog.value = false
    showSuccess(t('common.savedSuccessfully'))
    await fetchCatalog()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doCloseSession() {
  if (!activeSession.value) return
  try {
    await store.closePOSSession(activeSession.value._id, { closingBalance: closingBalance.value })
    closeSessionDialog.value = false
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function completeSale() {
  if (cart.value.length === 0 || !activeSession.value) return
  try {
    const lines = cart.value.map(c => ({
      productId: c.productId,
      name: c.name,
      quantity: c.quantity,
      unitPrice: c.unitPrice,
      discount: 0,
      taxRate: c.taxRate,
      taxAmount: c.taxAmount,
      lineTotal: c.quantity * c.unitPrice,
    }))
    await store.createPOSTransaction(activeSession.value._id, {
      type: 'sale',
      lines,
      subtotal: subtotal.value,
      discountTotal: 0,
      taxTotal: taxAmount.value,
      total: total.value,
      payments: [{ method: paymentMethod.value as any, amount: total.value }],
      changeDue: 0,
    })
    cart.value = []
    showSuccess(t('common.completedSuccessfully'))
    // Refresh catalog to update stock levels
    await fetchCatalog()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function fetchCatalog() {
  try {
    const params: Record<string, string> = {}
    if (activeSession.value?.warehouseId) params.warehouseId = activeSession.value.warehouseId
    const { data } = await httpClient.get(`${orgUrl()}/erp/pos/catalog`, { params })
    catalogProducts.value = data.products || []
  } catch {
    catalogProducts.value = []
  }
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`, { params: { size: 0 } })
    warehouses.value = (data.warehouses || []).filter((w: any) => w.isActive !== false).map((w: any) => ({
      id: w.id || w._id,
      name: w.name,
      code: w.code,
    }))
  } catch {
    warehouses.value = []
  }
}

onMounted(async () => {
  await Promise.all([store.fetchPOSSessions(), fetchWarehouses()])
  if (activeSession.value) {
    await fetchCatalog()
  }
})
</script>
