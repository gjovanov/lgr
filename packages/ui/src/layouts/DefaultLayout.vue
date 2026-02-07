<template>
  <v-app>
    <v-navigation-drawer v-model="appStore.leftDrawer" :rail="rail" permanent>
      <v-list-item :title="appStore.currentOrg?.name || 'Leger'" :subtitle="appStore.currentOrg?.slug" nav>
        <template #prepend>
          <v-icon color="primary">mdi-book-multiple</v-icon>
        </template>
        <template #append>
          <v-btn icon="mdi-chevron-left" variant="text" size="small" @click="rail = !rail" />
        </template>
      </v-list-item>
      <v-divider />
      <v-list density="compact" nav>
        <v-list-item prepend-icon="mdi-view-dashboard" :title="$t('nav.dashboard')" to="/dashboard" />

        <v-list-group value="accounting">
          <template #activator="{ props }"><v-list-item v-bind="props" prepend-icon="mdi-book-open-variant" :title="$t('nav.accounting')" /></template>
          <v-list-item :title="$t('nav.accounts')" to="/accounting/accounts" />
          <v-list-item :title="$t('nav.journalEntries')" to="/accounting/journal-entries" />
          <v-list-item :title="$t('nav.generalLedger')" to="/accounting/general-ledger" />
          <v-list-item :title="$t('nav.financialStatements')" to="/accounting/financial-statements" />
          <v-list-item :title="$t('nav.fixedAssets')" to="/accounting/fixed-assets" />
          <v-list-item :title="$t('nav.bankAccounts')" to="/accounting/bank-accounts" />
          <v-list-item :title="$t('nav.reconciliation')" to="/accounting/reconciliation" />
          <v-list-item :title="$t('nav.taxReturns')" to="/accounting/tax-returns" />
          <v-list-item :title="$t('nav.exchangeRates')" to="/accounting/exchange-rates" />
        </v-list-group>

        <v-list-group value="invoicing">
          <template #activator="{ props }"><v-list-item v-bind="props" prepend-icon="mdi-receipt" :title="$t('nav.invoicing')" /></template>
          <v-list-item :title="$t('nav.salesInvoices')" to="/invoicing/sales" />
          <v-list-item :title="$t('nav.purchaseInvoices')" to="/invoicing/purchases" />
          <v-list-item :title="$t('nav.proformaInvoices')" to="/invoicing/proforma" />
          <v-list-item :title="$t('nav.creditNotes')" to="/invoicing/credit-notes" />
          <v-list-item :title="$t('nav.paymentOrders')" to="/invoicing/payment-orders" />
          <v-list-item :title="$t('nav.cashOrders')" to="/invoicing/cash-orders" />
          <v-list-item :title="$t('nav.contacts')" to="/invoicing/contacts" />
        </v-list-group>

        <v-list-group value="warehouse">
          <template #activator="{ props }"><v-list-item v-bind="props" prepend-icon="mdi-warehouse" :title="$t('nav.warehouse')" /></template>
          <v-list-item :title="$t('nav.products')" to="/warehouse/products" />
          <v-list-item :title="$t('nav.warehouses')" to="/warehouse/warehouses" />
          <v-list-item :title="$t('nav.stockLevels')" to="/warehouse/stock-levels" />
          <v-list-item :title="$t('nav.stockMovements')" to="/warehouse/movements" />
          <v-list-item :title="$t('nav.inventoryCount')" to="/warehouse/inventory-count" />
          <v-list-item :title="$t('nav.priceLists')" to="/warehouse/price-lists" />
        </v-list-group>

        <v-list-group value="payroll">
          <template #activator="{ props }"><v-list-item v-bind="props" prepend-icon="mdi-currency-usd" :title="$t('nav.payroll')" /></template>
          <v-list-item :title="$t('nav.employees')" to="/payroll/employees" />
          <v-list-item :title="$t('nav.payrollRuns')" to="/payroll/runs" />
          <v-list-item :title="$t('nav.payslips')" to="/payroll/payslips" />
          <v-list-item :title="$t('nav.timesheets')" to="/payroll/timesheets" />
        </v-list-group>

        <v-list-group value="hr">
          <template #activator="{ props }"><v-list-item v-bind="props" prepend-icon="mdi-account-group" :title="$t('nav.hr')" /></template>
          <v-list-item :title="$t('nav.departments')" to="/hr/departments" />
          <v-list-item :title="$t('nav.leaveManagement')" to="/hr/leave-management" />
          <v-list-item :title="$t('nav.businessTrips')" to="/hr/business-trips" />
          <v-list-item :title="$t('nav.employeeDocuments')" to="/hr/documents" />
        </v-list-group>

        <v-list-group value="crm">
          <template #activator="{ props }"><v-list-item v-bind="props" prepend-icon="mdi-chart-line" :title="$t('nav.crm')" /></template>
          <v-list-item :title="$t('nav.leads')" to="/crm/leads" />
          <v-list-item :title="$t('nav.deals')" to="/crm/deals" />
          <v-list-item :title="$t('nav.activities')" to="/crm/activities" />
        </v-list-group>

        <v-list-group value="erp">
          <template #activator="{ props }"><v-list-item v-bind="props" prepend-icon="mdi-factory" :title="$t('nav.erp')" /></template>
          <v-list-item :title="$t('nav.bom')" to="/erp/bom" />
          <v-list-item :title="$t('nav.production')" to="/erp/production" />
          <v-list-item :title="$t('nav.construction')" to="/erp/construction" />
          <v-list-item :title="$t('nav.pos')" to="/erp/pos" />
        </v-list-group>

        <v-divider class="my-2" />

        <v-list-item prepend-icon="mdi-cog" :title="$t('nav.organization')" to="/settings/organization" />
        <v-list-item prepend-icon="mdi-account-cog" :title="$t('nav.users')" to="/settings/users" />
        <v-list-item prepend-icon="mdi-clipboard-text-clock" :title="$t('nav.auditLog')" to="/admin/audit-log" />
      </v-list>
    </v-navigation-drawer>

    <v-app-bar density="compact" flat>
      <v-app-bar-nav-icon @click="appStore.leftDrawer = !appStore.leftDrawer" />
      <v-toolbar-title class="text-body-1">{{ appStore.currentOrg?.name }}</v-toolbar-title>
      <v-spacer />

      <v-btn-group variant="text" density="compact">
        <v-btn v-for="loc in ['en', 'mk', 'de']" :key="loc" size="small" :color="appStore.locale === loc ? 'primary' : ''" @click="appStore.setLocale(loc)">
          {{ loc.toUpperCase() }}
        </v-btn>
      </v-btn-group>

      <v-btn icon variant="text" @click="appStore.toggleTheme">
        <v-icon>{{ appStore.isDark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}</v-icon>
      </v-btn>

      <notification-bell />

      <v-menu>
        <template #activator="{ props }">
          <v-btn v-bind="props" variant="text">
            <v-avatar size="32" color="primary" class="mr-2">
              <span class="text-caption text-white">{{ appStore.initials }}</span>
            </v-avatar>
            {{ appStore.fullName }}
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item prepend-icon="mdi-account" title="Profile" />
          <v-divider />
          <v-list-item prepend-icon="mdi-logout" :title="$t('auth.logout')" @click="handleLogout" />
        </v-list>
      </v-menu>
    </v-app-bar>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import NotificationBell from '../components/shared/NotificationBell.vue'

const appStore = useAppStore()
const router = useRouter()
const rail = ref(false)

function handleLogout() {
  appStore.logout()
  router.push({ name: 'auth.login' })
}
</script>
