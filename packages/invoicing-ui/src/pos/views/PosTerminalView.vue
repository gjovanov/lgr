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

      <!-- FR-21.29: the catalog, the cart and the totals are the one RegisterTerminal the back
           office sells through too; the till hands in its last sale and its payment. -->
      <RegisterTerminal
        ref="terminal"
        :org-url="orgUrl()"
        :currency="currency"
        :warehouse-id="activeSession.warehouseId"
        :active="!!activeSession"
        :lines="cart"
        :totals="totals"
        :line-gross="lineGross"
        :filters="{ type: true, tags: true }"
        @add="addToCart"
        @quantity="(idx: number, q: number) => { cart[idx].quantity = q }"
        @remove="(idx: number) => cart.splice(idx, 1)"
        @price="onLinePriceSelected"
      >
        <template #cart-top>
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
              <div v-else-if="!cart.length" class="text-center text-disabled pa-8">{{ $t('pos.emptyCart') }}</div>
        </template>
        <template #cart-actions>
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
              <v-alert v-if="saleBlocked" type="warning" variant="tonal" density="compact" class="mb-3" data-testid="printer-required">
                {{ warehouseHasDevice === false ? $t('pos.printerRequired.notConfigured') : $t('pos.printerRequired.notConnected') }}
              </v-alert>
              <v-btn color="success" size="large" block :disabled="cart.length === 0 || saleBlocked" :loading="loading" data-testid="complete-sale" @click="completeSale">
                {{ $t('pos.completeSale') }}
              </v-btn>
        </template>
      </RegisterTerminal>
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
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction, isOutcomeUnknown } from 'ui-shared/composables/idempotency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'
import { paymentMethodKey } from 'ui-shared/composables/usePaymentMethods'
import { registerSwitchGuard } from 'ui-shared/session/switch-guards'
import { jwtUserId } from 'ui-shared/composables/useStorageIdentity'
import RegisterTerminal from 'ui-shared/components/cash-register/RegisterTerminal.vue'
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
/** FR-21.29: the catalog, the cart and the totals (`ui-shared`), which the back office sells through too. */
const terminal = ref<{ reset: () => Promise<void>; refresh: () => Promise<void> } | null>(null)
const cart = ref<CartItem[]>([])
const paymentMethod = ref('cash')
const lastSale = ref<LastSale | null>(null)
const openSessionDialog = ref(false)
const closeSessionDialog = ref(false)
const openingBalance = ref(0)
// FR-9.6: bypassing a configured fiscal device is a privileged decision. The server
// enforces it too; this only decides whether to offer the checkbox.
const canSkipFiscal = computed(() => ['admin', 'manager'].includes(appStore.user?.role || ''))
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
// #145: mobile and voucher are no longer offered at the till; the server still accepts them, so
// transactions recorded with them before stay readable and reportable. Cash on delivery tenders
// exactly the total, which is what a sale sends for every method, and gives no change.
const paymentMethods = [
  { title: t('pos.cash'), value: 'cash' },
  { title: t('pos.card'), value: 'card' },
  { title: t('pos.cashOnDelivery'), value: 'cash_on_delivery' },
]

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function fmt(n: number, decimals = 2) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.value, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n) }

const activeSession = computed<Session | null>(() => sessions.value.find(s => s.status === 'open') || null)

// The server validates with this same function and the receipt prints its numbers. Rounding
// VAT per line here once asked for 21.48 while the receipt said 21.47 with 0.01 change.
const totals = computed(() => computePosTotals(cart.value))
const subtotal = computed(() => totals.value.subtotal)
const taxAmount = computed(() => totals.value.taxTotal)
const total = computed(() => totals.value.total)
/** A line's gross, as the device prints it (FR-21.30). */
const lineGross = (l: { quantity: number; unitPrice: number; taxRate?: number }) => computePosTotals([l]).total

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
/** Whether the session's warehouse has a device set up at all (null until asked). */
const warehouseHasDevice = ref<boolean | null>(null)

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
    const devices = data.fiscalDevices || []
    warehouseHasDevice.value = devices.length > 0
    const dev = devices.find((d: any) => d.connected)
    connectedElsewhere.value = dev ? { deviceNumber: dev.deviceNumber, name: dev.name } : null
  } catch { /* keep the last known state */ }
}

/**
 * No sale without a connected printer (2026-10-31), unless the org turned the rule off for having
 * no device. The device is this tab's, or held by another tab or the till's desktop, which the
 * server prints through — a text receipt needs it as much as a fiscal one. The server refuses the
 * sale regardless; this says so before the cart is filled.
 */
const printerRequired = computed(() => (appStore.currentOrg as any)?.settings?.cashRegister?.requireConnectedDevice !== false)
const saleBlocked = computed(() => printerRequired.value && fiscalBridge.status.value !== 'connected' && !connectedElsewhere.value)

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

/**
 * FR-21 R5 (owner, 2026-10-27): the terminal rings into the signed-in user's OWN session. It used to
 * take the first open session in the org, so cashier B sold into cashier A's drawer; the server now
 * refuses that (`session_not_yours`).
 */
async function fetchSessions() {
  try {
    const cashierId = appStore.user?.id || jwtUserId()
    const { data } = await httpClient.get(`${orgUrl()}/trade/pos/session`, {
      params: { size: 10, sortBy: 'openedAt', sortOrder: 'desc', ...(cashierId ? { cashierId } : {}) },
    })
    sessions.value = data.sessions || []
  } catch { sessions.value = [] }
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
    // The terminal appears with the session and loads its catalog itself.
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
    // An empty search, the cursor in it, and the catalog's stock figures after the sale.
    void terminal.value?.reset()
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
      paidBy: (txn.payments ?? body.payments).map((p: any) => t(paymentMethodKey(p.method))).join(' + '),
      receipt: receipt.text,
      warnings,
      // A fiscal receipt was asked for („Нефискален" off) and nothing printed: not a clean success.
      tone: warnings.length || (!receipt.printed && !body.nonFiscal) ? 'warning' : 'success',
    }
    if (warnings.length) showSnackbar(warnings.join(' · '), 'warning', 15000)
    else showSuccess(t('pos.saleCompleted'))
  } catch (e: any) {
    const refused = e?.response?.data
    // FR-20.49 — Прил. 29 т. 8: in the till's own language, saying what to check.
    if (refused?.code === 'fiscal_device_unreached') showError(t('pos.fiscalDeviceUnreached', { device: refused.deviceName || '' }))
    // Refused before anything was written: the basket is still there, for another method.
    else if (refused?.code === 'cod_not_supported') showError(t('pos.codNotSupported'))
    else if (refused?.code === 'fiscal_device_not_connected') {
      // The printer went away since the button was enabled: nothing was sold or numbered.
      warehouseHasDevice.value = !!refused.deviceConfigured
      showError(t(refused.deviceConfigured ? 'pos.printerRequired.notConnected' : 'pos.printerRequired.notConfigured'))
      refreshConnectedElsewhere()
    }
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
  await Promise.all([fetchSessions(), fetchWarehouses()])
})

onUnmounted(() => {
  unregisterSwitchGuard?.()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearInterval(connectedElsewhereTimer)
})
</script>
