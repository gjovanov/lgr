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
      <slot v-if="!loadError" name="header-actions" />
    </div>

    <!-- Main content area: sheet (left) + sidebar (right) — full width, fixed height -->
    <div class="form-content d-flex">
      <!-- Left: form sheet (scrollable) -->
      <div class="form-sheet flex-grow-1">
        <!-- Actions bar: sticky -->
        <div v-if="!loadError && (visibleActions.length || status)" class="form-actions-bar d-flex align-center justify-space-between ga-2 px-4 py-1">
          <FormActionBar
            class="form-actions-bar__actions"
            :actions="visibleActions"
            size="small"
            :shortcut-labels="shortcutLabels"
            :aria-shortcuts="ariaShortcuts"
          />

          <!-- Status pipeline -->
          <div v-if="status" class="form-actions-bar__status d-flex align-center ga-1 flex-wrap">
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
        <div v-if="!loadError && smartButtons?.length" class="smart-buttons-row d-flex align-center ga-2 px-4 py-1">
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
            <!-- FR-31.6: a record that could not be read says so, with Back and Retry, and shows no form and no
                 action. It used to look like an empty draft: „Edit Invoice", a Draft chip, enabled Issue and Save. -->
            <v-card v-if="loadError" class="form-paper" rounded="lg" elevation="0" data-testid="form-load-error" :data-failure="loadError">
              <EmptyState
                :icon="loadError === 'not_found' ? 'mdi-file-question-outline' : loadError === 'forbidden' ? 'mdi-lock-outline' : 'mdi-cloud-alert-outline'"
                :title="$t(`common.loadFailure.${loadError}.title`)"
                :description="$t(`common.loadFailure.${loadError}.text`)"
              >
                <template #actions>
                  <v-btn variant="text" data-testid="form-load-error-back" @click="goBack">{{ backLabel || $t('common.back') }}</v-btn>
                  <v-btn color="primary" variant="flat" data-testid="form-load-error-retry" @click="emit('retry')">{{ $t('common.retry') }}</v-btn>
                </template>
              </EmptyState>
            </v-card>
            <v-card v-else class="form-paper" rounded="lg" elevation="0">
              <!-- FR-31.8: a refused save, issue, delete or confirm is said here, and stays until it is closed or the
                   next action succeeds; a toast went after five seconds. -->
              <v-alert
                v-if="refusal"
                type="error"
                variant="tonal"
                density="compact"
                class="ma-3 mb-0"
                closable
                data-testid="form-refusal"
                @click:close="emit('dismiss-refusal')"
              >
                {{ refusal }}
              </v-alert>
              <div v-if="$slots['document-header']" class="form-paper-header">
                <slot name="document-header" />
              </div>
              <v-card-text class="pa-4">
                <slot />
                <!-- The same actions again at the foot of a long form (`bottom-actions`), so nobody scrolls
                     back up for them. It is the list the bar under the title draws, in the same order: an
                     action is offered in both places or in neither. -->
                <template v-if="bottomActions && visibleActions.length">
                  <v-divider class="my-4" />
                  <FormActionBar
                    class="form-bottom-actions pb-2"
                    :actions="visibleActions"
                    test-id-suffix="-bottom"
                    :shortcut-labels="shortcutLabels"
                    :aria-shortcuts="ariaShortcuts"
                    data-testid="form-bottom-actions"
                  />
                </template>
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
            :aria-label="sidebarCollapsed ? $t('common.expand') : $t('common.collapse')"
            @click="toggleSidebar"
          >
            <v-icon>{{ sidebarCollapsed ? 'mdi-chevron-left' : 'mdi-chevron-right' }}</v-icon>
            <v-tooltip activator="parent" location="left" content-class="tooltip-visible">{{ sidebarCollapsed ? $t('common.expand') : $t('common.collapse') }}</v-tooltip>
          </v-btn>
        </div>

        <!-- Collapsed: icon-only buttons -->
        <div v-if="sidebarCollapsed" class="sidebar-icons d-flex flex-column align-center ga-2 pt-2">
          <v-btn icon variant="text" size="small" :aria-label="$t('common.notes')" @click="sidebarCollapsed = false">
            <v-icon>mdi-message-text-outline</v-icon>
            <v-tooltip activator="parent" location="left" content-class="tooltip-visible">{{ $t('common.notes') }}</v-tooltip>
          </v-btn>
          <v-btn icon variant="text" size="small" :aria-label="$t('common.activity')" @click="sidebarCollapsed = false">
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
import { inModule } from '../nav/open-page'
import { useI18n } from 'vue-i18n'
import SmartButton from './SmartButton.vue'
import FormActionBar from './FormActionBar.vue'
import EmptyState from './EmptyState.vue'
import type { LoadFailure } from '../composables/load-failure'
import { focusFirstField, isMacPlatform, useFormShortcuts } from '../composables/form-shortcuts'
import { capShows, type CapValue } from '../access/v-cap'

export interface FormAction {
  label: string
  /** A theme colour. Unset: primary. `''`: none, the plain outlined button of a side action (Print). */
  color?: string
  icon?: string
  handler: () => void
  show?: boolean
  loading?: boolean
  disabled?: boolean
  variant?: 'flat' | 'outlined' | 'text'
  /** A name that does not change with the language: what the row is keyed by, and `data-action` on its button. */
  key?: string
  /** `data-testid` of its button. A second row of the same actions adds its suffix (`-bottom`). */
  testId?: string
  /** A longer word on what it does, as the button's native tooltip. */
  title?: string
  /** Said on hover while it is disabled: why, and what to do first. */
  disabledHint?: string
  /** A second, icon-only half joined to the button: the same action with options („Печат" | „Печат с настройки…"). */
  more?: { icon: string; label: string; handler: () => void; testId?: string }
  /** A quiet marker shown in front of it (FR-10.9: when the document was last e-mailed). */
  note?: { text: string; title?: string; icon?: string; color?: string }
  /**
   * Where the row is too narrow for every label, this action shows as its icon alone (its label the tooltip),
   * the lowest number first. Unset, or with no icon: it always keeps its label.
   */
  collapse?: number
  /** Ctrl+S runs it (FR-22.52). Unset on every action: the one labelled „Запази" (`common.save`). */
  save?: boolean
  /**
   * Ctrl+Enter runs it: the action that finishes the job („Издай и печатай", „Запази и потвърди").
   * Unset on every action: the save action. Never simply the first one shown — on a posted
   * journal entry that is „Анулирай", and no shortcut should reach a step like that unasked.
   */
  primary?: boolean
  /**
   * FR-27.7: shown only to a role holding one of these capabilities (`v-cap`'s rule): a form a role only reads has no
   * Save, and Ctrl+S does nothing.
   */
  cap?: CapValue
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
  /** Draw the actions a second time at the foot of the form: the same list, for a form long enough to scroll. */
  bottomActions?: boolean
  /**
   * Focus the first field once the form renders. Unset: on a new document, which is a route
   * with a `new` segment (`/invoices/new`, `/products/new/edit`) and no `entityId`.
   */
  autofocus?: boolean
  /**
   * FR-31.6: the record could not be read (`loadFailureOf`): the form says so with Back and Retry (`@retry`), and
   * shows no field and no action. Unset while it loads and once it has loaded.
   */
  loadError?: LoadFailure | null
  /** FR-31.8: why the last action was refused, said at the top of the form until `@dismiss-refusal` or a success. */
  refusal?: string | null
}>(), {
  // ⚠ An explicit undefined: a boolean prop left out is otherwise cast to `false`, which would
  // read as "never" instead of "decide from the route".
  autofocus: undefined,
})

const emit = defineEmits<{
  /** Read the record again, after a failed load. */
  retry: []
  /** The person closed the refusal. */
  'dismiss-refusal': []
}>()

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
  try { localStorage.setItem(SIDEBAR_PREF_KEY, String(sidebarCollapsed.value)) } catch { /* Storage refused (private browsing): the sidebar opens as it always does. */ }
}

// A record that did not load offers nothing to do with it: no Save, Issue, Delete or Print, and no shortcut.
const visibleActions = computed(() =>
  props.loadError ? [] : (props.actions || []).filter(a => a.show !== false && capShows(a.cap))
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
    // FR-24.4: back-to is relative to the module; the router names it under the module's shell.
    router.push(inModule(route, props.backTo))
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

/* The actions take what the status pipeline leaves, and fit themselves into it (`FormActionBar`): their width
   must not depend on how many labels they show, or the fitting would chase itself. The pipeline keeps to its
   own width up to a share of the bar, and wraps its steps past it, so the actions are never left with nothing. */
.form-actions-bar__actions {
  flex: 1 1 0;
  min-width: 0;
}

.form-actions-bar__status {
  flex: 0 1 auto;
  max-width: 60%;
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

  /* No room for the actions beside the pipeline: each takes a line of its own. */
  .form-actions-bar {
    flex-wrap: wrap;
  }

  .form-actions-bar__actions {
    flex-basis: 100%;
  }

  /* A form that offers nothing now (a cancelled order) has no line of actions to leave a gap for.
     (`!important`: the row is a `d-flex`, and Vuetify's utilities are.) */
  .form-actions-bar__actions:empty {
    display: none !important;
  }

  .form-actions-bar__status {
    max-width: 100%;
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
