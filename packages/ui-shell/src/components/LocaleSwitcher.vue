<template>
  <!-- Mobile: globe icon with dropdown -->
  <v-menu v-if="compact">
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text">
        <v-icon>mdi-translate</v-icon>
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

  <!-- Desktop: button group -->
  <v-btn-group v-else variant="text" density="compact">
    <v-btn
      v-for="loc in locales"
      :key="loc"
      size="small"
      :color="currentLocale === loc ? 'primary' : ''"
      @click="$emit('change', loc)"
    >
      {{ loc.toUpperCase() }}
    </v-btn>
  </v-btn-group>
</template>

<script setup lang="ts">
defineProps<{
  locales: string[]
  currentLocale: string
  compact?: boolean
}>()

defineEmits<{
  change: [locale: string]
}>()
</script>
