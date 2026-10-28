<template>
  <v-btn
    variant="outlined"
    color="default"
    class="smart-button text-none"
    :to="to"
    :href="href"
    @click="!to && !href && $emit('click')"
  >
    <div class="d-flex align-center ga-2">
      <v-icon size="small" :color="color">{{ icon }}</v-icon>
      <div class="d-flex flex-column align-start">
        <span class="text-body-2 font-weight-bold">{{ value }}</span>
        <span class="text-caption text-medium-emphasis">{{ label }}</span>
      </div>
    </div>
  </v-btn>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  icon: string
  /** A route inside this app. */
  to?: string
  /** A page in another app (`appHref`) — each app is its own SPA, so a router `to` cannot reach it. */
  href?: string
  color?: string
}>()

defineEmits<{
  click: []
}>()
</script>

<style scoped>
.smart-button {
  height: auto !important;
  min-height: 48px;
  padding: 4px 12px !important;
  border-color: rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
