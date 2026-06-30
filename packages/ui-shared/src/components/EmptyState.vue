<template>
  <v-empty-state
    :icon="icon"
    :headline="headline"
    :title="title"
    :text="description"
    class="py-8"
  >
    <template v-if="$slots.actions" #actions>
      <slot name="actions" />
    </template>
  </v-empty-state>
</template>

<script setup lang="ts">
/**
 * Shared empty-state for lists, tables and panels. Thin wrapper over Vuetify's
 * v-empty-state so the look (icon size, spacing, CTA placement) is centralized
 * across all 8 apps. Pass a CTA via the #actions slot.
 */
withDefaults(defineProps<{
  /** mdi icon shown above the text */
  icon?: string
  /** optional large display text above the title */
  headline?: string
  /** primary message (required) */
  title: string
  /** secondary explanatory line */
  description?: string
}>(), {
  icon: 'mdi-inbox-outline',
})
</script>
