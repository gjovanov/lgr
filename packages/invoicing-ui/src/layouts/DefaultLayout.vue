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
    @profile="() => {}"
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
    label: t('nav.outgoingDocs'),
    icon: 'mdi-file-export-outline',
    children: [
      // FR-01: invoices + credit/debit notes live in one merged grid.
      { label: t('nav.salesDocs'), icon: 'mdi-receipt-text-outline', to: '/invoices' },
      { label: t('nav.proforma'), icon: 'mdi-file-document-outline', to: '/proforma' },
    ],
  },
  {
    label: t('nav.orders'),
    icon: 'mdi-clipboard-list-outline',
    children: [
      { label: t('nav.internalOrders'), icon: 'mdi-account-clock-outline', to: '/internal-orders' },
      { label: t('nav.externalOrders'), icon: 'mdi-clipboard-list-outline', to: '/orders' },
      { label: t('nav.reservations'), icon: 'mdi-lock-clock', to: '/reservations' },
    ],
  },
  {
    label: t('nav.incomingDocs'),
    icon: 'mdi-file-import-outline',
    children: [
      { label: t('nav.purchaseDocs'), icon: 'mdi-receipt-text', to: '/bills' },
    ],
  },
  {
    label: t('nav.cashRegister'),
    icon: 'mdi-cash-register',
    children: [
      { label: t('invoicing.cashSales'), icon: 'mdi-cash-register', to: '/cash-sales' },
    ],
  },
  {
    label: t('nav.payments'),
    icon: 'mdi-bank-transfer',
    children: [
      { label: t('nav.paymentOrders'), icon: 'mdi-bank-transfer', to: '/payment-orders' },
      { label: t('nav.cashOrders'), icon: 'mdi-cash', to: '/cash-orders' },
    ],
  },
  {
    label: t('nav.reporting'),
    icon: 'mdi-file-chart',
    children: [
      { label: t('nav.agingReport'), icon: 'mdi-clock-alert-outline', to: '/aging-report' },
      { label: t('nav.export'), icon: 'mdi-download', to: '/reporting/export' },
    ],
  },
  {
    label: t('nav.configuration'),
    icon: 'mdi-cog-outline',
    children: [
      { label: t('nav.contacts'), icon: 'mdi-contacts', to: '/contacts' },
      { label: t('nav.sequences'), icon: 'mdi-numeric', to: '/configuration/sequences' },
    ],
  },
])

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  if (entry.appId === 'invoicing' && entry.routeName) {
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

function getTokenParams() {
  const token = localStorage.getItem('lgr_token') || ''
  const org = localStorage.getItem('lgr_org') || ''
  return `?token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}`
}

function handleAppNavigate(app: AppInfo) {
  const { hostname, port } = window.location
  const isViteDev = hostname === 'localhost' && port === '4021'
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
