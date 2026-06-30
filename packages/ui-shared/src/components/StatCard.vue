<template>
  <v-card
    :class="['stat-card', { 'stat-card--active': active, 'stat-card--clickable': clickable }]"
    :ripple="clickable"
    role="button"
    :aria-pressed="clickable ? String(!!active) : undefined"
    @click="clickable && $emit('click')"
  >
    <v-card-text class="d-flex align-center ga-3 py-3">
      <v-avatar v-if="icon" :color="color || 'primary'" variant="tonal" rounded size="44">
        <v-icon :icon="icon" />
      </v-avatar>
      <div class="flex-grow-1 stat-card__body">
        <div class="text-caption text-medium-emphasis text-truncate">{{ label }}</div>
        <v-skeleton-loader v-if="loading" type="text" width="80" class="mt-1 stat-card__skeleton" />
        <div v-else class="text-h6 font-weight-bold text-truncate" :class="valueClass">{{ value }}</div>
      </div>
      <v-chip
        v-if="trend"
        size="x-small"
        label
        variant="tonal"
        :color="trend.direction === 'up' ? 'success' : 'error'"
      >
        <v-icon start size="x-small">{{ trend.direction === 'up' ? 'mdi-trending-up' : 'mdi-trending-down' }}</v-icon>
        {{ trend.label ?? trend.value }}
      </v-chip>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/** Shape used by ListScaffold's `kpis` prop. */
export interface StatCardDef {
  key: string
  label: string
  value: string | number
  icon?: string
  /** theme token: primary | success | warning | error | info | secondary */
  color?: string
  trend?: { value: number; direction: 'up' | 'down'; label?: string }
  loading?: boolean
  active?: boolean
  /** filter patch applied when the card is clicked (drives KPI click-to-filter) */
  filter?: Record<string, any>
}

const props = defineProps<{
  label: string
  value: string | number
  icon?: string
  color?: string
  trend?: { value: number; direction: 'up' | 'down'; label?: string }
  loading?: boolean
  active?: boolean
  clickable?: boolean
}>()

defineEmits<{ click: [] }>()

const valueClass = computed(() => (props.color ? `text-${props.color}` : ''))
</script>

<style scoped>
.stat-card__body {
  min-width: 0;
}
.stat-card--clickable {
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
}
.stat-card--clickable:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}
.stat-card--active {
  border-color: rgb(var(--v-theme-primary)) !important;
}
.stat-card__skeleton :deep(.v-skeleton-loader__text) {
  margin: 0;
}
</style>
