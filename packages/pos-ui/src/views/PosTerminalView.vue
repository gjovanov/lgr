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
            <v-chip v-else-if="fiscalBridge.status.value === 'reconnecting'" color="warning" size="small" prepend-icon="mdi-printer-search">
              {{ $t('common.reconnecting') || 'Reconnecting' }}...
            </v-chip>
            <!-- Held by another tab: sales here print through it, so there is nothing to connect. -->
            <v-tooltip v-else-if="connectedElsewhere" :text="$t('pos.bridge.connectedElsewhereHint')" location="bottom">
              <template #activator="{ props }">
                <v-chip v-bind="props" color="success" variant="tonal" size="small" prepend-icon="mdi-printer-check">
                  {{ $t('pos.bridge.connectedElsewhere', { device: connectedElsewhere.deviceNumber }) }}
                </v-chip>
              </template>
            </v-tooltip>
            <v-chip v-else-if="fiscalBridge.status.value === 'error'" color="error" size="small" prepend-icon="mdi-printer-alert" @click="connectFiscalPrinter">
              {{ $t('pos.printerError') }}
            </v-chip>
            <template v-else>
              <v-chip color="grey" size="small" prepend-icon="mdi-printer-off">
                {{ $t('pos.printerDisconnected') }}
              </v-chip>
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
                <v-col cols="12" sm="4">
                  <v-text-field ref="searchField" v-model="productSearch" prepend-inner-icon="mdi-magnify" :label="$t('pos.searchProducts')" single-line hide-details clearable autofocus @update:model-value="onSearchChange" @keydown.enter.prevent="onSearchEnter" />
                </v-col>
                <v-col cols="6" sm="2">
                  <v-select v-model="categoryFilter" :items="categoryOptions" :label="$t('warehouse.category')" clearable hide-details density="compact" @update:model-value="fetchCatalog(0)" />
                </v-col>
                <v-col cols="6" sm="2">
                  <v-select v-model="typeFilter" :items="typeOptions" :label="$t('common.type')" clearable hide-details density="compact" @update:model-value="fetchCatalog(0)" />
                </v-col>
                <v-col cols="12" sm="4">
                  <TagInput v-model="tagFilter" type="product" :org-url="appStore.orgUrl()" :label="$t('pos.filterByTags')" @update:model-value="fetchCatalog(0)" />
                </v-col>
              </v-row>
            </v-card-text>
            <v-card-text class="pt-0">
              <v-row>
                <v-col v-for="product in catalogProducts" :key="product.productId" cols="6" sm="4" md="3">
                  <v-card variant="outlined" class="text-center pa-2 cursor-pointer" hover @click="addToCart(product)">
                    <v-icon size="32" class="mb-1">mdi-package-variant</v-icon>
                    <div class="text-caption">{{ product.productName }}</div>
                    <div class="text-body-2 font-weight-bold">{{ fmt(product.unitPrice, 4) }}</div>
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
              <!-- FR-22.54: the sale just made stays on screen until the next article goes into
                   the cart: its number, what was paid, and what printed — or that nothing did. -->
              <v-alert
                v-if="lastSale"
                :type="lastSale.tone"
                variant="tonal"
                density="compact"
                data-testid="last-sale"
              >
                <div class="d-flex align-baseline justify-space-between flex-wrap ga-2">
                  <span class="font-weight-bold" data-testid="last-sale-number">{{ $t('pos.lastSale.title', { number: lastSale.number }) }}</span>
                  <span class="text-subtitle-1 font-weight-bold" data-testid="last-sale-total">{{ fmt(lastSale.total) }}</span>
                </div>
                <div class="text-body-2">
                  {{ lastSale.paidBy }}<template v-if="lastSale.change > 0"> · {{ $t('pos.lastSale.change', { amount: fmt(lastSale.change) }) }}</template>
                </div>
                <div v-if="lastSale.receipt" class="text-body-2" data-testid="last-sale-receipt">{{ lastSale.receipt }}</div>
                <div v-for="w in lastSale.warnings" :key="w" class="text-body-2 font-weight-medium">{{ w }}</div>
              </v-alert>
              <v-list v-if="cart.length > 0" density="compact">
                <v-list-item v-for="(item, idx) in cart" :key="idx" :data-testid="`cart-line-${idx}`">
                  <v-list-item-title>{{ item.name }}</v-list-item-title>
                  <v-list-item-subtitle class="d-flex align-center ga-1">
                    <span>{{ item.quantity }} x {{ fmt(item.unitPrice, 4) }}</span>
                    <span v-if="item.priceName" class="text-caption">({{ item.priceName }})</span>
                    <!-- #145: the same price dropdown as a sales-invoice line — every named price
                         of the product (selling price + the „Цена N" tiers). -->
                    <PriceSelectButton
                      :product-id="item.productId"
                      :quantity="item.quantity"
                      :org-url="orgUrl()"
                      :currency="currency"
                      @select="onLinePriceSelected(idx, $event)"
                    />
                  </v-list-item-subtitle>
                  <template #prepend>
                    <div class="d-flex align-center mr-2">
                      <v-btn icon="mdi-minus" size="x-small" variant="text" :aria-label="$t('pos.decreaseQty')" @click="decrementQty(idx)" />
                      <!-- #145: a large quantity is typed, not clicked. -->
                      <v-text-field
                        v-model.number="item.quantity"
                        type="number"
                        inputmode="decimal"
                        min="0"
                        hide-details
                        density="compact"
                        variant="outlined"
                        class="pos-qty mx-1"
                        :aria-label="$t('pos.quantity')"
                        data-testid="cart-qty"
                        @change="onQtyChange(idx)"
                        @focus="($event.target as HTMLInputElement)?.select()"
                      />
                      <v-btn icon="mdi-plus" size="x-small" variant="text" :aria-label="$t('pos.increaseQty')" @click="item.quantity = Number(item.quantity || 0) + 1" />
                    </div>
                  </template>
                  <template #append>
                    <span class="text-body-2 font-weight-bold mr-2">{{ fmt(item.quantity * item.unitPrice, 4) }}</span>
                    <v-btn icon="mdi-close" size="x-small" variant="text" color="error" :aria-label="$t('common.delete')" @click="cart.splice(idx, 1)" />
                  </template>
                </v-list-item>
              </v-list>
              <div v-else-if="!lastSale" class="text-center text-disabled pa-8">{{ $t('pos.emptyCart') }}</div>
            </v-card-text>
            <v-divider />
            <v-card-text>
              <div class="d-flex justify-space-between mb-1"><span>{{ $t('pos.subtotal') }}</span><span>{{ fmt(subtotal) }}</span></div>
              <div class="d-flex justify-space-between mb-1"><span>{{ $t('pos.tax') }}</span><span>{{ fmt(taxAmount) }}</span></div>
              <v-divider class="my-2" />
              <div class="d-flex justify-space-between text-h6"><span>{{ $t('pos.total') }}</span><span>{{ fmt(total) }}</span></div>
            </v-card-text>
            <v-card-text>
              <!-- #145: one price for the whole document — the named price every line switches
                   to (and every line added after). A product without that price keeps its own. -->
              <v-select
                v-model="docPriceName"
                :label="$t('pos.priceForAll')"
                :items="docPriceItems"
                item-title="title"
                item-value="value"
                :loading="docPriceLoading"
                :disabled="cart.length === 0 && !docPriceName"
                hide-details
                clearable
                class="mb-4"
                data-testid="doc-price"
                @update:menu="(open: boolean) => open && loadDocPriceNames()"
                @update:model-value="applyDocPrice"
              />
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

    <!-- More than one browser device is set up: the port the cashier just picked cannot tell
         us which record it is, so ask (a wrong pick would run the wrong protocol driver). -->
    <v-dialog v-model="deviceChooserOpen" max-width="480" persistent>
      <v-card>
        <v-card-title>{{ $t('pos.chooseFiscalDevice') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-2">{{ $t('pos.chooseFiscalDeviceHint') }}</p>
          <v-list density="compact">
            <v-list-item
              v-for="dev in deviceCandidates"
              :key="dev._id || dev.id"
              :title="dev.name"
              :subtitle="`${dev.deviceNumber} · ${dev.manufacturer}`"
              prepend-icon="mdi-printer-pos"
              @click="chooseDevice(dev)"
            />
          </v-list>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelDeviceChoice">{{ $t('common.cancel') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- FR-09 (#18): the real end-of-day close — expected vs counted per method, then the
         fiscal Z-report. Replaces a single-number dialog that never touched the device. -->
    <CloseSessionDialog
      v-if="activeSession"
      v-model="closeSessionDialog"
      :session-id="activeSession._id"
      :org-url="orgUrl()"
      :currency="activeSession.currency"
      :can-skip-fiscal="canSkipFiscal"
      @closed="onSessionClosed"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { computePosTotals } from 'config/pos-totals'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction, isOutcomeUnknown } from 'ui-shared/composables/idempotency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'
import { registerSwitchGuard } from 'ui-shared/session/switch-guards'
import TagInput from 'ui-shared/components/TagInput.vue'
import PriceSelectButton from 'ui-shared/components/PriceSelectButton.vue'
import { fetchPriceOptions, priceOptionLabel, type PriceOption } from 'ui-shared/composables/usePriceOptions'
import CloseSessionDialog from '../components/CloseSessionDialog.vue'
import { useFiscalBridgeAlerts } from '../composables/useFiscalBridgeAlerts'

/** `priceName`: the named price chosen for the line (#145), shown beside it; unset = selling price. */
interface CartItem { productId: string; name: string; quantity: number; unitPrice: number; taxRate: number; priceName?: string }
/** FR-22.54: the sale just completed, as the cart area shows it until the next article goes in. */
interface LastSale { number: string; total: number; change: number; paidBy: string; receipt: string; warnings: string[]; tone: 'success' | 'warning' }
interface CatalogProduct { productId: string; productName: string; unitPrice: number; taxRate: number; stockAvailable: number | null; type?: string; category?: string }
interface Session { _id: string; sessionNumber: string; warehouseId: string; openedAt: string; status: string; totalSales: number }
interface Warehouse { id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError, showSnackbar } = useSnackbar()
const fiscalBridge = useFiscalBridge()
useFiscalBridgeAlerts()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const loading = ref(false)
const productSearch = ref('')
const searchField = ref<{ focus: () => void } | null>(null)
const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
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
const lastSale = ref<LastSale | null>(null)
const openSessionDialog = ref(false)
const closeSessionDialog = ref(false)
const openingBalance = ref(0)
// FR-9.6: bypassing a configured fiscal device is a privileged decision. The server
// enforces it too; this only decides whether to offer the checkbox.
const canSkipFiscal = computed(() => ['admin', 'manager'].includes(appStore.user?.role || ''))
const catalogProducts = ref<CatalogProduct[]>([])
const warehouses = ref<Warehouse[]>([])
const sessionWarehouseId = ref('')
const sessions = ref<Session[]>([])
const nonFiscalMode = ref(localStorage.getItem('pos.nonFiscalMode') !== 'false')
watch(nonFiscalMode, (v) => localStorage.setItem('pos.nonFiscalMode', String(v)))
watch(() => fiscalBridge.status.value, async (val) => {
  if (val === 'error' && fiscalBridge.errorMessage.value) {
    showError(fiscalBridge.errorMessage.value)
    // Update device status in DB
    try {
      const { data } = await httpClient.get(`${orgUrl()}/fiscal/device`, { params: { isActive: 'true' } })
      const dev = (data.fiscalDevices || []).find((d: any) => d.connectionType === 'browser')
      if (dev) await httpClient.put(`${orgUrl()}/fiscal/device/${dev._id || dev.id}`, { status: 'error' })
    } catch {}
  }
  if (val === 'connected' && fiscalBridge.deviceNumber.value) {
    showSuccess(t('pos.printerConnected'))
    // Update device status in DB
    try {
      const { data } = await httpClient.get(`${orgUrl()}/fiscal/device`, { params: { isActive: 'true' } })
      const dev = (data.fiscalDevices || []).find((d: any) => d.connectionType === 'browser')
      if (dev) await httpClient.put(`${orgUrl()}/fiscal/device/${dev._id || dev.id}`, { status: 'online' })
    } catch {}
  }
})
let searchTimer: ReturnType<typeof setTimeout> | null = null

// #145: cash and card only. Mobile and voucher are no longer offered at the till; the server
// still accepts them, so transactions recorded with them before stay readable and reportable.
const paymentMethods = [
  { title: t('pos.cash'), value: 'cash' },
  { title: t('pos.card'), value: 'card' },
]

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function fmt(n: number, decimals = 2) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.value, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n) }

const activeSession = computed<Session | null>(() => sessions.value.find(s => s.status === 'open') || null)

function onSearchChange() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchCatalog(0), 300)
}

// The server validates with this same function and the receipt prints its numbers. Rounding
// VAT per line here once asked for 21.48 while the receipt said 21.47 with 0.01 change.
const totals = computed(() => computePosTotals(cart.value))
const subtotal = computed(() => totals.value.subtotal)
const taxAmount = computed(() => totals.value.taxTotal)
const total = computed(() => totals.value.total)

function addToCart(p: CatalogProduct) {
  // The next customer's first article: the last sale's result has been seen.
  lastSale.value = null
  const existing = cart.value.find(c => c.productId === p.productId)
  if (existing) { existing.quantity++ } else {
    cart.value.push({ productId: p.productId, name: p.productName, quantity: 1, unitPrice: p.unitPrice, taxRate: p.taxRate })
    // A document-wide price applies to lines added after it was chosen, too.
    if (docPriceName.value) void applyNamedPrice(cart.value.length - 1, docPriceName.value)
  }
}

function decrementQty(idx: number) {
  if (cart.value[idx].quantity > 1) cart.value[idx].quantity--
  else cart.value.splice(idx, 1)
}

/**
 * #145: a typed quantity. Decimals are allowed (metres, kilograms); an empty, negative or
 * non-numeric entry goes back to 1 rather than leaving a line the server would refuse — zero
 * removes the line, which is what the minus button does at 1.
 */
function onQtyChange(idx: number) {
  const line = cart.value[idx]
  if (!line) return
  const q = Number(line.quantity)
  if (q === 0) { cart.value.splice(idx, 1); return }
  line.quantity = Number.isFinite(q) && q > 0 ? Math.round(q * 1000) / 1000 : 1
}

// ── #145: choosing a price, per line or for the whole document ────────────────────────────
//
// The options are the product's own named prices (`/pricing/options?all=true`: the selling price
// and every „Цена N" tier). POS prices are NET, like those prices, so a chosen price drops
// straight into `unitPrice`; the fiscal receipt adds VAT as it does for any line.

/** The selling price is the one option with no name of its own; tiers match by name. */
const BASE_PRICE = '__base__'
const priceCache = new Map<string, PriceOption[]>()
async function optionsFor(productId: string): Promise<PriceOption[]> {
  if (!priceCache.has(productId)) {
    const res = await fetchPriceOptions(orgUrl(), productId, undefined, 1, true)
    priceCache.set(productId, res.options || [])
  }
  return priceCache.get(productId)!
}
function optionValue(o: PriceOption) { return o.type === 'base' ? BASE_PRICE : o.name }

function onLinePriceSelected(idx: number, opt: PriceOption) {
  const line = cart.value[idx]
  if (!line) return
  line.unitPrice = opt.price
  line.priceName = opt.type === 'base' ? undefined : opt.name
}

const docPriceName = ref<string | null>(null)
const docPriceLoading = ref(false)
const docPriceItems = ref<{ title: string; value: string }[]>([])

/** Every price name any line in the cart has — the choices for the whole document. */
async function loadDocPriceNames() {
  docPriceLoading.value = true
  try {
    const seen = new Map<string, string>()
    for (const line of cart.value) {
      for (const o of await optionsFor(line.productId)) {
        const v = optionValue(o)
        if (!seen.has(v)) seen.set(v, priceOptionLabel(o, t))
      }
    }
    docPriceItems.value = [...seen].map(([value, title]) => ({ value, title }))
  } finally {
    docPriceLoading.value = false
  }
}

/** Put line `idx` on the price called `name`. Returns false when the product has no such price. */
async function applyNamedPrice(idx: number, name: string): Promise<boolean> {
  const line = cart.value[idx]
  if (!line) return false
  const opt = (await optionsFor(line.productId)).find(o => optionValue(o) === name)
  if (!opt) return false
  onLinePriceSelected(idx, opt)
  return true
}

async function applyDocPrice(name: string | null) {
  if (!name) return // cleared: lines keep the prices they have
  let missing = 0
  for (let i = 0; i < cart.value.length; i++) {
    if (!(await applyNamedPrice(i, name))) missing++
  }
  // ⚠ Say so rather than leave a mixed basket looking uniform.
  if (missing) showSnackbar(t('pos.priceForAllMissing', { count: missing }), 'warning')
}

const deviceChooserOpen = ref(false)
const deviceCandidates = ref<any[]>([])

/**
 * The session warehouse's printer, when a bridge in ANOTHER tab (or on another computer)
 * holds it. Web Serial gives a port to one tab at a time, so this tab cannot connect. It
 * does not need to: the server prints every sale through whichever bridge holds the device.
 * Without this, the tab offered CONNECT PRINTER, and that could only fail with Chrome's bare
 * "Failed to open serial port".
 */
const connectedElsewhere = ref<{ deviceNumber: string; name: string } | null>(null)

async function refreshConnectedElsewhere() {
  if (!activeSession.value || fiscalBridge.status.value === 'connected') {
    connectedElsewhere.value = null
    return
  }
  if (document.hidden) return
  try {
    const { data } = await httpClient.get(`${orgUrl()}/fiscal/device`, {
      params: { isActive: 'true', size: 0, warehouseId: activeSession.value.warehouseId },
    })
    const dev = (data.fiscalDevices || []).find((d: any) => d.connected)
    connectedElsewhere.value = dev ? { deviceNumber: dev.deviceNumber, name: dev.name } : null
  } catch { /* keep the last known state */ }
}

// The other tab can close, or the printer can go off, at any time: re-check periodically,
// and at once when this tab comes back into view or its own bridge changes state.
let connectedElsewhereTimer: ReturnType<typeof setInterval> | undefined
function onVisibilityChange() { if (!document.hidden) refreshConnectedElsewhere() }
watch(() => [fiscalBridge.status.value, activeSession.value?._id], () => refreshConnectedElsewhere())

/**
 * The port picker must run first, straight from the click (Web Serial needs the user
 * gesture). Then work out which device record that port is: the session warehouse's browser
 * devices first, all of them otherwise — and ask when there is more than one, instead of
 * taking whichever sorts first (with a Tremol and an Eltrade both set up, that bound the
 * Eltrade's port to the Tremol driver).
 */
async function connectFiscalPrinter() {
  const ok = await fiscalBridge.requestPort()
  if (!ok) {
    if (fiscalBridge.errorCode.value === 'port_in_use') {
      await refreshConnectedElsewhere()
      showSnackbar(connectedElsewhere.value
        ? t('pos.bridge.inUseConnectedElsewhere', { device: connectedElsewhere.value.deviceNumber })
        : t('pos.bridge.portInUse'), 'warning', 15000)
    }
    return
  }
  try {
    const { data } = await httpClient.get(`${orgUrl()}/fiscal/device`, { params: { isActive: 'true', size: 0 } })
    const browserDevices = (data.fiscalDevices || []).filter((d: any) => d.connectionType === 'browser')
    const warehouseId = activeSession.value?.warehouseId
    const onWarehouse = warehouseId ? browserDevices.filter((d: any) => String(d.warehouseId) === String(warehouseId)) : []
    const candidates = onWarehouse.length ? onWarehouse : browserDevices
    if (!candidates.length) {
      await fiscalBridge.disconnect()
      showError(t('pos.noFiscalDevice'))
    } else if (candidates.length === 1) {
      await attachBridge(candidates[0])
    } else {
      deviceCandidates.value = candidates
      deviceChooserOpen.value = true
    }
  } catch (e: any) {
    await fiscalBridge.disconnect() // release the port, or the next attempt finds it "already open"
    showError(e.message || t('common.operationFailed'))
  }
}

async function attachBridge(dev: any) {
  const connected = await fiscalBridge.connect(appStore.currentOrg!.id, dev.deviceNumber, dev.warehouseId)
  if (connected) {
    showSuccess(t('pos.printerConnected'))
  } else {
    const reason = fiscalBridge.errorMessage.value
    await fiscalBridge.disconnect() // release the port so a retry can open it again
    showError(t('pos.connectFailed', { reason }))
  }
}

async function chooseDevice(dev: any) {
  deviceChooserOpen.value = false
  await attachBridge(dev)
}

async function cancelDeviceChoice() {
  deviceChooserOpen.value = false
  await fiscalBridge.disconnect() // release the port that was opened for it
}

async function fetchSessions() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/session`, { params: { size: 10, sortBy: 'openedAt', sortOrder: 'desc' } })
    sessions.value = data.sessions || []
  } catch { sessions.value = [] }
}

/** The grid's own parameters, besides the search: a code looked up on Enter is counted with them. */
function gridParams(): Record<string, any> {
  const params: Record<string, any> = {}
  if (activeSession.value?.warehouseId) params.warehouseId = activeSession.value.warehouseId
  if (categoryFilter.value) params.category = categoryFilter.value
  if (typeFilter.value) params.type = typeFilter.value
  if (tagFilter.value.length) params.tags = tagFilter.value.join(',')
  return params
}

/** Catalog requests made, and the newest of them whose answer is on screen. */
let catalogSeq = 0
let catalogShown = 0
/** The search text of the grid on screen, or of the request about to replace it. */
let gridSearch = ''

async function fetchCatalog(page = 0) {
  const seq = ++catalogSeq
  const search = productSearch.value || ''
  gridSearch = search
  catalogLoading.value = true
  try {
    const params: Record<string, any> = { page, size: 24, ...gridParams() }
    if (search) params.search = search
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/catalog`, { params })
    // An answer older than the one on screen (a debounced search answering after Enter has
    // added the article and cleared the search) must not put back a grid the cashier has left.
    if (seq < catalogShown) return
    catalogShown = seq
    catalogProducts.value = data.products || []
    catalogTotalPages.value = data.totalPages || 1
    catalogPage.value = (data.page || 0) + 1
  } catch {
    if (seq >= catalogShown) { catalogShown = seq; catalogProducts.value = [] }
  } finally {
    if (seq >= catalogShown) catalogLoading.value = false
  }
}

// ── FR-22.55: Enter adds the article the search names ─────────────────────────────────────────
//
// A barcode scanner types the code and presses Enter within milliseconds, before the 300 ms
// debounce has even filtered the grid, so the grid cannot say what was scanned: the server
// resolves the code (`/catalog/lookup`: the exact barcode, else the exact SKU, else the only
// article the search finds). Nothing unambiguous: nothing is added, the grid shows the search.
//
// Enters run in turn. A second scan typed while the first is still being looked up lands behind
// it in the search; the first takes only its own text out, so the second finds just its code.
let enterQueue: Promise<void> = Promise.resolve()
function onSearchEnter() {
  enterQueue = enterQueue.then(addTypedCode, addTypedCode)
}

async function addTypedCode() {
  const typed = productSearch.value || ''
  const code = typed.trim()
  if (!code || !activeSession.value) return
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
  let product: CatalogProduct | null = null
  try {
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/catalog/lookup`, { params: { ...gridParams(), code } })
    product = data?.product ?? null
  } catch { /* the grid is the answer */ }
  if (product) {
    addToCart(product)
    const now = productSearch.value || ''
    productSearch.value = now.startsWith(typed) ? now.slice(typed.length) : now
    searchField.value?.focus()
  }
  if ((productSearch.value || '') !== gridSearch) await fetchCatalog(0)
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

// #155: a retry of an attempt whose answer never arrived must not open a second session or
// ring the sale up twice. Each keeps its key until the server gives a definitive answer.
const openAttempt = createIdempotentAction()
const saleAttempt = createIdempotentAction()

async function doOpenSession() {
  if (!sessionWarehouseId.value) return
  loading.value = true
  const body = {
    warehouseId: sessionWarehouseId.value,
    openingBalance: openingBalance.value,
    currency: currency.value,
  }
  try {
    const { data } = await httpClient.post(`${orgUrl()}/trade/pos/session`, body, { headers: openAttempt.headers(body) })
    openAttempt.settle()
    sessions.value.unshift(data.session)
    openSessionDialog.value = false
    showSuccess(t('common.savedSuccessfully'))
    await fetchCatalog(0)
  } catch (e: any) {
    openAttempt.settle(e)
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
  finally { loading.value = false }
}

/**
 * FR-09: the close itself now lives in CloseSessionDialog (it owns the preview, the
 * per-method entry and the three fiscal outcomes). This only refreshes the session list
 * once the day is actually closed — a fiscal failure leaves the session open and never
 * reaches here.
 */
async function onSessionClosed() {
  lastSale.value = null
  await fetchSessions()
  showSuccess(t('pos.close.done'))
}

/**
 * What printed for a sale, in the words the cashier needs: the fiscal receipt and its УНП, a
 * non-fiscal text receipt, or plainly nothing (no fiscal device is connected to this till, as in
 * an org without one). No text when the receipt failed: the warning beside it says so and why.
 */
function receiptOutcome(txn: any, receiptError?: string): { text: string; printed: boolean } {
  if (receiptError) return { text: '', printed: false }
  if (txn?.fiscal?.state === 'printed' && txn.fiscal.mode === 'text') return { text: t('pos.lastSale.textReceipt'), printed: true }
  const fiscal = [
    txn?.fiscalReceiptNumber && t('pos.lastSale.fiscalReceipt', { number: txn.fiscalReceiptNumber }),
    txn?.unpNumber && t('pos.lastSale.unp', { unp: txn.unpNumber }),
  ].filter(Boolean)
  return fiscal.length ? { text: fiscal.join(' · '), printed: true } : { text: t('pos.lastSale.notPrinted'), printed: false }
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
    const body = {
      type: 'sale', lines,
      subtotal: subtotal.value, discountTotal: 0, taxTotal: taxAmount.value, total: total.value,
      payments: [{ method: paymentMethod.value, amount: total.value }], changeDue: 0,
      nonFiscal: nonFiscalMode.value,
    }
    let data: any
    try {
      ({ data } = await httpClient.post(`${orgUrl()}/trade/pos/session/${activeSession.value._id}/transaction`, body, { headers: saleAttempt.headers(body) }))
      saleAttempt.settle()
    } catch (e: any) {
      saleAttempt.settle(e)
      // The answer never came: the sale may have happened. Pressing Complete again sends the
      // same key and gets that sale back, rather than ringing the basket up a second time.
      if (isOutcomeUnknown(e)) throw Object.assign(e, { outcomeUnknown: true })
      throw e
    }
    cart.value = []
    // The next customer starts on each product's own price, not the last basket's choice.
    docPriceName.value = null
    // FR-22.54 (B-18): and on cash, with the cursor in an empty search — the method used to stay
    // on „card", so the next cash customer was booked as card, and the scanner typed into nowhere.
    paymentMethod.value = 'cash'
    productSearch.value = ''
    searchField.value?.focus()
    // The sale is recorded either way; a receipt that did not print, or stock that did not
    // move, must not look like success.
    const warnings = [
      data?.receiptError && t('pos.receiptNotPrinted', { reason: data.receiptError }),
      data?.stockError && t('pos.stockNotMoved', { reason: data.stockError }),
    ].filter(Boolean) as string[]
    const txn = data?.transaction ?? {}
    const receipt = receiptOutcome(txn, data?.receiptError)
    lastSale.value = {
      number: txn.transactionNumber || '',
      total: txn.total ?? body.total,
      change: txn.changeDue ?? 0,
      paidBy: (txn.payments ?? body.payments).map((p: any) => t(`pos.${p.method}`)).join(' + '),
      receipt: receipt.text,
      warnings,
      // A fiscal receipt was asked for („Нефискален" off) and nothing printed: not a clean success.
      tone: warnings.length || (!receipt.printed && !body.nonFiscal) ? 'warning' : 'success',
    }
    if (warnings.length) showSnackbar(warnings.join(' · '), 'warning', 15000)
    else showSuccess(t('pos.saleCompleted'))
    await fetchCatalog(0)
  } catch (e: any) {
    const refused = e?.response?.data
    // FR-20.49 — Прил. 29 т. 8: in the till's own language, saying what to check.
    if (refused?.code === 'fiscal_device_unreached') showError(t('pos.fiscalDeviceUnreached', { device: refused.deviceName || '' }))
    else showError(e?.outcomeUnknown ? t('pos.saleOutcomeUnknown') : (refused?.message || t('common.operationFailed')))
  }
  finally { loading.value = false }
}

let unregisterSwitchGuard: (() => void) | null = null

onMounted(async () => {
  // A sale in progress would be lost (or, mid-completion, half-done) if the org menu reloaded
  // this tab into another org.
  unregisterSwitchGuard = registerSwitchGuard(() => (cart.value.length > 0 || loading.value ? 'orgSwitcher.blockedSale' : null))
  document.addEventListener('visibilitychange', onVisibilityChange)
  connectedElsewhereTimer = setInterval(refreshConnectedElsewhere, 15000)
  await Promise.all([fetchSessions(), fetchWarehouses(), fetchCategories()])
  if (activeSession.value) await fetchCatalog()
})

onUnmounted(() => {
  unregisterSwitchGuard?.()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearInterval(connectedElsewhereTimer)
})
</script>

<style scoped>
/* #145: wide enough for a 5-digit quantity with decimals, narrow enough to keep the line on one row. */
.pos-qty {
  width: 84px;
  flex: 0 0 84px;
}
.pos-qty :deep(input) {
  text-align: center;
}
</style>
