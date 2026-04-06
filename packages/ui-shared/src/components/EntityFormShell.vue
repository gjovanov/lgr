<template>
  <div class="entity-form-shell">
    <!-- Header: Back + Title -->
    <div class="form-header-bar d-flex align-center px-3 py-2">
      <v-btn icon variant="text" size="small" @click="goBack">
        <v-icon>mdi-arrow-left</v-icon>
        <v-tooltip activator="parent" location="bottom">{{ backLabel || 'Back' }}</v-tooltip>
      </v-btn>

      <div class="d-flex align-center ga-1 flex-grow-1">
        <span class="text-subtitle-1 font-weight-bold ml-1">{{ title }}</span>
        <span v-if="subtitle" class="text-body-2 text-medium-emphasis ml-1">{{ subtitle }}</span>
      </div>
    </div>

    <!-- Main content area: sheet (left) + sidebar (right) — full width -->
    <div class="form-content d-flex">
      <!-- Left: form sheet -->
      <div class="form-sheet flex-grow-1">
        <!-- Actions bar: positioned over the sheet area -->
        <div v-if="visibleActions.length || status" class="form-actions-bar d-flex align-center justify-space-between px-4 py-1">
          <div class="d-flex align-center ga-1 flex-wrap">
            <template v-for="action in visibleActions" :key="action.label">
              <v-btn
                :color="action.color || 'primary'"
                :variant="action.variant || 'flat'"
                :loading="action.loading"
                :disabled="action.disabled"
                :prepend-icon="action.icon"
                size="small"
                @click="action.handler"
              >
                {{ action.label }}
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
                {{ step }}
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
            :color="btn.color"
            @click="btn.click?.()"
          />
        </div>

        <!-- Paper card -->
        <div class="form-paper-wrapper pa-3">
          <v-card class="form-paper" rounded="lg" elevation="0">
            <v-card-text class="pa-4">
              <slot />
            </v-card-text>
          </v-card>
        </div>
      </div>

      <!-- Right sidebar: collapsible -->
      <div class="form-sidebar" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
        <!-- Collapse/expand toggle -->
        <div class="sidebar-toggle d-flex justify-center py-1">
          <v-btn
            icon
            variant="text"
            size="x-small"
            @click="sidebarCollapsed = !sidebarCollapsed"
          >
            <v-icon>{{ sidebarCollapsed ? 'mdi-chevron-left' : 'mdi-chevron-right' }}</v-icon>
            <v-tooltip activator="parent" location="left">{{ sidebarCollapsed ? 'Expand' : 'Collapse' }}</v-tooltip>
          </v-btn>
        </div>

        <!-- Collapsed: icon-only buttons -->
        <div v-if="sidebarCollapsed" class="sidebar-icons d-flex flex-column align-center ga-2 pt-2">
          <v-btn icon variant="text" size="small" @click="sidebarCollapsed = false">
            <v-icon>mdi-message-text-outline</v-icon>
            <v-tooltip activator="parent" location="left">Notes</v-tooltip>
          </v-btn>
          <v-btn icon variant="text" size="small" @click="sidebarCollapsed = false">
            <v-icon>mdi-history</v-icon>
            <v-tooltip activator="parent" location="left">Activity</v-tooltip>
          </v-btn>
        </div>

        <!-- Expanded: full sidebar content -->
        <div v-else class="sidebar-content pa-2">
          <slot name="sidebar" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import SmartButton from './SmartButton.vue'

export interface FormAction {
  label: string
  color?: string
  icon?: string
  handler: () => void
  show?: boolean
  loading?: boolean
  disabled?: boolean
  variant?: 'flat' | 'outlined' | 'text'
}

export interface SmartButtonDef {
  label: string
  value: string | number
  icon: string
  to?: string
  click?: () => void
  color?: string
}

export interface StatusDef {
  steps: string[]
  current: string
  colors?: Record<string, string>
}

const props = defineProps<{
  title: string
  subtitle?: string
  status?: StatusDef
  actions?: FormAction[]
  smartButtons?: SmartButtonDef[]
  loading?: boolean
  backTo?: string
  backLabel?: string
  entityId?: string
}>()

const router = useRouter()
const sidebarCollapsed = ref(false)

const visibleActions = computed(() =>
  (props.actions || []).filter(a => a.show !== false)
)

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
.form-header-bar {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
}

.form-content {
  min-height: calc(100vh - 100px);
  width: 100%;
}

/* ── Left sheet ── */
.form-sheet {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.form-actions-bar {
  background: rgb(var(--v-theme-surface));
  border-bottom: thin solid rgba(var(--v-border-color), 0.12);
  position: sticky;
  top: 0;
  z-index: 2;
}

.smart-buttons-row {
  background: rgb(var(--v-theme-surface));
  border-bottom: thin solid rgba(var(--v-border-color), 0.12);
  flex-wrap: wrap;
}

.form-paper-wrapper {
  flex: 1;
}

.form-paper {
  background: rgb(var(--v-theme-surface)) !important;
  border: 1px solid rgba(var(--v-border-color), 0.18);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.form-paper :deep(.v-card-text) {
  padding: 16px !important;
}

/* Compact form density overrides */
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

.form-paper :deep(.v-field) {
  --v-field-padding-start: 8px;
  --v-field-padding-end: 8px;
}

.form-paper :deep(.v-input--density-default) {
  --v-input-control-height: 40px;
}

/* ── Right sidebar ── */
.form-sidebar {
  background: rgb(var(--v-theme-surface));
  border-left: thin solid rgba(var(--v-border-color), 0.18);
  min-height: calc(100vh - 100px);
  overflow-y: auto;
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
}

.sidebar-content {
  height: calc(100% - 36px);
  overflow-y: auto;
}

/* ── Mobile responsive ── */
@media (max-width: 960px) {
  .form-content {
    flex-direction: column;
  }

  .form-sidebar,
  .form-sidebar:not(.sidebar-collapsed),
  .form-sidebar.sidebar-collapsed {
    width: 100% !important;
    min-width: 100% !important;
    border-left: none;
    border-top: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
    min-height: auto;
    max-height: 50vh;
  }

  .sidebar-toggle {
    display: none;
  }

  .sidebar-icons {
    flex-direction: row !important;
    justify-content: center;
  }
}
</style>
