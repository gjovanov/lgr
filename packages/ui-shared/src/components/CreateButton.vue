<template>
  <!-- FR-22.50: a list's Create says what it creates („Нова фактура", „Нова стокова разписка"…)
       and sits where every list has it — rightmost in the header. A list that creates more than one
       kind of document offers the others beside it (D-8: the sales list's notes). -->
  <!-- FR-27.7: only for a form the role opens (`opensTarget`), or, for a dialog, the capability it names (`cap`). -->
  <div v-if="shown" class="d-inline-flex create-button" :data-cap="cap ? [cap].flat().join(' ') : undefined">
    <ResponsiveBtn
      color="primary"
      icon="mdi-plus"
      :to="to"
      :class="{ 'rounded-e-0': offeredMore.length }"
      :aria-label="label"
      data-testid="create-button"
      @click="to ? undefined : emit('click')"
    >
      {{ label }}
    </ResponsiveBtn>
    <v-menu v-if="offeredMore.length" location="bottom end">
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
        <v-list-item v-for="m in offeredMore" :key="m.label" :to="m.to" :title="m.label" :prepend-icon="m.icon || 'mdi-plus'" />
      </v-list>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import ResponsiveBtn from './ResponsiveBtn.vue'
import { opensTarget } from '../access/page-access'
import { capShows, type CapValue } from '../access/v-cap'

const props = defineProps<{
  /** What it creates: „Нова фактура". */
  label: string
  /** The form it opens. Absent: the list handles `click` (a create dialog). */
  to?: RouteLocationRaw
  /** The other documents this list creates. */
  more?: Array<{ label: string; to: RouteLocationRaw; icon?: string }>
  /** The accessible name of the menu of the others. */
  moreLabel?: string
  /** FR-27.7: what a create without a form (a dialog) needs; any one of them. */
  cap?: CapValue
}>()

const router = useRouter()
/** A form the session opens; a route the router cannot resolve is the server's to answer. */
function opens(to: RouteLocationRaw | undefined): boolean {
  if (!to || !router) return true
  try {
    const r = router.resolve(to)
    return opensTarget(r.path, r.query as Record<string, unknown>)
  } catch {
    return true
  }
}
const shown = computed(() => (props.cap ? capShows(props.cap) : true) && opens(props.to))
const offeredMore = computed(() => (props.more ?? []).filter(m => opens(m.to)))

const emit = defineEmits<{ click: [] }>()
</script>

<style scoped>
.create-button .create-more {
  padding-inline: 6px;
  border-inline-start: thin solid rgba(var(--v-theme-on-primary), 0.35);
}
</style>
