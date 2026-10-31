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
    :pending-changes-count="manifest.pendingChanges ? pendingChangesStore.count : undefined"
    @toggle-drawer="appStore.toggleDrawer()"
    @locale-change="appStore.setLocale($event)"
    @theme-toggle="appStore.toggleTheme()"
    @app-navigate="handleAppNavigate"
    @portal-navigate="goTo(portalHref('/apps'))"
    @toggle-pending-changes="pendingChangesOpen = !pendingChangesOpen"
    @logout="appStore.logout()"
    @profile="goTo(portalHref('/account'))"
  >
    <template v-if="menuItems" #menu-bar>
      <TopMenuBar :menu-items="menuItems" />
    </template>

    <template v-if="manifest.pendingChanges" #right-sidebar>
      <PendingChangesPanel
        v-model="pendingChangesOpen"
        :entries="pendingChangesStore.entries"
        @restore="handleRestore"
        @remove="pendingChangesStore.remove"
        @remove-all="pendingChangesStore.removeAll()"
      />
    </template>

    <!-- FR-24.6: `viewKey` remounts the view when a page opens the same view it shows. -->
    <router-view :key="viewKey" />
  </AppShell>
</template>

<script setup lang="ts">
/**
 * FR-24.2: the one shell of a domain module, replacing the eight `DefaultLayout.vue` copies. What
 * differed between them is the manifest's: the menu (data, FR-24.3), and whether the module keeps
 * the Pending-changes panel. Every move goes through `goTo` (FR-24.5).
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppShell from './AppShell.vue'
import TopMenuBar, { type TopMenuItem, type TopMenuChild } from './TopMenuBar.vue'
import PendingChangesPanel from './PendingChangesPanel.vue'
import { appHomeHref, goTo, portalHref } from 'ui-shared/nav/navigate'
import { inModule, pendingRestoreUrl, routerAppId, spaOf, viewKey } from 'ui-shared/nav/open-page'
import { useAppStore } from 'ui-shared/stores/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import type { PendingChangeEntry } from 'ui-shared/stores/pending-changes.types'
import { APP_REGISTRY, type AppId } from 'config/constants'
import type { AppInfo } from './types'
import type { ModuleManifest, ModuleMenuItem } from '../module'

const props = defineProps<{ manifest: ModuleManifest }>()

const { t } = useI18n()
const appStore = useAppStore()
const pendingChangesStore = usePendingChangesStore()
const route = useRoute()
const router = useRouter()
const apps = ref<AppInfo[]>([])
const pendingChangesOpen = ref(false)

function child(item: ModuleMenuItem): TopMenuChild {
  return {
    label: t(item.labelKey),
    ...(item.subtitleKey ? { subtitle: t(item.subtitleKey) } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.to ? { to: inModule(route, item.to) } : {}),
  } as TopMenuChild
}

const menuItems = computed<TopMenuItem[] | null>(() => {
  if (!props.manifest.menu) return null
  const shown = (items: ModuleMenuItem[]) => items.filter(i => !i.when || i.when())
  return shown(props.manifest.menu).map(item => ({
    label: t(item.labelKey),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.to ? { to: inModule(route, item.to) } : {}),
    ...(item.children ? { children: shown(item.children).map(child) } : {}),
  }))
})

/** This SPA's app id, from the router's base: a restore made in it reopens with a router push. */
const spaId = routerAppId(router.options.history.base)

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  if (entry.routeName && spaOf(entry.appId) === spaId && router.hasRoute(entry.routeName)) {
    router.push({ name: entry.routeName, params: entry.routeParams, query: { restore: entry.id } })
    return
  }
  const url = pendingRestoreUrl(entry)
  if (url) goTo(url)
}

function handleAppNavigate(app: AppInfo) {
  goTo(appHomeHref(app))
}

onMounted(async () => {
  if (!appStore.user && appStore.token) {
    await appStore.fetchProfile()
  }
  if (appStore.currentOrg?.id) {
    if (props.manifest.pendingChanges) {
      // /auth/me returns the JWT-shaped user (`id`, no `_id`) — fall back so the
      // pending-changes storage key stays stable and persist() actually writes.
      pendingChangesStore.load(appStore.currentOrg.id, (appStore.user as any)?._id || (appStore.user as any)?.id || '')
    }
    try {
      const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : ''
      const { data } = await httpClient.get(`${portalBase}/org/${appStore.currentOrg.id}/apps`)
      apps.value = data.apps
    } catch {
      apps.value = (Object.keys(APP_REGISTRY) as AppId[]).map(id => ({ id, ...APP_REGISTRY[id], enabled: false }))
    }
  }
})
</script>
