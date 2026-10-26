<template>
  <div ref="shellRoot" class="entity-form-shell">
    <!-- Header: Back + Title -->
    <div class="form-header-bar d-flex align-center px-3 py-2">
      <v-btn icon variant="text" size="small" :aria-label="backLabel || $t('common.back')" data-testid="form-back" @click="goBack">
        <v-icon>mdi-arrow-left</v-icon>
        <v-tooltip activator="parent" location="bottom" content-class="tooltip-visible">{{ backLabel || $t('common.back') }}</v-tooltip>
      </v-btn>

      <div class="d-flex align-center ga-1 flex-grow-1">
        <!--
          ⚠ An `h1`, not a `span`. This is the page's title — "New Invoice", "New Contact",
          "New Journal Entry" — and as a `span` it was invisible to screen readers and to
          anything else that navigates by heading. `text-subtitle-1` still supplies the size
          and weight, so this renders identically; `mb-0` drops the UA heading margin.

          It also made ~20 e2e assertions fail: every form spec looks for
          `getByRole('heading', { name: /new invoice/i })`, which is the correct thing for
          them to assert. The fix belongs here, not in the tests.
        -->
        <h1 class="text-subtitle-1 font-weight-bold ml-1 mb-0">{{ title }}</h1>
        <span v-if="subtitle" class="text-body-2 text-medium-emphasis ml-1">{{ subtitle }}</span>
      </div>

      <!-- What the record leads to, beside its title on every tab of it (FR-22.47: an article's
           „Заприходи" / „Продай" / „Резервирай"). Small buttons: the bar keeps its height, which
           `.form-content` subtracts. -->
      <slot name="header-actions" />
    </div>

    <!-- Main content area: sheet (left) + sidebar (right) — full width, fixed height -->
    <div class="form-content d-flex">
      <!-- Left: form sheet (scrollable) -->
      <div class="form-sheet flex-grow-1">
        <!-- Actions bar: sticky -->
        <div v-if="visibleActions.length || status" class="form-actions-bar d-flex align-center justify-space-between px-4 py-1">
          <div class="d-flex align-center ga-1 flex-wrap">
            <template v-for="action in visibleActions" :key="action.label">
              <v-btn
                :color="action.color || 'primary'"
                :variant="action.variant || 'flat'"
                :loading="action.loading"
                :disabled="action.disabled"
                :prepend-icon="action.icon"
                :aria-keyshortcuts="ariaShortcuts(action)"
                size="small"
                @click="action.handler"
              >
                {{ action.label }}
                <!-- FR-22.52: the keys that run this action, named where the person looks for them. -->
                <v-tooltip v-if="shortcutLabels(action).length" activator="parent" location="bottom" content-class="tooltip-visible">
                  {{ shortcutLabels(action).join(' · ') }}
                </v-tooltip>
              </v-btn>
            </template>
          </div>

          <!-- Status pipeline -->
          <div v-if="status" class="d-flex align-center ga-1 flex-wrap">
            <template v-for="(step, idx) in status.steps" :key="step">
              <v-chip
                :color="getStepColor(step, idx)"
                :variant="idx <= currentStepIndex ? 'flat' : 'outlined'"
                size="small"
                label
              >
                <v-icon v-if="idx < currentStepIndex" start size="small">mdi-check</v-icon>
                {{ $t(step) }}
              </v-chip>
              <v-icon v-if="idx < status.steps.length - 1" size="x-small" color="grey">mdi-chevron-right</v-icon>
            </template>
          </div>
        </div>

        <!-- Smart buttons row -->
        <div v-if="smartButtons?.length" class="smart-buttons-row d-flex align-center ga-2 px-4 py-1">
          <SmartButton
            v-for="btn in smartButtons"
            :key="btn.label"
            :label="btn.label"
            :value="btn.value"
            :icon="btn.icon"
            :to="btn.to"
            :href="btn.href"
            :color="btn.color"
            @click="btn.click?.()"
          />
        </div>

        <!-- Paper card (scrollable area) -->
        <div class="form-paper-scroll">
          <div class="form-paper-wrapper pa-3">
            <v-card class="form-paper" rounded="lg" elevation="0">
              <div v-if="$slots['document-header']" class="form-paper-header">
                <slot name="document-header" />
              </div>
              <v-card-text class="pa-4">
                <slot />
              </v-card-text>
            </v-card>
          </div>
        </div>
      </div>

      <!-- Right sidebar: collapsible -->
      <div class="form-sidebar" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
        <!-- Collapse/expand toggle: centered when collapsed (rail), left-aligned when expanded -->
        <div class="sidebar-toggle d-flex py-1" :class="sidebarCollapsed ? 'justify-center' : 'justify-start px-2'">
          <v-btn
            icon
            variant="text"
            size="x-small"
            @click="toggleSidebar"
          >
            <v-icon>{{ sidebarCollapsed ? 'mdi-chevron-left' : 'mdi-chevron-right' }}</v-icon>
            <v-tooltip activator="parent" location="left" content-class="tooltip-visible">{{ sidebarCollapsed ? $t('common.expand') : $t('common.collapse') }}</v-tooltip>
          </v-btn>
        </div>

        <!-- Collapsed: icon-only buttons -->
        <div v-if="sidebarCollapsed" class="sidebar-icons d-flex flex-column align-center ga-2 pt-2">
          <v-btn icon variant="text" size="small" @click="sidebarCollapsed = false">
            <v-icon>mdi-message-text-outline</v-icon>
            <v-tooltip activator="parent" location="left" content-class="tooltip-visible">{{ $t('common.notes') }}</v-tooltip>
          </v-btn>
          <v-btn icon variant="text" size="small" @click="sidebarCollapsed = false">
            <v-icon>mdi-history</v-icon>
            <v-tooltip activator="parent" location="left" content-class="tooltip-visible">{{ $t('common.activity') }}</v-tooltip>
          </v-btn>
        </div>

        <!-- Expanded: full sidebar content (scrollable) -->
        <div v-else class="sidebar-content">
          <slot name="sidebar" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SmartButton from './SmartButton.vue'
import { focusFirstField, isMacPlatform, useFormShortcuts } from '../composables/form-shortcuts'

export interface FormAction {
  label: string
  color?: string
  icon?: string
  handler: () => void
  show?: boolean
  loading?: boolean
  disabled?: boolean
  variant?: 'flat' | 'outlined' | 'text'
  /** Ctrl+S runs it (FR-22.52). Unset on every action: the one labelled „Запази" (`common.save`). */
  save?: boolean
  /**
   * Ctrl+Enter runs it: the action that finishes the job („Издай и печатай", „Запази и потвърди").
   * Unset on every action: the save action. Never simply the first one shown — on a posted
   * journal entry that is „Анулирай", and no shortcut should reach a step like that unasked.
   */
  primary?: boolean
}

export interface SmartButtonDef {
  label: string
  value: string | number
  icon: string
  /** A route inside this app. */
  to?: string
  /** A page in another app — build it with `appHref` (ui-shared/nav/navigate). */
  href?: string
  click?: () => void
  color?: string
}

export interface StatusDef {
  steps: string[]
  current: string
  colors?: Record<string, string>
}

const props = withDefaults(defineProps<{
  title: string
  subtitle?: string
  status?: StatusDef
  actions?: FormAction[]
  smartButtons?: SmartButtonDef[]
  loading?: boolean
  backTo?: string
  backLabel?: string
  entityId?: string
  /**
   * Focus the first field once the form renders. Unset: on a new document, which is a route
   * with a `new` segment (`/invoices/new`, `/products/new/edit`) and no `entityId`.
   */
  autofocus?: boolean
}>(), {
  // ⚠ An explicit undefined: a boolean prop left out is otherwise cast to `false`, which would
  // read as "never" instead of "decide from the route".
  autofocus: undefined,
})

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const shellRoot = ref<HTMLElement | null>(null)

// Right sidebar starts collapsed by default, persisted across pages so the user's
// preference sticks for the session.
const SIDEBAR_PREF_KEY = 'lgr:entity-form-sidebar:collapsed'
const sidebarCollapsed = ref(loadSidebarPref())

function loadSidebarPref(): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_PREF_KEY)
    if (raw === null) return true
    return raw === 'true'
  } catch { return true }
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try { localStorage.setItem(SIDEBAR_PREF_KEY, String(sidebarCollapsed.value)) } catch { /* ignore */ }
}

const visibleActions = computed(() =>
  (props.actions || []).filter(a => a.show !== false)
)

// ── FR-22.52: keyboard ──
const saveAction = computed(() =>
  visibleActions.value.find(a => a.save)
    ?? visibleActions.value.find(a => a.label === t('common.save'))
    ?? null,
)
const primaryAction = computed(() => visibleActions.value.find(a => a.primary) ?? saveAction.value)

useFormShortcuts({ root: shellRoot, save: () => saveAction.value, primary: () => primaryAction.value })

const mac = isMacPlatform()

function shortcutLabels(action: FormAction): string[] {
  const mod = mac ? '⌘' : `${t('keyboard.ctrl')}+`
  const out: string[] = []
  if (action === saveAction.value) out.push(`${mod}S`)
  if (action === primaryAction.value) out.push(`${mod}Enter`)
  return out
}

function ariaShortcuts(action: FormAction): string | undefined {
  const mod = mac ? 'Meta' : 'Control'
  const out: string[] = []
  if (action === saveAction.value) out.push(`${mod}+S`)
  if (action === primaryAction.value) out.push(`${mod}+Enter`)
  return out.length ? out.join(' ') : undefined
}

const isNewDocument = computed(() =>
  props.autofocus ?? (!props.entityId && /(^|\/)new(\/|$)/.test(route.path)),
)

let alive = true
onMounted(() => {
  if (isNewDocument.value) focusFirstField(() => shellRoot.value?.querySelector<HTMLElement>('.form-paper') ?? null, () => alive)
})
onBeforeUnmount(() => {
  alive = false
})

const currentStepIndex = computed(() =>
  props.status ? props.status.steps.indexOf(props.status.current) : -1
)

function getStepColor(step: string, idx: number): string {
  if (props.status?.colors?.[step]) return props.status.colors[step]
  if (idx <= currentStepIndex.value) return 'primary'
  return 'grey-lighten-2'
}

function goBack() {
  if (props.backTo) {
    router.push(props.backTo)
  } else {
    router.back()
  }
}
</script>

<style scoped>
/* ── Header ── */
.form-header-bar {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  flex-shrink: 0;
}

/* ── Content: fixed viewport height, no page scroll ── */
.form-content {
  height: calc(100vh - 96px); /* viewport minus app-bar(52) + header-bar(44) */
  width: 100%;
  overflow: hidden;
}

/* ── Left sheet ── */
.form-sheet {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.form-actions-bar {
  background: rgb(var(--v-theme-surface));
  border-bottom: thin solid rgba(var(--v-border-color), 0.12);
  flex-shrink: 0;
}

.smart-buttons-row {
  background: rgb(var(--v-theme-surface));
  border-bottom: thin solid rgba(var(--v-border-color), 0.12);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.form-paper-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.form-paper {
  background: rgb(var(--v-theme-surface)) !important;
  border: 1px solid rgba(var(--v-border-color), 0.18);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

/* Optional document-preview banner at the top of the paper (e.g. invoice header) */
.form-paper-header {
  border-bottom: 1px solid rgba(var(--v-border-color), 0.12);
}

.form-paper :deep(.v-card-text) {
  padding: 16px !important;
}

/* ── Compact form + plain input overrides ── */
.form-paper :deep(.v-row) {
  margin-top: -4px;
  margin-bottom: -4px;
}

.form-paper :deep(.v-col) {
  padding-top: 4px;
  padding-bottom: 4px;
}

.form-paper :deep(.v-input) {
  margin-bottom: 0;
}

/* Plain/underline style: no border box, just bottom line */
.form-paper :deep(.v-field) {
  --v-field-padding-start: 8px;
  --v-field-padding-end: 8px;
}

/* Hide the outlined box's border PIECES, never the outline itself: Vuetify renders an outlined
   field's floating label inside `.v-field__outline` (in its notch). `display: none` on the
   outline took that label with it, so every outlined field in every form lost its label the
   moment it held a value or had focus — a "receipt" with no "Type", a "30" with no "Payment
   terms", and From/To warehouse selects that showed nothing at all. */
.form-paper :deep(.v-field--variant-outlined .v-field__outline__start),
.form-paper :deep(.v-field--variant-outlined .v-field__outline__end),
.form-paper :deep(.v-field--variant-outlined .v-field__outline__notch::before),
.form-paper :deep(.v-field--variant-outlined .v-field__outline__notch::after) {
  border-color: transparent;
}

/* Line the floating label up with the input text (padding-start 8px above) — Vuetify's start
   segment is 12px wide, and the label adds its own 4px margin. */
.form-paper :deep(.v-field--variant-outlined .v-field__outline__start) {
  flex-basis: 4px;
}

.form-paper :deep(.v-field--variant-outlined) {
  border-bottom: 1px solid rgba(var(--v-border-color), 0.3);
  border-radius: 0;
}

.form-paper :deep(.v-field--variant-outlined:hover) {
  border-bottom-color: rgba(var(--v-border-color), 0.6);
}

.form-paper :deep(.v-field--variant-outlined.v-field--focused) {
  border-bottom: 2px solid rgb(var(--v-theme-primary));
}

.form-paper :deep(.v-input--density-default) {
  --v-input-control-height: 40px;
}

.form-paper :deep(.v-input--density-compact) {
  --v-input-control-height: 36px;
}

/* ── Right sidebar ── */
.form-sidebar {
  background: rgb(var(--v-theme-surface));
  border-left: thin solid rgba(var(--v-border-color), 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.2s ease, min-width 0.2s ease;
}

.form-sidebar:not(.sidebar-collapsed) {
  width: 340px;
  min-width: 340px;
}

.form-sidebar.sidebar-collapsed {
  width: 48px;
  min-width: 48px;
}

.sidebar-toggle {
  border-bottom: thin solid rgba(var(--v-border-color), 0.12);
  flex-shrink: 0;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

/* Thin scrollbar */
.form-paper-scroll,
.sidebar-content {
  scrollbar-width: thin;
  scrollbar-color: rgba(128,128,128,0.3) transparent;
}
.form-paper-scroll::-webkit-scrollbar,
.sidebar-content::-webkit-scrollbar {
  width: 5px;
}
.form-paper-scroll::-webkit-scrollbar-thumb,
.sidebar-content::-webkit-scrollbar-thumb {
  background: rgba(128,128,128,0.3);
  border-radius: 4px;
}

/* ── Mobile responsive ── */
@media (max-width: 960px) {
  .form-content {
    flex-direction: column;
    height: auto;
    overflow: visible;
  }

  .form-paper-scroll {
    overflow: visible;
  }

  .form-sidebar,
  .form-sidebar:not(.sidebar-collapsed),
  .form-sidebar.sidebar-collapsed {
    width: 100% !important;
    min-width: 100% !important;
    border-left: none;
    border-top: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
    max-height: 50vh;
    overflow-y: auto;
  }

  .sidebar-toggle {
    display: none;
  }

  .sidebar-icons {
    flex-direction: row !important;
    justify-content: center;
  }
}

/* Tighten compact-density inputs inside forms — collapses the message-row gap that
   Vuetify reserves for hint/error text when there's nothing to show. Saves ~16px per
   input and lets the 4-column layouts breathe. */
.form-paper :deep(.v-input--density-compact .v-input__details:empty) {
  min-height: 0;
  padding-top: 0;
}
.form-paper :deep(.v-input--density-compact:not(.v-input--error) .v-messages) {
  min-height: 0;
}
.form-paper :deep(.v-row.v-row--dense + .v-row.v-row--dense) {
  margin-top: 0;
}
</style>

<!-- Global tooltip contrast fix (unscoped) -->
<style>
.tooltip-visible {
  background: rgb(var(--v-theme-on-surface)) !important;
  color: rgb(var(--v-theme-surface)) !important;
  font-size: 0.75rem;
  opacity: 1 !important;
}
</style>
