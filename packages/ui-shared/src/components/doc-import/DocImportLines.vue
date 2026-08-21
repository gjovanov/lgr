<template>
  <v-table density="compact" class="doc-import-lines">
    <thead>
      <tr>
        <th style="width: 32px" />
        <th>{{ $t('docImport.description') }}</th>
        <th class="text-right" style="width: 90px">{{ $t('common.qty') }}</th>
        <th class="text-right" style="width: 110px">{{ $t('invoicing.unitPrice') }}</th>
        <th class="text-right" style="width: 110px">{{ $t('invoicing.lineTotal') }}</th>
        <th style="width: 140px">{{ $t('docImport.product') }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(l, i) in lines" :key="i">
        <td>
          <v-icon
            :icon="diag(i).matched ? 'mdi-check-circle' : 'mdi-help-circle-outline'"
            :color="diag(i).matched ? 'success' : 'warning'"
            size="x-small"
          />
        </td>
        <td class="text-body-2">
          {{ l.description }}
          <div v-if="l.sourceText && l.sourceText !== l.description" class="text-caption text-medium-emphasis">
            {{ l.sourceText }}
          </div>
        </td>
        <td class="text-body-2 text-right">{{ l.quantity }}</td>
        <td class="text-body-2 text-right">{{ l.unitPrice }}</td>
        <td class="text-body-2 text-right">{{ l.lineTotal }}</td>
        <td>
          <v-chip v-if="diag(i).matched" size="x-small" variant="tonal" :color="matchColor(diag(i).matchedBy)">
            {{ diag(i).matchedBy ? $t('docImport.matchedBy.' + diag(i).matchedBy) : $t('docImport.matchedBy.manual') }}
          </v-chip>
          <v-btn v-else size="x-small" variant="tonal" color="primary" @click="$emit('pick', { doc, index: i })">
            {{ $t('docImport.pickProduct') }}
          </v-btn>
        </td>
      </tr>
      <tr v-if="!lines.length">
        <td colspan="6" class="text-center text-medium-emphasis py-3">{{ $t('docImport.noLines') }}</td>
      </tr>
    </tbody>
  </v-table>
</template>

<script setup lang="ts">
/**
 * One analysed document's lines, showing how each found its product — and offering a
 * picker for the ones that didn't. An unmatched invoice line is still importable (it
 * stays free-text and the totals remain right), but it will not move stock, so the
 * distinction has to be visible before committing.
 */
import { computed } from 'vue'
import type { AnalyzedDoc, LineDiagnostic } from '../../composables/useDocImport'

const props = defineProps<{ doc: AnalyzedDoc }>()
defineEmits<{ pick: [payload: { doc: AnalyzedDoc; index: number }] }>()

const lines = computed<any[]>(() => props.doc.mapped?.lines || [])
const EMPTY: LineDiagnostic = { sourceText: '', matched: false, matchedBy: null }
const diag = (i: number): LineDiagnostic => props.doc.diagnostics?.perLine?.[i] || EMPTY

/** Alias and exact matches are trustworthy; an AI match deserves a second look. */
function matchColor(by: LineDiagnostic['matchedBy']): string {
  if (by === 'ai') return 'warning'
  if (by === 'alias') return 'info'
  return 'success'
}
</script>

<style scoped>
.doc-import-lines :deep(td),
.doc-import-lines :deep(th) {
  padding-inline: 8px !important;
}
</style>
