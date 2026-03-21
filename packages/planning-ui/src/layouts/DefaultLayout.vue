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
    @toggle-drawer="appStore.toggleDrawer()"
    @locale-change="appStore.setLocale($event)"
    @theme-toggle="appStore.toggleTheme()"
    @app-navigate="handleAppNavigate"
    @portal-navigate="handlePortalNavigate"
    @logout="appStore.logout()"
    @profile="() => {}"
  >
    <template #nav-items>
      <v-list-item prepend-icon="mdi-clock-outline" :title="$t('planning.shifts')" to="/shifts" />
      <v-list-item prepend-icon="mdi-file-document-outline" :title="$t('planning.templates')" to="/templates" />
      <v-list-item prepend-icon="mdi-calendar-check" :title="$t('planning.appointments')" to="/appointments" />
      <v-list-item prepend-icon="mdi-format-list-bulleted-type" :title="$t('planning.appointmentTypes')" to="/appointment-types" />
    </template>

    <router-view />
  </AppShell>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AppShell from 'ui-shell/components/AppShell'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import type { AppInfo } from 'ui-shell/components/types'
import { APP_REGISTRY, type AppId } from 'config/constants'

const appStore = useAppStore()
const apps = ref<AppInfo[]>([])

onMounted(async () => {
  if (!appStore.user && appStore.token) {
    await appStore.fetchProfile()
  }

  if (appStore.currentOrg?.id) {
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
