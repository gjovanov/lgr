<template>
  <AppShell
    :org="appStore.currentOrg"
    :user="appStore.user"
    :apps="apps"
    :notifications="notificationStore.notifications"
    :unread-count="notificationStore.unreadCount"
    :is-dark="appStore.isDark"
    :locales="['en', 'mk', 'de', 'bg']"
    :current-locale="appStore.locale"
    :drawer-open="appStore.leftDrawer"
    :pending-changes-count="pendingChangesStore.count"
    @toggle-drawer="appStore.toggleDrawer()"
    @locale-change="appStore.setLocale($event)"
    @theme-toggle="appStore.toggleTheme()"
    @app-navigate="handleAppNavigate"
    @portal-navigate="router.push('/apps')"
    @notification-read="notificationStore.markAsRead($event)"
    @notification-read-all="notificationStore.markAllAsRead()"
    @toggle-pending-changes="pendingChangesOpen = !pendingChangesOpen"
    @logout="handleLogout"
    @profile="router.push({ name: 'account' })"
  >
    <template #nav-items>
      <v-list-item prepend-icon="mdi-apps" title="Apps" to="/apps" />
      <v-list-item prepend-icon="mdi-view-dashboard" :title="$t('nav.dashboard')" to="/dashboard" />
      <v-divider class="my-2" />
      <v-list-item prepend-icon="mdi-cog" :title="$t('nav.organization')" to="/settings/organization" />
      <v-list-item prepend-icon="mdi-account-cog" :title="$t('nav.users')" to="/settings/users" />
      <v-list-item prepend-icon="mdi-shield-key" :title="$t('permissionSets.title')" to="/settings/permission-sets" />
      <v-list-item prepend-icon="mdi-email-outline" title="Invites" to="/settings/invites" />
      <v-list-item prepend-icon="mdi-monitor-dashboard" :title="$t('desktops.title')" to="/settings/desktops" />
      <v-list-item prepend-icon="mdi-server-network" :title="$t('servers.title')" to="/settings/servers" />
      <v-list-item v-if="onServer" prepend-icon="mdi-server" :title="$t('serverStatus.title')" to="/settings/server" data-test="nav-server-status" />
      <v-list-item prepend-icon="mdi-credit-card-outline" title="Billing" to="/settings/billing" />
      <v-list-item prepend-icon="mdi-clipboard-text-clock" :title="$t('nav.auditLog')" to="/admin/audit-log" />
      <!--
        FR-13.27 (#24) — shown only to a caller the server's allow-list admits.
        ⚠ Presentation, not protection: the route exists regardless and anyone who types the
        URL reaches the screen. The server 403s every call on it. Hiding the entry keeps the
        nav honest for the 99 % who cannot use it; it secures nothing.
      -->
      <v-list-item
        v-if="canAdminBackups"
        prepend-icon="mdi-database-sync"
        :title="$t('nav.backup')"
        to="/admin/backup"
      />
      <!-- FR-20 P2-3a: every registered master, across orgs. The same allow-list; presentation only. -->
      <v-list-item v-if="canAdminBackups" prepend-icon="mdi-server" :title="$t('adminNodes.title')" to="/admin/nodes" />
      <!-- FR-20.55 (P2-3b): pilots and air-gapped licence files. The same allow-list; presentation only. -->
      <v-list-item v-if="canAdminBackups" prepend-icon="mdi-license" :title="$t('adminLicences.title')" to="/admin/licences" />
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
import { useNotificationStore } from '../store/notification.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { appHomeHref, goTo } from 'ui-shared/nav/navigate'
import { pendingRestoreUrl } from 'ui-shared/nav/open-page'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'
import type { AppInfo } from 'ui-shell/components/types'
import type { PendingChangeEntry } from 'ui-shared/stores/pending-changes.types'
import { APP_REGISTRY, type AppId } from 'config/constants'

const appStore = useAppStore()
const notificationStore = useNotificationStore()
const pendingChangesStore = usePendingChangesStore()
const router = useRouter()
const apps = ref<AppInfo[]>([])
const pendingChangesOpen = ref(false)
/** FR-13.27 — whether to SHOW the backup entry. Never whether the caller may use it. */
const canAdminBackups = ref(false)
/** FR-20.98 (P3-8b): on a master, for an admin, the server's own status page. */
const onServer = ref(false)

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  if (entry.appId === 'portal' && entry.routeName) {
    router.push({ name: entry.routeName, params: entry.routeParams, query: { restore: entry.id } })
  } else {
    // FR-24.7: the entry's path may be relative to its app or full.
    const url = pendingRestoreUrl(entry)
    if (url) goTo(url)
  }
}

onMounted(async () => {
  if (appStore.currentOrg?.id) {
    // /auth/me returns the JWT-shaped user (`id`, no `_id`) — fall back so the
    // pending-changes storage key stays stable and persist() actually writes.
    pendingChangesStore.load(appStore.currentOrg.id, (appStore.user as any)?._id || (appStore.user as any)?.id || '')
    try {
      const { data } = await httpClient.get(`/org/${appStore.currentOrg.id}/apps`)
      apps.value = data.apps
    } catch {
      // Fallback: show all apps from registry
      apps.value = (Object.keys(APP_REGISTRY) as AppId[]).map(id => ({
        id,
        ...APP_REGISTRY[id],
        enabled: false,
      }))
    }
    notificationStore.fetchNotifications()

    // FR-13.27 — ask the server whether this caller is on the backup allow-list. The probe
    // answers 200 with `false` rather than 403, so the nav can ask without the question
    // itself being an error, and a failure to answer simply hides the entry.
    try {
      const { data } = await httpClient.get(`/org/${appStore.currentOrg.id}/backup/access`)
      canAdminBackups.value = !!data?.sysAdmin
    } catch {
      canAdminBackups.value = false
    }
    try {
      const { data } = await httpClient.get(`/org/${appStore.currentOrg.id}/server/here`)
      onServer.value = !!data?.server
    } catch {
      onServer.value = false
    }
  }
})

function handleAppNavigate(app: AppInfo) {
  goTo(appHomeHref(app))
}

async function handleLogout() {
  await appStore.logout()
  router.push({ name: 'auth.login' })
}
</script>
