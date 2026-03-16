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
    @toggle-drawer="appStore.toggleDrawer()"
    @locale-change="appStore.setLocale($event)"
    @theme-toggle="appStore.toggleTheme()"
    @app-navigate="handleAppNavigate"
    @portal-navigate="handlePortalNavigate"
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
        <v-list-item prepend-icon="mdi-warehouse" :title="$t('nav.warehouses')" to="/warehouses" />
        <v-list-item prepend-icon="mdi-chart-box" :title="$t('nav.stockLevels')" to="/stock-levels" />
        <v-list-item prepend-icon="mdi-swap-horizontal" :title="$t('nav.stockMovements')" to="/movements" />
        <v-list-item prepend-icon="mdi-clipboard-check" :title="$t('nav.inventoryCount')" to="/inventory-counts" />
        <v-list-item prepend-icon="mdi-tag-multiple" :title="$t('nav.priceLists')" to="/price-lists" />
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
        <v-list-item prepend-icon="mdi-bank-transfer" :title="$t('invoicing.paymentOrders')" to="/payment-orders" />
        <v-list-item prepend-icon="mdi-cash-register" :title="$t('invoicing.cashOrders')" to="/cash-orders" />
      </v-list-group>
    </template>

    <router-view />
  </AppShell>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AppShell from 'ui-shell/components/AppShell'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import type { AppInfo } from 'ui-shell/components/types'
import { APP_REGISTRY, type AppId } from 'config/constants'

const appStore = useAppStore()
const apps = ref<AppInfo[]>([])

onMounted(async () => {
  if (!appStore.user && appStore.token) {
    await appStore.fetchProfile()
  }

  if (appStore.currentOrg?.id) {
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
  const { hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    window.location.href = `http://localhost:${app.port}${getTokenParams()}`
  } else {
    window.location.href = `/${app.id}`
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
