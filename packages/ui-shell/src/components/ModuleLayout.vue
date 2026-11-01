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

    <!-- FR-24.17: this tab holds a printer. The chip only reads the bridge's status. -->
    <v-chip
      v-if="bridge.status.value !== 'disconnected'"
      class="lgr-bridge-chip"
      size="small"
      :color="bridge.status.value === 'connected' ? 'success' : bridge.status.value === 'error' ? 'error' : 'warning'"
      prepend-icon="mdi-printer-pos"
      :title="bridge.status.value"
      data-testid="shell-bridge-chip"
    >{{ bridge.deviceNumber.value || bridge.status.value }}</v-chip>

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
import { inModule, pendingRestoreUrl, viewKey } from 'ui-shared/nav/open-page'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'
import { useFiscalBridgeAlerts } from 'ui-shared/composables/useFiscalBridgeAlerts'
import { useAppStore } from 'ui-shared/stores/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { jwtUserId, sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import type { PendingChangeEntry } from 'ui-shared/stores/pending-changes.types'
import { APP_REGISTRY, type AppId } from 'config/constants'
import type { AppInfo } from './types'
import { visibleMenu, type ModuleManifest, type ModuleMenuItem } from '../module'

const props = defineProps<{ manifest: ModuleManifest }>()

const { t } = useI18n()
const appStore = useAppStore()
const pendingChangesStore = usePendingChangesStore()
const route = useRoute()
const router = useRouter()
const apps = ref<AppInfo[]>([])
const pendingChangesOpen = ref(false)
const bridge = useFiscalBridge()
useFiscalBridgeAlerts()

function child(item: ModuleMenuItem): TopMenuChild {
  if (item.divider) return { label: '', divider: true }
  return {
    label: t(item.labelKey),
    ...(item.subtitleKey ? { subtitle: t(item.subtitleKey) } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.to ? { to: inModule(route, item.to) } : {}),
  } as TopMenuChild
}

const menuItems = computed<TopMenuItem[] | null>(() => {
  if (!props.manifest.menu) return null
  return visibleMenu(props.manifest.menu, sessionViewer()).map(item => ({
    label: t(item.labelKey),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.to ? { to: inModule(route, item.to) } : {}),
    ...(item.children ? { children: item.children.map(child) } : {}),
  }))
})

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  // A route this router knows: its own module's, or any module's in one SPA. By name, so an entry
  // from before a page moved (`appId: 'pos'`, the till's old paths) reopens at the page's new home.
  if (entry.routeName && router.hasRoute(entry.routeName)) {
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
  // Loaded whatever module this shell first shows: in one SPA it goes on to show the others.
  // Keyed on the session, as a form's restore is, and never on `/auth/me`'s answer: with that
  // refused the key was empty, the panel came up empty, and what a save removed stayed in the
  // real list, to come back on the next healthy load.
  // Before anything is waited for: a form is up already, and what it leaves goes into this list.
  const loadPending = () => {
    if (appStore.currentOrg?.id && !pendingChangesStore.currentOrgId) pendingChangesStore.load(appStore.currentOrg.id, jwtUserId())
  }
  loadPending()
  if (!appStore.user && appStore.token) {
    await appStore.fetchProfile()
  }
  if (appStore.currentOrg?.id) {
    loadPending()
    try {
      const { data } = await httpClient.get(`/org/${appStore.currentOrg.id}/apps`)
      apps.value = data.apps
    } catch {
      apps.value = (Object.keys(APP_REGISTRY) as AppId[]).map(id => ({ id, ...APP_REGISTRY[id], enabled: false }))
    }
  }
})
</script>

<style scoped>
.lgr-bridge-chip {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1006;
}
</style>
