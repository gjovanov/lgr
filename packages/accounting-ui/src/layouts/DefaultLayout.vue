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
      <v-list-item prepend-icon="mdi-chart-bar" :title="$t('accounting.accounts')" to="/accounts" />
      <v-list-item prepend-icon="mdi-book-open-variant" :title="$t('accounting.journalEntries')" to="/journal-entries" />
      <v-list-item prepend-icon="mdi-file-chart" :title="$t('accounting.financialStatements')" to="/financial-statements" />
      <v-list-item prepend-icon="mdi-book-multiple" :title="$t('accounting.generalLedger')" to="/general-ledger" />
      <v-divider class="my-2" />
      <v-list-item prepend-icon="mdi-office-building" :title="$t('accounting.fixedAssets')" to="/fixed-assets" />
      <v-list-item prepend-icon="mdi-bank" :title="$t('accounting.bankAccounts')" to="/bank-accounts" />
      <v-list-item prepend-icon="mdi-bank-check" :title="$t('accounting.reconciliation')" to="/reconciliation" />
      <v-divider class="my-2" />
      <v-list-item prepend-icon="mdi-file-document" :title="$t('accounting.taxReturns')" to="/tax-returns" />
      <v-list-item prepend-icon="mdi-currency-usd" :title="$t('accounting.exchangeRates')" to="/exchange-rates" />
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
  if (entry.appId === 'accounting' && entry.routeName) {
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
      // Fallback: show all apps from registry
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
