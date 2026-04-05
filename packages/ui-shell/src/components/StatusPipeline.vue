<template>
  <div class="status-pipeline d-flex align-center ga-1">
    <template v-for="(step, idx) in steps" :key="step">
      <v-chip
        :color="getColor(step, idx)"
        :variant="getVariant(step, idx)"
        size="small"
        label
      >
        <v-icon v-if="isCompleted(idx)" start size="small">mdi-check</v-icon>
        {{ step }}
      </v-chip>
      <v-icon v-if="idx < steps.length - 1" size="x-small" color="grey">mdi-chevron-right</v-icon>
    </template>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  steps: string[]
  current: string
  colors?: Record<string, string>
}>()

function currentIndex(): number {
  return props.steps.indexOf(props.current)
}

function isCompleted(idx: number): boolean {
  return idx < currentIndex()
}

function getColor(step: string, idx: number): string {
  if (props.colors?.[step]) return props.colors[step]
  if (idx <= currentIndex()) return 'primary'
  return 'grey-lighten-2'
}

function getVariant(step: string, idx: number): 'flat' | 'outlined' {
  const ci = currentIndex()
  if (idx < ci) return 'flat'     // completed
  if (idx === ci) return 'flat'   // current
  return 'outlined'               // future
}
</script>

<style scoped>
.status-pipeline {
  flex-wrap: wrap;
}
</style>
