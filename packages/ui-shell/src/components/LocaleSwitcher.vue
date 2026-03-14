<template>
  <v-menu>
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
defineProps<{
  locales: string[]
  currentLocale: string
}>()

defineEmits<{
  change: [locale: string]
}>()
</script>
