<template>
  <div class="product-group-documents">
    <table class="text-body-2">
      <thead>
        <tr>
          <th>{{ $t('accounting.productGroups.document') }}</th>
          <th>{{ $t('accounting.productGroups.date') }}</th>
          <th>{{ $t('accounting.productGroups.type') }}</th>
          <th>{{ $t('accounting.productGroups.rule') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in documents" :key="`${d.docId}:${d.rule}:${d.groupId ?? ''}`">
          <td><entity-link :label="d.number" :to="documentPath(d)" /></td>
          <td>{{ formatDate(d.day, { timeZone: 'UTC' }) }}</td>
          <td>{{ docType(d.type) }}</td>
          <td>{{ $t(ruleLabelKey(d.rule)) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="total > documents.length" class="text-caption text-medium-emphasis mt-1">
      {{ $t('accounting.productGroups.shownOf', { shown: documents.length, n: total }) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { formatDate } from 'ui-shared/format'
import EntityLink from 'ui-shared/components/EntityLink.vue'
import { documentPath, ruleLabelKey, type EvidenceDocument } from '../views/accounting/product-groups-page'

/**
 * FR-25 R3, slice 2: the documents behind a row of the product group review queue (a group they name, or those that
 * contradict the group learning gave), the newest first, and how many there are in all. The server sends the newest
 * of each (`REVIEW_DOCUMENTS_PER_GROUP`); the counts are always whole.
 */
defineProps<{
  documents: EvidenceDocument[]
  total: number
}>()

const { t, te } = useI18n()

function docType(type: string): string {
  const key = `invoicing.docType.${type}`
  return te(key) ? t(key) : type
}
</script>

<style scoped>
.product-group-documents table {
  border-collapse: collapse;
}
.product-group-documents th,
.product-group-documents td {
  padding: 2px 16px 2px 0;
  text-align: left;
  white-space: nowrap;
}
.product-group-documents th {
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
</style>
