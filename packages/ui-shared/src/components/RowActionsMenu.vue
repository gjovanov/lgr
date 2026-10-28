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
        <!-- FR-22.47: an action this row cannot take now says why. A disabled item takes no pointer
             events, so the reason hangs on a wrapper that does. -->
        <div v-if="a.disabled" :data-testid="`row-action-${a.key}-disabled`">
          <v-list-item
            :prepend-icon="a.icon"
            :title="a.label"
            disabled
            :data-testid="`row-action-${a.key}`"
          />
          <v-tooltip v-if="a.hint" activator="parent" location="start">{{ a.hint }}</v-tooltip>
        </div>
        <v-list-item
          v-else
          :prepend-icon="a.icon"
          :title="a.label"
          :base-color="a.color"
          :to="a.to"
          :href="a.href"
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
  /** A page to open in this app. */
  to?: RouteLocationRaw
  /** A page in another app — build it with `appHref` (ui-shared/nav/navigate), never a route name. */
  href?: string
  handler?: () => void
  /** A divider above it: what cannot be undone sits apart. */
  divider?: boolean
  /** Listed, but not to be taken on this row now; `hint` says why. */
  disabled?: boolean
  /** Why it is disabled, shown on hover. */
  hint?: string
}

const props = defineProps<{ actions: RowAction[] }>()

const shown = computed(() => props.actions.filter((a) => a.show !== false))
</script>
