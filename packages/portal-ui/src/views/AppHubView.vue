<template>
  <v-container>
    <v-row class="mb-4">
      <v-col>
        <h1 class="text-h4 mb-1">Apps</h1>
        <p class="text-body-2 text-grey">Select an app to get started, or manage your app subscriptions.</p>
      </v-col>
    </v-row>

    <v-row v-if="loading">
      <v-col cols="12" class="d-flex justify-center">
        <v-progress-circular indeterminate color="primary" />
      </v-col>
    </v-row>

    <v-row v-else>
      <v-col
        v-for="app in apps"
        :key="app.id"
        cols="12"
        sm="6"
        md="4"
        lg="3"
      >
        <v-card
          :disabled="!app.enabled && !isAdmin"
          class="app-card"
          :class="{ 'app-card--enabled': app.enabled }"
          height="200"
          @click="app.enabled ? navigateToApp(app) : null"
        >
          <v-card-text class="d-flex flex-column align-center justify-center text-center" style="height: 100%">
            <v-avatar :color="app.enabled ? app.color : 'grey-lighten-2'" size="64" class="mb-3">
              <v-icon size="32" color="white">{{ app.icon }}</v-icon>
            </v-avatar>
            <h3 class="text-h6" :class="{ 'text-grey': !app.enabled }">{{ app.name }}</h3>
            <p class="text-caption text-grey mt-1">{{ app.description }}</p>
          </v-card-text>
          <v-card-actions v-if="isAdmin" class="justify-center">
            <v-btn
              v-if="app.enabled"
              variant="text"
              color="error"
              size="small"
              @click.stop="deactivateApp(app.id)"
            >
              Deactivate
            </v-btn>
            <v-btn
              v-else
              variant="text"
              color="primary"
              size="small"
              :loading="activating === app.id"
              @click.stop="activateApp(app.id)"
            >
              Activate
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <v-row v-if="!loading && planMessage" class="mt-4">
      <v-col>
        <v-alert type="info" variant="tonal">
          {{ planMessage }}
          <template #append>
            <v-btn variant="text" color="primary" to="/settings/billing">Upgrade</v-btn>
          </template>
        </v-alert>
      </v-col>
    </v-row>

    <v-snackbar v-model="errorSnackbar" color="error" location="top">
      {{ errorMessage }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../store/app.store'

interface AppInfo {
  id: string
  name: string
  icon: string
  color: string
  port: number
  uiPort: number
  description: string
  enabled: boolean
}

const appStore = useAppStore()
const apps = ref<AppInfo[]>([])
const loading = ref(true)
const activating = ref<string | null>(null)
const errorSnackbar = ref(false)
const errorMessage = ref('')

const isAdmin = computed(() => appStore.user?.role === 'admin')

const enabledCount = computed(() => apps.value.filter(a => a.enabled).length)
const planMessage = computed(() => {
  const total = apps.value.length
  if (enabledCount.value >= total) return ''
  return `You have ${enabledCount.value} of ${total} apps activated.`
})

onMounted(async () => {
  await fetchApps()
})

async function fetchApps() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/apps`)
    apps.value = data.apps
  } catch (err: any) {
    errorMessage.value = err.response?.data?.message || 'Failed to load apps'
    errorSnackbar.value = true
  } finally {
    loading.value = false
  }
}

async function activateApp(appId: string) {
  activating.value = appId
  try {
    await httpClient.post(`${appStore.orgUrl()}/apps/${appId}/activate`)
    await fetchApps()
  } catch (err: any) {
    errorMessage.value = err.response?.data?.message || 'Failed to activate app'
    errorSnackbar.value = true
  } finally {
    activating.value = null
  }
}

async function deactivateApp(appId: string) {
  try {
    await httpClient.post(`${appStore.orgUrl()}/apps/${appId}/deactivate`)
    await fetchApps()
  } catch (err: any) {
    errorMessage.value = err.response?.data?.message || 'Failed to deactivate app'
    errorSnackbar.value = true
  }
}

function navigateToApp(app: AppInfo) {
  const isDev = window.location.hostname === 'localhost'
  if (isDev) {
    window.location.href = `http://localhost:${app.uiPort}`
  } else {
    window.location.href = `/${app.id}`
  }
}
</script>

<style scoped>
.app-card {
  cursor: pointer;
  transition: all 0.2s ease;
}
.app-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.app-card--enabled {
  border: 2px solid transparent;
}
</style>
