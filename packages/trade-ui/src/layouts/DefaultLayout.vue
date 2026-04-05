<template>
  <AppShell
    :org="appStore.currentOrg"
    :user="appStore.user"
    :apps="apps"
    :notifications="[]"
    :unread-count="0"
    :is-dark="appStore.isDark"
    :locales="['en', 'mk', 'de', 'bg']"
    :current-locale="appStore.locale"
    :drawer-open="appStore.leftDrawer"
    :pending-changes-count="pendingChangesStore.count"
    @toggle-drawer="appStore.toggleDrawer()"
    @locale-change="appStore.setLocale($event)"
    @theme-toggle="appStore.toggleTheme()"
    @app-navigate="handleAppNavigate"
    @portal-navigate="handlePortalNavigate"
    @toggle-pending-changes="pendingChangesOpen = !pendingChangesOpen"
    @logout="appStore.logout()"
    @profile="() => {}"
  >
    <template #nav-items>
      <!-- Warehouse group -->
      <v-list-group value="warehouse">
        <template #activator="{ props }">
          <v-list-item v-bind="props" prepend-icon="mdi-package-variant" :title="$t('nav.warehouse')" />
        </template>
        <v-list-item prepend-icon="mdi-package-variant" :title="$t('nav.products')" to="/products" />
        <v-list-item prepend-icon="mdi-shape" :title="$t('nav.categories')" to="/categories" />
        <v-list-item prepend-icon="mdi-warehouse" :title="$t('nav.warehouses')" to="/warehouses" />
        <v-list-item prepend-icon="mdi-chart-box" :title="$t('nav.stockLevels')" to="/stock-levels" />
        <v-list-item prepend-icon="mdi-swap-horizontal" :title="$t('nav.stockMovements')" to="/movements" />
        <v-list-item prepend-icon="mdi-chart-areaspline" :title="$t('nav.inventoryValuation')" to="/inventory-valuation" />
        <v-list-item prepend-icon="mdi-clipboard-check" :title="$t('nav.inventoryCount')" to="/inventory-counts" />
        <v-list-item prepend-icon="mdi-tag-multiple" :title="$t('nav.priceLists')" to="/price-lists" />
        <v-list-item prepend-icon="mdi-percent" :title="$t('nav.bulkPricing')" to="/bulk-pricing" />
      </v-list-group>

      <!-- Invoicing group -->
      <v-list-group value="invoicing">
        <template #activator="{ props }">
          <v-list-item v-bind="props" prepend-icon="mdi-receipt-text" :title="$t('nav.invoicing')" />
        </template>
        <v-list-item prepend-icon="mdi-contacts" :title="$t('invoicing.contacts')" to="/contacts" />
        <v-list-item prepend-icon="mdi-receipt-text-outline" :title="$t('invoicing.salesInvoices')" to="/sales-invoices" />
        <v-list-item prepend-icon="mdi-cash-register" :title="$t('invoicing.cashSales')" to="/cash-sales" />
        <v-list-item prepend-icon="mdi-receipt-text" :title="$t('invoicing.purchaseInvoices')" to="/purchase-invoices" />
        <v-list-item prepend-icon="mdi-file-document-outline" :title="$t('invoicing.proformaInvoices')" to="/proforma-invoices" />
        <v-list-item prepend-icon="mdi-file-undo" :title="$t('invoicing.creditNotes')" to="/credit-notes" />
        <v-list-item prepend-icon="mdi-file-plus-outline" :title="$t('nav.debitNotes')" to="/debit-notes" />
        <v-list-item prepend-icon="mdi-bank-transfer" :title="$t('invoicing.paymentOrders')" to="/payment-orders" />
        <v-list-item prepend-icon="mdi-cash-register" :title="$t('invoicing.cashOrders')" to="/cash-orders" />
        <v-list-item prepend-icon="mdi-point-of-sale" :title="$t('invoicing.posTerminal')" to="/pos" />
        <v-list-item prepend-icon="mdi-receipt-text-check" title="POS Transactions" to="/pos-transactions" />
        <v-list-item prepend-icon="mdi-clock-outline" title="POS Sessions" to="/pos-sessions" />
        <v-list-item prepend-icon="mdi-printer-pos" title="POS Devices" to="/pos-devices" />
      </v-list-group>
    </template>

    <template #right-sidebar>
      <PendingChangesPanel
        v-model="pendingChangesOpen"
        :entries="pendingChangesStore.entries"
        @restore="handleRestore"
        @remove="pendingChangesStore.remove"
        @remove-all="pendingChangesStore.removeAll()"
      />
    </template>

    <router-view />
  </AppShell>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppShell from 'ui-shell/components/AppShell'
import PendingChangesPanel from 'ui-shell/components/PendingChangesPanel'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import type { AppInfo } from 'ui-shell/components/types'
import type { PendingChangeEntry } from 'ui-shared/stores/pending-changes.types'
import { APP_REGISTRY, type AppId } from 'config/constants'

const appStore = useAppStore()
const pendingChangesStore = usePendingChangesStore()
const router = useRouter()
const apps = ref<AppInfo[]>([])
const pendingChangesOpen = ref(false)

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  if (entry.appId === 'trade' && entry.routeName) {
    router.push({ name: entry.routeName, params: entry.routeParams, query: { restore: entry.id } })
  } else if (entry.routePath) {
    window.location.href = `/${entry.appId}${entry.routePath}?restore=${entry.id}`
  }
}

onMounted(async () => {
  if (!appStore.user && appStore.token) {
    await appStore.fetchProfile()
  }

  if (appStore.currentOrg?.id) {
    pendingChangesStore.load(appStore.currentOrg.id, appStore.user?._id || '')
    try {
      const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
      const { data } = await httpClient.get(`${portalBase}/org/${appStore.currentOrg.id}/apps`)
      apps.value = data.apps
    } catch {
      apps.value = (Object.keys(APP_REGISTRY) as AppId[]).map(id => ({
        id,
        ...APP_REGISTRY[id],
        enabled: false,
      }))
    }
  }
})

function getTokenParams() {
  const token = localStorage.getItem('lgr_token') || ''
  const org = localStorage.getItem('lgr_org') || ''
  return `?token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}`
}

function handleAppNavigate(app: AppInfo) {
  const { hostname, port } = window.location
  const isViteDev = hostname === 'localhost' && port === '4031'
  if (isViteDev && app.devPort) {
    window.location.href = `http://localhost:${app.devPort}${app.path}${getTokenParams()}`
  } else {
    window.location.href = app.path
  }
}

function handlePortalNavigate() {
  const { hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    window.location.href = `http://localhost:4001/apps${getTokenParams()}`
  } else {
    window.location.href = '/apps'
  }
}
</script>
