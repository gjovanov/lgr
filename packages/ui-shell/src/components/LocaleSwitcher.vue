<template>
  <!-- FR-05 (#12): hover-opens on true-hover desktops; tap unchanged. -->
  <v-menu :open-on-hover="hoverEnabled" :open-on-click="true" :open-delay="openDelay" :close-delay="closeDelay">
    <template #activator="{ props }">
      <v-btn v-bind="props" variant="text" size="small">
        <v-icon start>mdi-translate</v-icon>
        {{ currentLocale.toUpperCase() }}
        <v-icon end size="small">mdi-menu-down</v-icon>
      </v-btn>
    </template>
    <v-list density="compact">
      <v-list-item
        v-for="loc in locales"
        :key="loc"
        :title="loc.toUpperCase()"
        :active="currentLocale === loc"
        @click="$emit('change', loc)"
      />
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { useHoverMenus } from 'ui-shared/composables/useHoverMenus'

defineProps<{
  locales: string[]
  currentLocale: string
}>()

const { hoverEnabled, openDelay, closeDelay } = useHoverMenus()

defineEmits<{
  change: [locale: string]
}>()
</script>
