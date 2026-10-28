<template>
  <AppShell
    layout="topmenu"
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
    @profile="openAccount"
  >
    <template #menu-bar>
      <TopMenuBar :menu-items="menuItems" />
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
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppShell from 'ui-shell/components/AppShell'
import { appHomeHref, portalHref } from 'ui-shared/nav/navigate'
import TopMenuBar from 'ui-shell/components/TopMenuBar'
import PendingChangesPanel from 'ui-shell/components/PendingChangesPanel'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import type { AppInfo } from 'ui-shell/components/types'
import type { PendingChangeEntry } from 'ui-shared/stores/pending-changes.types'
import type { TopMenuItem } from 'ui-shell/components/TopMenuBar'
import { APP_REGISTRY, type AppId } from 'config/constants'

const { t } = useI18n()
const appStore = useAppStore()
const pendingChangesStore = usePendingChangesStore()
const router = useRouter()
const apps = ref<AppInfo[]>([])
const pendingChangesOpen = ref(false)

const menuItems = computed<TopMenuItem[]>(() => [
  {
    label: t('accounting.accounts'),
    icon: 'mdi-chart-bar',
    children: [
      { label: t('nav.accounts'), icon: 'mdi-chart-bar', to: '/accounts' },
      { label: t('nav.journalEntries'), icon: 'mdi-book-open-variant', to: '/journal-entries' },
      { label: t('nav.generalLedger'), icon: 'mdi-book-multiple', to: '/general-ledger' },
      { label: t('nav.fiscalYears'), icon: 'mdi-calendar-range', to: '/fiscal-years' },
    ],
  },
  {
    label: t('nav.reporting'),
    icon: 'mdi-file-chart',
    children: [
      { label: t('nav.financialStatements'), icon: 'mdi-file-chart', to: '/financial-statements' },
      { label: t('nav.taxReturns'), icon: 'mdi-file-document', to: '/tax-returns' },
      { label: t('nav.journalAnalysis'), icon: 'mdi-chart-timeline-variant', to: '/journal-analysis' },
    ],
  },
  {
    label: t('nav.bankAccounts'),
    icon: 'mdi-bank',
    children: [
      { label: t('nav.bankAccounts'), icon: 'mdi-bank', to: '/bank-accounts' },
      { label: t('nav.reconciliation'), icon: 'mdi-bank-check', to: '/reconciliation' },
      { label: t('nav.exchangeRates'), icon: 'mdi-currency-usd', to: '/exchange-rates' },
    ],
  },
  {
    label: t('nav.fixedAssets'),
    icon: 'mdi-office-building',
    to: '/fixed-assets',
  },
])

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
    // /auth/me returns the JWT-shaped user (`id`, no `_id`) — fall back so the
    // pending-changes storage key stays stable and persist() actually writes.
    pendingChangesStore.load(appStore.currentOrg.id, (appStore.user as any)?._id || (appStore.user as any)?.id || '')
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

function handleAppNavigate(app: AppInfo) {
  window.location.href = appHomeHref(app)
}

function handlePortalNavigate() {
  window.location.href = portalHref('/apps')
}

/** The person's account page lives on the portal. */
function openAccount() {
  window.location.href = portalHref('/account')
}
</script>
