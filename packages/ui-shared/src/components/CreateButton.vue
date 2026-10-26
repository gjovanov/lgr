<template>
  <!-- FR-22.50: a list's Create says what it creates („Нова фактура", „Нова стокова разписка"…)
       and sits where every list has it — rightmost in the header. A list that creates more than one
       kind of document offers the others beside it (D-8: the sales list's notes). -->
  <div class="d-inline-flex create-button">
    <ResponsiveBtn
      color="primary"
      icon="mdi-plus"
      :to="to"
      :class="{ 'rounded-e-0': more?.length }"
      :aria-label="label"
      data-testid="create-button"
      @click="to ? undefined : emit('click')"
    >
      {{ label }}
    </ResponsiveBtn>
    <v-menu v-if="more?.length" location="bottom end">
      <template #activator="{ props: menuProps }">
        <v-btn
          v-bind="menuProps"
          color="primary"
          class="rounded-s-0 create-more"
          min-width="0"
          :aria-label="moreLabel"
          :title="moreLabel"
          data-testid="create-more"
        >
          <v-icon>mdi-chevron-down</v-icon>
        </v-btn>
      </template>
      <v-list density="compact" data-testid="create-more-list">
        <v-list-item v-for="m in more" :key="m.label" :to="m.to" :title="m.label" :prepend-icon="m.icon || 'mdi-plus'" />
      </v-list>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import ResponsiveBtn from './ResponsiveBtn.vue'

defineProps<{
  /** What it creates: „Нова фактура". */
  label: string
  /** The form it opens. Absent: the list handles `click` (a create dialog). */
  to?: RouteLocationRaw
  /** The other documents this list creates. */
  more?: Array<{ label: string; to: RouteLocationRaw; icon?: string }>
  /** The accessible name of the menu of the others. */
  moreLabel?: string
}>()

const emit = defineEmits<{ click: [] }>()
</script>

<style scoped>
.create-button .create-more {
  padding-inline: 6px;
  border-inline-start: thin solid rgba(var(--v-theme-on-primary), 0.35);
}
</style>
