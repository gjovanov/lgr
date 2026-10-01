<template>
  <v-app>
    <v-navigation-drawer permanent rail-width="72" :rail="rail" width="220">
      <v-list-item class="py-3">
        <template #prepend>
          <v-icon icon="mdi-monitor-dashboard" size="28" />
        </template>
        <v-list-item-title class="font-weight-medium">{{ $t('shell.app.title') }}</v-list-item-title>
        <template #append>
          <v-btn
            variant="text"
            density="comfortable"
            :icon="rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            :aria-label="$t('shell.nav.overview')"
            @click="rail = !rail"
          />
        </template>
      </v-list-item>

      <v-divider />

      <v-list density="comfortable" nav>
        <v-list-item
          v-for="item in nav"
          :key="item.name"
          :to="{ name: item.name }"
          :prepend-icon="item.icon"
          :title="$t(item.labelKey)"
          :value="item.name"
        />
      </v-list>

      <template #append>
        <!--
          ⚠ Version in the chrome, not only on the Overview. It is the first thing asked for on
          a support call, and it must be readable from whichever page the person is already on.
        -->
        <div v-if="!rail" class="pa-3 text-caption text-medium-emphasis">
          {{ version }}
        </div>
      </template>
    </v-navigation-drawer>

    <v-main>
      <slot />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
/**
 * The shell's chrome.
 *
 * ⚠ Deliberately NOT `ui-shell`'s `AppShell`. The shell app has no app switcher, no org
 * selector and no notification bell — it is not one of the web apps, it is the thing that
 * opens them. Importing `ui-shell` here would drag all three in along with their stores
 * (C09's trap).
 */
import { computed, ref } from 'vue'
import { useShellState } from '../composables/useShellState'

const { status } = useShellState()
const rail = ref(false)

const version = computed(() => (status.value ? `v${status.value.appVersion}` : ''))

const nav = [
  { name: 'overview', icon: 'mdi-view-dashboard-outline', labelKey: 'shell.nav.overview' },
  { name: 'settings', icon: 'mdi-cog-outline', labelKey: 'shell.nav.settings' },
  { name: 'onboarding', icon: 'mdi-rocket-launch-outline', labelKey: 'shell.nav.onboarding' },
  { name: 'logs', icon: 'mdi-text-box-outline', labelKey: 'shell.nav.logs' },
  { name: 'diagnostics', icon: 'mdi-stethoscope', labelKey: 'shell.nav.diagnostics' },
] as const
</script>
