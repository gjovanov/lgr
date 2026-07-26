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
    @profile="() => {}"
  >
    <template #nav-items>
      <v-list-item prepend-icon="mdi-apps" title="Apps" to="/apps" />
      <v-list-item prepend-icon="mdi-view-dashboard" :title="$t('nav.dashboard')" to="/dashboard" />
      <v-divider class="my-2" />
      <v-list-item prepend-icon="mdi-cog" :title="$t('nav.organization')" to="/settings/organization" />
      <v-list-item prepend-icon="mdi-account-cog" :title="$t('nav.users')" to="/settings/users" />
      <v-list-item prepend-icon="mdi-shield-key" :title="$t('permissionSets.title')" to="/settings/permission-sets" />
      <v-list-item prepend-icon="mdi-email-outline" title="Invites" to="/settings/invites" />
      <v-list-item prepend-icon="mdi-credit-card-outline" title="Billing" to="/settings/billing" />
      <v-list-item prepend-icon="mdi-clipboard-text-clock" :title="$t('nav.auditLog')" to="/admin/audit-log" />
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

function handleRestore(entry: PendingChangeEntry) {
  pendingChangesOpen.value = false
  if (entry.appId === 'portal' && entry.routeName) {
    router.push({ name: entry.routeName, params: entry.routeParams, query: { restore: entry.id } })
  } else if (entry.routePath) {
    window.location.href = `/${entry.appId}${entry.routePath}?restore=${entry.id}`
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
  }
})

function handleAppNavigate(app: AppInfo) {
  const { hostname, port } = window.location
  const isViteDev = hostname === 'localhost' && port === '4000'
  if (isViteDev && app.devPort) {
    const token = localStorage.getItem('lgr_token') || ''
    const org = localStorage.getItem('lgr_org') || ''
    const params = `?token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}`
    window.location.href = `http://localhost:${app.devPort}${app.path}${params}`
  } else {
    window.location.href = app.path
  }
}

function handleLogout() {
  appStore.logout()
  router.push({ name: 'auth.login' })
}
</script>
