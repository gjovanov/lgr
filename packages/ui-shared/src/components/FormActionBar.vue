<template>
  <!-- One list of a form's actions, drawn as a row of buttons. `EntityFormShell` draws it under the title and,
       when asked (`bottom-actions`), again at the foot of the form: the same list, so the two rows cannot differ.

       The row keeps to one line where it can: an action that names a `collapse` rank gives up its label for its
       icon when the row would otherwise wrap (the label stays as its tooltip and its accessible name), the lowest
       rank first. Every label shows again as soon as there is room. -->
  <div ref="root" class="form-action-row d-flex align-center flex-wrap" :class="size === 'small' ? 'ga-1' : 'ga-2'">
    <template v-for="action in actions" :key="action.key || action.label">
      <v-chip
        v-if="action.note"
        size="small"
        variant="tonal"
        :color="action.note.color || 'success'"
        :prepend-icon="action.note.icon"
        :title="action.note.title"
        class="form-action-note"
        :data-note="action.key"
      >
        {{ action.note.text }}
      </v-chip>
      <!-- A span around the button: a disabled v-btn takes no pointer events, so a hint that says why it is
           disabled has to hang off something that does; and the two halves of a split button join in it. -->
      <span class="form-action d-inline-flex" :class="{ 'form-action--split': action.more }" :data-action="action.key">
        <v-btn
          :color="action.color ?? 'primary'"
          :variant="action.variant || 'flat'"
          :loading="action.loading"
          :disabled="action.disabled"
          :prepend-icon="isCollapsed(action) ? undefined : action.icon"
          :aria-keyshortcuts="ariaShortcuts?.(action)"
          :aria-label="isCollapsed(action) ? action.label : undefined"
          :title="isCollapsed(action) ? undefined : action.title"
          :size="size"
          :min-width="isCollapsed(action) ? 0 : undefined"
          :class="{ 'rounded-e-0': action.more, 'form-action-icon': isCollapsed(action) }"
          :data-testid="testIdOf(action.testId)"
          @click="action.handler"
        >
          <v-icon v-if="isCollapsed(action)">{{ action.icon }}</v-icon>
          <template v-else>{{ action.label }}</template>
          <!-- FR-22.52: the keys that run this action, named where the person looks for them; and, for an
               action shown as its icon, its name. -->
          <v-tooltip v-if="tips(action).length" activator="parent" location="bottom" content-class="tooltip-visible">
            {{ tips(action).join(' · ') }}
          </v-tooltip>
        </v-btn>
        <v-btn
          v-if="action.more"
          :color="action.color ?? 'primary'"
          :variant="action.variant || 'flat'"
          :size="size"
          min-width="0"
          class="rounded-s-0 form-action-more"
          :title="action.more.label"
          :aria-label="action.more.label"
          :data-testid="testIdOf(action.more.testId)"
          @click="action.more.handler"
        >
          <v-icon>{{ action.more.icon }}</v-icon>
        </v-btn>
        <v-tooltip
          v-if="action.disabledHint"
          activator="parent"
          location="bottom"
          content-class="tooltip-visible"
          :disabled="!action.disabled"
          :text="action.disabledHint"
        />
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FormAction } from './EntityFormShell.vue'
import { collapseRanks, collapsedAt } from './form-action-collapse'

const props = withDefaults(defineProps<{
  actions: FormAction[]
  size?: 'small' | 'default'
  /** Added to every `testId`, so the same action in a second row stays findable on its own (`-bottom`). */
  testIdSuffix?: string
  /** The keys that run an action, to name on it (the shell knows which action Ctrl+S and Ctrl+Enter reach). */
  shortcutLabels?: (action: FormAction) => string[]
  ariaShortcuts?: (action: FormAction) => string | undefined
}>(), { size: 'default', testIdSuffix: '' })

const root = ref<HTMLElement | null>(null)

function testIdOf(id?: string): string | undefined {
  return id ? `${id}${props.testIdSuffix}` : undefined
}

// ── One line where it fits ──
/** The ranks the actions name, lowest first: the order their labels are given up in. */
const ranks = computed(() => collapseRanks(props.actions))
/** How many of those ranks are shown as icons now. */
const level = ref(0)

function isCollapsed(action: FormAction): boolean {
  return collapsedAt(action, ranks.value, level.value)
}

function tips(action: FormAction): string[] {
  const keys = props.shortcutLabels?.(action) ?? []
  return isCollapsed(action) ? [action.label, ...keys] : keys
}

/** The row runs onto a second line: it is taller than its tallest button by more than a gap. */
function wraps(el: HTMLElement): boolean {
  let tallest = 0
  for (const child of Array.from(el.children) as HTMLElement[]) tallest = Math.max(tallest, child.offsetHeight)
  return tallest > 0 && el.clientHeight > tallest * 1.5
}

let fitRun = 0
/**
 * Show every label, then give them up rank by rank until the row is one line. Each step is measured after Vue
 * has drawn it and before the browser paints, so nobody sees the steps.
 *
 * A row that is not one line even as icons shows every label again and wraps, as any row does: the height is
 * spent either way, and a word says more than an icon (on a phone, where rows this narrow are, nothing hovers
 * to name one).
 */
async function fit() {
  const run = ++fitRun
  const top = ranks.value.length
  for (let next = 0; next <= top; next++) {
    level.value = next
    await nextTick()
    if (run !== fitRun || !root.value) return
    if (!wraps(root.value)) return
  }
  level.value = 0
}

/** What decides the row's width: which actions, their words and their icons. Not whether one is busy. */
const signature = computed(() => props.actions
  .map(a => [a.key || '', a.label, a.icon || '', a.collapse ?? '', a.more ? 1 : 0, a.note?.text || ''].join('\u0001'))
  .join('\u0002'))

watch(signature, () => { void fit() }, { flush: 'post' })

let observer: ResizeObserver | null = null
let frame = 0
/** Measure again on the next frame, so nothing an observer watches changes under it. */
function refit() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => { void fit() })
}
onMounted(() => {
  void fit()
  // A font that arrives after the first paint changes what fits.
  void document.fonts?.ready.then(() => { if (root.value) refit() })
  if (typeof ResizeObserver === 'undefined' || !root.value) return
  // The row's own size: its width is the room it has, and its height changes when something in it grew and
  // wrapped it. Fitting settles on the same row for the same room, so a fit never calls for another.
  observer = new ResizeObserver(refit)
  observer.observe(root.value)
})
onBeforeUnmount(() => {
  fitRun++
  cancelAnimationFrame(frame)
  observer?.disconnect()
})
</script>

<style scoped>
/* A split button: the action, and the same action with options, one control in two parts (FR-22.20). */
.form-action--split .form-action-more {
  padding-inline: 8px;
  border-inline-start-width: 0;
}
/* A flat pair has no border to tell its halves apart. */
.form-action--split .form-action-more.v-btn--variant-flat {
  border-inline-start: 1px solid rgba(var(--v-theme-on-primary), 0.3);
}
/* An action shown as its icon alone. */
.form-action-icon {
  padding-inline: 8px;
}
</style>
