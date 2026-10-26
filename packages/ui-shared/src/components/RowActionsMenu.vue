<template>
  <!-- FR-22.23: a list row's actions in one compact menu. A row of icons ran past the table's edge
       at 1366 px, and stacked, made each row several lines tall. Each list passes the actions the
       API allows for that row (`show`); nothing else is listed. -->
  <v-menu v-if="shown.length" location="bottom end">
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        icon="mdi-dots-vertical"
        size="small"
        variant="text"
        density="comfortable"
        :aria-label="$t('common.actions')"
        :title="$t('common.actions')"
        data-testid="row-actions"
      />
    </template>
    <v-list density="compact" min-width="220" data-testid="row-actions-list">
      <template v-for="(a, i) in shown" :key="a.key">
        <v-divider v-if="a.divider && i > 0" class="my-1" />
        <v-list-item
          :prepend-icon="a.icon"
          :title="a.label"
          :base-color="a.color"
          :to="a.to"
          :data-testid="`row-action-${a.key}`"
          @click="a.handler?.()"
        />
      </template>
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

export interface RowAction {
  /** Stable id, also the item's `data-testid` (`row-action-<key>`). */
  key: string
  label: string
  icon: string
  /** Whether the row offers it — the API's own rule for that row. Default: offered. */
  show?: boolean
  color?: string
  /** A page to open. */
  to?: RouteLocationRaw
  handler?: () => void
  /** A divider above it: what cannot be undone sits apart. */
  divider?: boolean
}

const props = defineProps<{ actions: RowAction[] }>()

const shown = computed(() => props.actions.filter((a) => a.show !== false))
</script>
