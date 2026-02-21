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
    @logout="appStore.logout()"
    @profile="() => {}"
  >
    <template #nav-items>
      <v-list-item prepend-icon="mdi-account-multiple" :title="$t('payroll.employees')" to="/payroll/employees" />
      <v-list-item prepend-icon="mdi-cash-register" :title="$t('payroll.payrollRuns')" to="/payroll/runs" />
      <v-list-item prepend-icon="mdi-file-document-outline" :title="$t('payroll.payslips')" to="/payroll/payslips" />
      <v-list-item prepend-icon="mdi-clock-outline" :title="$t('payroll.timesheets')" to="/payroll/timesheets" />
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
  // Fetch profile if we have a token but no user data
  if (!appStore.user && appStore.token) {
    await appStore.fetchProfile()
  }

  if (appStore.currentOrg?.id) {
    try {
      const portalBase = window.location.hostname === 'localhost' ? 'http://localhost:4001' : ''
      const { data } = await httpClient.get(`${portalBase}/api/org/${appStore.currentOrg.id}/apps`)
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

function handleAppNavigate(app: AppInfo) {
  const isDev = window.location.hostname === 'localhost'
  if (isDev) {
    window.location.href = `http://localhost:${app.uiPort}`
  } else {
    window.location.href = `/${app.id}`
  }
}
</script>
