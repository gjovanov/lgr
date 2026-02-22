<template>
  <v-menu :close-on-content-click="true" min-width="320">
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text">
        <v-icon>mdi-apps</v-icon>
      </v-btn>
    </template>
    <v-card>
      <v-card-title class="text-body-1">Apps</v-card-title>
      <v-divider />
      <div class="d-flex flex-wrap pa-2" style="max-width: 360px">
        <!-- Portal / App Hub link -->
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
import type { AppInfo } from './types'

defineProps<{
  apps: AppInfo[]
}>()

const emit = defineEmits<{
  navigate: [app: AppInfo]
  'navigate-portal': []
}>()

function navigateToPortal() {
  emit('navigate-portal')
}

function navigateToApp(app: AppInfo) {
  if (!app.enabled) return
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
