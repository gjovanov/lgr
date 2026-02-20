<template>
  <v-btn-group variant="text" density="compact">
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
}>()

defineEmits<{
  change: [locale: string]
}>()
</script>
