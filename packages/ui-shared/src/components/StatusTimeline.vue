<template>
  <v-timeline v-if="sorted.length" density="compact" side="end">
    <v-timeline-item
      v-for="(entry, idx) in sorted"
      :key="idx"
      :dot-color="colorFor(entry.status)"
      size="small"
    >
      <div class="d-flex flex-column">
        <div class="text-subtitle-2">
          <template v-if="entry.fromStatus">
            <span class="text-medium-emphasis">{{ entry.fromStatus }}</span>
            <v-icon size="x-small" class="mx-1">mdi-arrow-right</v-icon>
          </template>
          <strong>{{ entry.status }}</strong>
        </div>
        <div class="text-caption text-medium-emphasis">{{ fmtDate(entry.changedAt) }}</div>
        <div v-if="entry.reason" class="text-caption">{{ entry.reason }}</div>
      </div>
    </v-timeline-item>
  </v-timeline>
  <div v-else class="text-medium-emphasis text-center pa-4">
    {{ $t ? $t('common.noHistory') : 'No history' }}
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  history: Array<{ status: string; fromStatus?: string; changedAt: string | Date; changedBy?: any; reason?: string }>
  colorFn?: (s: string) => string
}>()

const sorted = computed(() => {
  return [...(props.history || [])].sort((a, b) => {
    const ta = new Date(a.changedAt).getTime()
    const tb = new Date(b.changedAt).getTime()
    return ta - tb
  })
})

function colorFor(status: string): string {
  return props.colorFn ? props.colorFn(status) : 'primary'
}

function fmtDate(d: string | Date): string {
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}
</script>
