<template>
  <!-- Mobile: bottom sheet -->
  <template v-if="mobile">
    <v-btn icon variant="text" @click="sheet = true">
      <v-icon>mdi-apps</v-icon>
    </v-btn>
    <v-bottom-sheet v-model="sheet">
      <v-card>
        <v-card-title class="text-body-1 d-flex align-center">
          {{ $t('appHub.title') }}
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="sheet = false" />
        </v-card-title>
        <v-divider />
        <div class="pa-2">
          <div class="d-flex flex-wrap justify-center">
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
          </div>
          <template v-for="section in sections" :key="section.key">
            <div v-if="section.labelKey" class="text-overline text-medium-emphasis px-2 pt-2">
              {{ $t(`apps.${section.labelKey}`) }}
            </div>
            <div class="d-flex flex-wrap justify-center">
              <div
                v-for="app in section.apps"
                :key="app.id"
                class="d-flex flex-column align-center pa-3 rounded cursor-pointer app-tile position-relative"
                style="width: 50%; min-height: 88px"
                @click="navigateToApp(app)"
              >
                <v-btn
                  :icon="isFavorite(app.id) ? 'mdi-star' : 'mdi-star-outline'"
                  :color="isFavorite(app.id) ? 'amber-darken-2' : 'grey'"
                  size="x-small"
                  variant="text"
                  class="fav-star"
                  @click.stop="toggleFavorite(app.id)"
                />
                <v-avatar :color="app.enabled ? app.color : 'grey-lighten-2'" size="48">
                  <v-icon color="white">{{ app.icon }}</v-icon>
                </v-avatar>
                <span class="text-caption mt-1 text-center" :class="{ 'text-grey': !app.enabled }">
                  {{ $t(`apps.${app.id}`) || app.name }}
                </span>
              </div>
            </div>
          </template>
        </div>
      </v-card>
    </v-bottom-sheet>
  </template>

  <!-- Desktop: dropdown menu -->
  <v-menu v-else :close-on-content-click="false" min-width="360">
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text">
        <v-icon>mdi-apps</v-icon>
      </v-btn>
    </template>
    <v-card>
      <v-card-title class="text-body-1">{{ $t('appHub.title') }}</v-card-title>
      <v-divider />
      <div style="max-width: 380px" class="pb-2">
        <div class="d-flex flex-wrap px-2 pt-2">
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
        </div>
        <template v-for="section in sections" :key="section.key">
          <div v-if="section.labelKey" class="text-overline text-medium-emphasis px-3 pt-2">
            {{ $t(`apps.${section.labelKey}`) }}
          </div>
          <div class="d-flex flex-wrap px-2">
            <div
              v-for="app in section.apps"
              :key="app.id"
              class="d-flex flex-column align-center pa-3 rounded cursor-pointer app-tile position-relative"
              style="width: 108px"
              @click="navigateToApp(app)"
            >
              <v-btn
                :icon="isFavorite(app.id) ? 'mdi-star' : 'mdi-star-outline'"
                :color="isFavorite(app.id) ? 'amber-darken-2' : 'grey'"
                size="x-small"
                variant="text"
                class="fav-star"
                @click.stop="toggleFavorite(app.id)"
              />
              <v-avatar :color="app.enabled ? app.color : 'grey-lighten-2'" size="48">
                <v-icon color="white">{{ app.icon }}</v-icon>
              </v-avatar>
              <span class="text-caption mt-1 text-center" :class="{ 'text-grey': !app.enabled }">
                {{ $t(`apps.${app.id}`) || app.name }}
              </span>
            </div>
          </div>
        </template>
      </div>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AppInfo } from './types'
import { useAppFavorites } from 'ui-shared/composables/useAppFavorites'

const props = defineProps<{
  apps: AppInfo[]
  mobile?: boolean
}>()

const emit = defineEmits<{
  navigate: [app: AppInfo]
  'navigate-portal': []
}>()

const sheet = ref(false)
const { isFavorite, toggleFavorite, recordOpen, groupApps } = useAppFavorites()

// Favorites first, then auto-derived "Frequent", then the rest. Empty sections are dropped;
// the trailing "all" group only gets a header when something sits above it.
const sections = computed(() => {
  const g = groupApps(props.apps)
  const hasGroups = g.favorites.length > 0 || g.frequent.length > 0
  const out: { key: string; labelKey: string; apps: AppInfo[] }[] = []
  if (g.favorites.length) out.push({ key: 'fav', labelKey: 'favorites', apps: g.favorites })
  if (g.frequent.length) out.push({ key: 'freq', labelKey: 'frequent', apps: g.frequent })
  out.push({ key: 'all', labelKey: hasGroups ? 'all' : '', apps: g.rest })
  return out.filter((s) => s.apps.length)
})

function navigateToPortal() {
  sheet.value = false
  emit('navigate-portal')
}

function navigateToApp(app: AppInfo) {
  if (!app.enabled) return
  recordOpen(app.id)
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
.position-relative {
  position: relative;
}
.fav-star {
  position: absolute;
  top: 2px;
  right: 2px;
}
</style>
