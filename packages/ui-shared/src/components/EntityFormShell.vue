<template>
  <div class="entity-form-shell">
    <!-- Header: Back + Title -->
    <div class="form-header-bar d-flex align-center px-3 py-2">
      <v-btn icon variant="text" size="small" @click="goBack">
        <v-icon>mdi-arrow-left</v-icon>
        <v-tooltip activator="parent" location="bottom">{{ backLabel || $t('common.back') }}</v-tooltip>
      </v-btn>

      <div class="d-flex align-center ga-1 flex-grow-1">
        <span class="text-subtitle-1 font-weight-bold ml-1">{{ title }}</span>
        <span v-if="subtitle" class="text-body-2 text-medium-emphasis ml-1">{{ subtitle }}</span>
      </div>
    </div>

    <!-- Actions bar: buttons (left) + status pipeline (right) -->
    <div v-if="visibleActions.length || status" class="form-actions-bar d-flex align-center justify-space-between px-3 py-1">
      <div class="d-flex align-center ga-1">
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
      <div v-if="status" class="d-flex align-center ga-1">
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

    <!-- Main content area: sheet (left) + sidebar (right) -->
    <v-divider />
    <div class="form-content d-flex">
      <!-- Sheet: paper-framed card -->
      <div class="form-sheet flex-grow-1 pa-3">
        <v-card variant="outlined" class="form-paper" rounded="lg">
          <v-card-text class="pa-4">
            <slot />
          </v-card-text>
        </v-card>
      </div>

      <!-- Right sidebar: notes + audit log (always visible) -->
      <div class="form-sidebar">
        <slot name="sidebar" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
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
}

.form-actions-bar {
  background: rgba(var(--v-theme-surface-variant), 0.05);
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.smart-buttons-row {
  background: rgba(var(--v-theme-surface-variant), 0.08);
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex-wrap: wrap;
}

.form-content {
  min-height: calc(100vh - 160px);
}

.form-sheet {
  max-width: 1100px;
  min-width: 0;
}

.form-paper {
  border: 1px solid rgba(var(--v-border-color), 0.25);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.form-paper :deep(.v-card-text) {
  padding: 16px !important;
}

/* Compact form density overrides */
.form-paper :deep(.v-row) {
  margin-top: -4px;
  margin-bottom: -4px;
}

.form-paper :deep(.v-row + .v-row) {
  margin-top: 0;
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

.form-sidebar {
  width: 340px;
  min-width: 340px;
  min-height: calc(100vh - 140px);
  border-left: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 12px;
  overflow-y: auto;
  max-height: calc(100vh - 140px);
}

@media (max-width: 960px) {
  .form-content {
    flex-direction: column;
  }
  .form-sidebar {
    width: 100%;
    min-width: 100%;
    border-left: none;
    border-top: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
    max-height: none;
    min-height: auto;
  }
}
</style>
