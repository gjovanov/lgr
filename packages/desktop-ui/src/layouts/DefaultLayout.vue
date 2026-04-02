<template>
  <AppShell
    :org="appStore.currentOrg"
    :user="appStore.user"
    :apps="[]"
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
    @toggle-pending-changes="pendingChangesOpen = !pendingChangesOpen"
    @logout="appStore.logout()"
    @profile="() => {}"
  >
    <template #nav-items>
      <!-- Accounting -->
      <v-list-group value="accounting">
        <template #activator="{ props }">
          <v-list-item v-bind="props" prepend-icon="mdi-chart-bar" title="Accounting" />
        </template>
        <v-list-item prepend-icon="mdi-file-tree" title="Chart of Accounts" to="/accounting/accounts" density="compact" />
        <v-list-item prepend-icon="mdi-book-open-variant" title="Journal Entries" to="/accounting/journal-entries" density="compact" />
        <v-list-item prepend-icon="mdi-file-chart" title="Financial Statements" to="/accounting/financial-statements" density="compact" />
        <v-list-item prepend-icon="mdi-book-multiple" title="General Ledger" to="/accounting/general-ledger" density="compact" />
        <v-list-item prepend-icon="mdi-office-building" title="Fixed Assets" to="/accounting/fixed-assets" density="compact" />
        <v-list-item prepend-icon="mdi-bank" title="Bank Accounts" to="/accounting/bank-accounts" density="compact" />
        <v-list-item prepend-icon="mdi-bank-check" title="Reconciliation" to="/accounting/reconciliation" density="compact" />
        <v-list-item prepend-icon="mdi-file-document" title="Tax Returns" to="/accounting/tax-returns" density="compact" />
        <v-list-item prepend-icon="mdi-currency-usd" title="Exchange Rates" to="/accounting/exchange-rates" density="compact" />
      </v-list-group>

      <!-- Invoicing -->
      <v-list-group value="invoicing">
        <template #activator="{ props }">
          <v-list-item v-bind="props" prepend-icon="mdi-receipt-text" title="Invoicing" />
        </template>
        <v-list-item prepend-icon="mdi-contacts" title="Contacts" to="/invoicing/contacts" density="compact" />
        <v-list-item prepend-icon="mdi-receipt-text-outline" title="Sales Invoices" to="/invoicing/sales-invoices" density="compact" />
        <v-list-item prepend-icon="mdi-receipt-text" title="Purchase Invoices" to="/invoicing/purchase-invoices" density="compact" />
        <v-list-item prepend-icon="mdi-file-document-outline" title="Proforma Invoices" to="/invoicing/proforma-invoices" density="compact" />
        <v-list-item prepend-icon="mdi-file-undo" title="Credit Notes" to="/invoicing/credit-notes" density="compact" />
        <v-list-item prepend-icon="mdi-bank-transfer" title="Payment Orders" to="/invoicing/payment-orders" density="compact" />
        <v-list-item prepend-icon="mdi-cash-register" title="Cash Orders" to="/invoicing/cash-orders" density="compact" />
      </v-list-group>

      <!-- Warehouse -->
      <v-list-group value="warehouse">
        <template #activator="{ props }">
          <v-list-item v-bind="props" prepend-icon="mdi-package-variant" title="Warehouse" />
        </template>
        <v-list-item prepend-icon="mdi-package-variant" title="Products" to="/warehouse/products" density="compact" />
        <v-list-item prepend-icon="mdi-warehouse" title="Warehouses" to="/warehouse/warehouses" density="compact" />
        <v-list-item prepend-icon="mdi-chart-box" title="Stock Levels" to="/warehouse/stock-levels" density="compact" />
        <v-list-item prepend-icon="mdi-swap-horizontal" title="Movements" to="/warehouse/movements" density="compact" />
        <v-list-item prepend-icon="mdi-clipboard-check" title="Inventory Counts" to="/warehouse/inventory-counts" density="compact" />
        <v-list-item prepend-icon="mdi-tag-multiple" title="Price Lists" to="/warehouse/price-lists" density="compact" />
      </v-list-group>

      <!-- Payroll -->
      <v-list-group value="payroll">
        <template #activator="{ props }">
          <v-list-item v-bind="props" prepend-icon="mdi-cash-multiple" title="Payroll" />
        </template>
        <v-list-item prepend-icon="mdi-account-multiple" title="Employees" to="/payroll/employees" density="compact" />
        <v-list-item prepend-icon="mdi-cash-register" title="Payroll Runs" to="/payroll/runs" density="compact" />
        <v-list-item prepend-icon="mdi-file-document-outline" title="Payslips" to="/payroll/payslips" density="compact" />
        <v-list-item prepend-icon="mdi-clock-outline" title="Timesheets" to="/payroll/timesheets" density="compact" />
      </v-list-group>

      <!-- HR -->
      <!-- POS -->
      <v-list-item prepend-icon="mdi-cash-register" title="POS" to="/pos" />
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
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import type { PendingChangeEntry } from 'ui-shared/stores/pending-changes.types'

const appStore = useAppStore()
const pendingChangesStore = usePendingChangesStore()
const router = useRouter()
const pendingChangesOpen = ref(false)

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  // Desktop: all routes are local — always use router
  if (entry.routeName) {
    router.push({ name: entry.routeName, params: entry.routeParams, query: { restore: entry.id } })
  }
}

onMounted(async () => {
  if (!appStore.user && appStore.token) {
    await appStore.fetchProfile()
  }
  if (appStore.currentOrg?.id) {
    pendingChangesStore.load(appStore.currentOrg.id, appStore.user?._id || '')
  }
})
</script>
