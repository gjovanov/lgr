<template>
  <div v-if="rows.length" class="mb-3">
    <div v-for="(r, i) in rows" :key="i" class="text-body-2 mb-1" :class="r.severity === 'error' ? 'text-error' : 'text-warning'">
      <v-icon :icon="r.severity === 'error' ? 'mdi-close-circle-outline' : 'mdi-alert-outline'" size="x-small" class="mr-1" />
      {{ r.text }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Everything the engine flagged about one analysed document, in the order it matters:
 * an already-imported duplicate first, then mapping warnings, then failed arithmetic
 * checks from the deterministic validator.
 */
import { computed } from 'vue'
import type { AnalyzedDoc } from '../../composables/useDocImport'

const props = defineProps<{ doc: AnalyzedDoc }>()

const rows = computed(() => {
  const out: Array<{ text: string; severity: 'warning' | 'error' }> = []
  const d = props.doc
  if (d.duplicate) out.push({ text: `${d.duplicate.reason} (${d.duplicate.number})`, severity: 'warning' })
  for (const w of d.diagnostics?.warnings || []) out.push({ text: w, severity: 'warning' })
  for (const c of d.validation?.checks || []) {
    if (c.status === 'fail') out.push({ text: `${c.check}: ${c.details}`, severity: 'error' })
  }
  return out
})
</script>
