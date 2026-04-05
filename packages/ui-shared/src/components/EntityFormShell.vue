<template>
  <div class="entity-form-shell">
    <!-- Header: Back + Actions (left) + Status Pipeline (right) -->
    <v-toolbar density="compact" flat class="form-header">
      <v-btn icon variant="text" size="small" @click="goBack">
        <v-icon>mdi-arrow-left</v-icon>
      </v-btn>

      <div class="d-flex align-center ga-1 flex-grow-1">
        <span class="text-subtitle-1 font-weight-bold ml-1">{{ title }}</span>
        <span v-if="subtitle" class="text-body-2 text-medium-emphasis ml-1">{{ subtitle }}</span>
      </div>

      <!-- Action buttons -->
      <template v-for="action in visibleActions" :key="action.label">
        <v-btn
          :color="action.color || 'primary'"
          :variant="action.variant || 'flat'"
          :loading="action.loading"
          :disabled="action.disabled"
          :prepend-icon="action.icon"
          size="small"
          class="ml-1"
          @click="action.handler"
        >
          {{ action.label }}
        </v-btn>
      </template>

      <!-- Status pipeline (inline) -->
      <div v-if="status" class="d-flex align-center ga-1 ml-4">
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
    </v-toolbar>

    <!-- Smart buttons row -->
    <div v-if="smartButtons?.length" class="smart-buttons-row d-flex align-center ga-2 px-4 py-2">
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

    <!-- Sheet content -->
    <v-divider />
    <div class="form-sheet pa-4">
      <slot />
    </div>

    <!-- Notes section -->
    <div v-if="$slots.notes" class="form-notes pa-4 pt-0">
      <v-divider class="mb-4" />
      <slot name="notes" />
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
.form-header {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.smart-buttons-row {
  background: rgba(var(--v-theme-surface-variant), 0.08);
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex-wrap: wrap;
}

.form-sheet {
  max-width: 1200px;
}
</style>
