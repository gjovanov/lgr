<template>
  <v-container>
    <v-row class="mb-4">
      <v-col>
        <h1 class="text-h4 mb-1">{{ $t('appHub.title') }}</h1>
        <p class="text-body-2 text-grey">{{ $t('appHub.subtitle') }}</p>
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
          class="app-card app-card--enabled"
          height="200"
          @click="navigateToApp(app)"
        >
          <v-card-text class="d-flex flex-column align-center justify-center text-center" style="height: 100%">
            <v-avatar :color="app.color" size="64" class="mb-3">
              <v-icon size="32" color="white">{{ app.icon }}</v-icon>
            </v-avatar>
            <h3 class="text-h6">{{ $t(`apps.${app.id}`) || app.name }}</h3>
            <p class="text-caption text-grey mt-1">{{ $t(`apps.${app.id}Desc`) || app.description }}</p>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-snackbar v-model="errorSnackbar" color="error" location="top">
      {{ errorMessage }}
    </v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../store/app.store'

interface AppInfo {
  id: string
  name: string
  icon: string
  color: string
  devPort: number
  path: string
  description: string
  enabled: boolean
}

const { t } = useI18n()
const appStore = useAppStore()
const apps = ref<AppInfo[]>([])
const loading = ref(true)
const errorSnackbar = ref(false)
const errorMessage = ref('')

onMounted(async () => {
  await fetchApps()
})

async function fetchApps() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/apps`)
    apps.value = data.apps
  } catch (err: any) {
    errorMessage.value = err.response?.data?.message || t('appHub.loadFailed')
    errorSnackbar.value = true
  } finally {
    loading.value = false
  }
}

function navigateToApp(app: AppInfo) {
  const { hostname, port } = window.location
  const isViteDev = hostname === 'localhost' && port === '4000'

  if (isViteDev && app.devPort) {
    // Vite dev: each app UI has its own Vite dev server (cross-origin, needs token in URL)
    const token = localStorage.getItem('lgr_token') || ''
    const org = localStorage.getItem('lgr_org') || ''
    const params = `?token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}`
    window.location.href = `http://localhost:${app.devPort}${app.path}${params}`
  } else {
    // Production + unified dev: same origin, localStorage shared
    window.location.href = app.path
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
