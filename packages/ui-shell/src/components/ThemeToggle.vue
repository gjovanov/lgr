<template>
  <v-btn icon variant="text" :aria-label="$t('shell.theme')" :title="$t('shell.theme')" @click="$emit('toggle')">
    <v-icon>{{ isDark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}</v-icon>
  </v-btn>
</template>

<script setup lang="ts">
defineProps<{
  isDark: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>
