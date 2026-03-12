<template>
  <!-- Mobile: bottom sheet -->
  <template v-if="mobile">
    <v-btn icon variant="text" @click="sheet = true">
      <v-icon>mdi-apps</v-icon>
    </v-btn>
    <v-bottom-sheet v-model="sheet">
      <v-card>
        <v-card-title class="text-body-1 d-flex align-center">
          Apps
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="sheet = false" />
        </v-card-title>
        <v-divider />
        <div class="d-flex flex-wrap pa-2 justify-center">
          <div
            class="d-flex flex-column align-center pa-3 rounded cursor-pointer app-tile"
            style="width: 50%; min-height: 88px"
            @click="navigateToPortal"
          >
            <v-avatar color="#1976d2" size="48">
              <v-icon color="white">mdi-view-dashboard</v-icon>
            </v-avatar>
            <span class="text-caption mt-1 text-center">Portal</span>
          </div>
          <div
            v-for="app in apps"
            :key="app.id"
            class="d-flex flex-column align-center pa-3 rounded cursor-pointer app-tile"
            style="width: 50%; min-height: 88px"
            @click="navigateToApp(app)"
          >
            <v-avatar :color="app.enabled ? app.color : 'grey-lighten-2'" size="48">
              <v-icon color="white">{{ app.icon }}</v-icon>
            </v-avatar>
            <span class="text-caption mt-1 text-center" :class="{ 'text-grey': !app.enabled }">
              {{ app.name }}
            </span>
          </div>
        </div>
      </v-card>
    </v-bottom-sheet>
  </template>

  <!-- Desktop: dropdown menu -->
  <v-menu v-else :close-on-content-click="true" min-width="320">
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text">
        <v-icon>mdi-apps</v-icon>
      </v-btn>
    </template>
    <v-card>
      <v-card-title class="text-body-1">Apps</v-card-title>
      <v-divider />
      <div class="d-flex flex-wrap pa-2" style="max-width: 360px">
        <div
          class="d-flex flex-column align-center pa-3 rounded cursor-pointer app-tile"
          style="width: 108px"
          @click="navigateToPortal"
        >
          <v-avatar color="#1976d2" size="48">
            <v-icon color="white">mdi-view-dashboard</v-icon>
          </v-avatar>
          <span class="text-caption mt-1 text-center">Portal</span>
        </div>
        <div
          v-for="app in apps"
          :key="app.id"
          class="d-flex flex-column align-center pa-3 rounded cursor-pointer app-tile"
          style="width: 108px"
          @click="navigateToApp(app)"
        >
          <v-avatar :color="app.enabled ? app.color : 'grey-lighten-2'" size="48">
            <v-icon color="white">{{ app.icon }}</v-icon>
          </v-avatar>
          <span class="text-caption mt-1 text-center" :class="{ 'text-grey': !app.enabled }">
            {{ app.name }}
          </span>
        </div>
      </div>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { AppInfo } from './types'

defineProps<{
  apps: AppInfo[]
  mobile?: boolean
}>()

const emit = defineEmits<{
  navigate: [app: AppInfo]
  'navigate-portal': []
}>()

const sheet = ref(false)

function navigateToPortal() {
  sheet.value = false
  emit('navigate-portal')
}

function navigateToApp(app: AppInfo) {
  if (!app.enabled) return
  sheet.value = false
  emit('navigate', app)
}
</script>

<style scoped>
.app-tile:hover {
  background-color: rgba(0, 0, 0, 0.04);
}
.cursor-pointer {
  cursor: pointer;
}
</style>
