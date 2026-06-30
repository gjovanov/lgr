<template>
  <v-text-field
    :model-value="modelValue"
    type="date"
    append-inner-icon="mdi-calendar"
    class="date-field"
    @update:model-value="$emit('update:modelValue', $event)"
    @click:append-inner="openPicker"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue'

/**
 * Date input with a right-anchored calendar icon. The browser-native
 * `::-webkit-calendar-picker-indicator` floats mid-field (after the short date text), so we
 * hide it and render a Vuetify `append-inner-icon`, which is always pinned to the far right.
 * Clicking the icon opens the native picker via `showPicker()`.
 */
defineProps<{ modelValue?: string }>()
defineEmits<{ 'update:modelValue': [v: string] }>()

const root = ref()

function openPicker(e: MouseEvent) {
  const input = (e.currentTarget as HTMLElement)
    ?.closest('.date-field')
    ?.querySelector('input[type="date"]') as HTMLInputElement | null
  // showPicker() is supported in Chrome/Edge 99+; fall back to focusing the input.
  if (input?.showPicker) {
    try { input.showPicker() } catch { input.focus() }
  } else {
    input?.focus()
  }
}
</script>

<style scoped>
/* Hide the native indicator; the mdi-calendar append-inner icon replaces it (far right). */
.date-field :deep(input[type='date'])::-webkit-calendar-picker-indicator {
  opacity: 0;
  -webkit-appearance: none;
  display: none;
}
.date-field :deep(input[type='date']) {
  cursor: text;
}
</style>
