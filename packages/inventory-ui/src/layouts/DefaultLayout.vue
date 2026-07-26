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
    label: t('nav.products'),
    icon: 'mdi-package-variant',
    children: [
      { label: t('nav.products'), icon: 'mdi-package-variant', to: '/products' },
      { label: t('nav.categories'), icon: 'mdi-shape', to: '/categories' },
    ],
  },
  {
    label: t('nav.warehouse'),
    icon: 'mdi-warehouse',
    children: [
      { label: t('nav.warehouses'), icon: 'mdi-warehouse', to: '/warehouses' },
      { label: t('nav.stockLevels'), icon: 'mdi-chart-box', to: '/stock-levels' },
      { label: t('nav.stockMovements'), icon: 'mdi-swap-horizontal', to: '/movements' },
      { label: t('nav.inventoryCount'), icon: 'mdi-clipboard-check', to: '/inventory-counts' },
      { label: t('nav.inventoryValuation'), icon: 'mdi-chart-areaspline', to: '/inventory-valuation' },
      { label: t('nav.openingStock'), icon: 'mdi-database-import-outline', to: '/opening-stock' },
    ],
  },
  {
    label: t('nav.priceLists'),
    icon: 'mdi-tag-multiple',
    children: [
      { label: t('nav.priceLists'), icon: 'mdi-tag-multiple', to: '/price-lists' },
      { label: t('nav.bulkPricing'), icon: 'mdi-percent', to: '/bulk-pricing' },
    ],
  },
])

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  if (entry.appId === 'inventory' && entry.routeName) {
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
