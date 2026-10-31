<template>
  <!-- The session's own figures (`services/biz/cash-register/session-report.ts`): what its close
       prints after the Z-report, which counts only a device's fiscal receipts. -->
  <div data-testid="session-report">
    <div class="text-subtitle-2 mb-2">{{ $t('pos.sessionReport.title') }} — {{ report.sessionNumber }}</div>
    <v-table density="compact">
      <tbody>
        <tr><td>{{ $t('pos.sessionReport.sales') }}</td><td class="text-end">{{ report.counts.sales }}</td></tr>
        <tr><td>{{ $t('pos.sessionReport.stornos') }}</td><td class="text-end">{{ report.counts.stornos }}</td></tr>
        <tr v-if="report.counts.voided"><td>{{ $t('pos.sessionReport.voided') }}</td><td class="text-end">{{ report.counts.voided }}</td></tr>
        <tr><td>{{ $t('pos.sessionReport.fiscal') }}</td><td class="text-end">{{ report.counts.fiscal }}</td></tr>
        <tr><td>{{ $t('pos.sessionReport.text') }}</td><td class="text-end">{{ report.counts.text }}</td></tr>
        <tr v-if="report.counts.unprinted"><td>{{ $t('pos.sessionReport.unprinted') }}</td><td class="text-end">{{ report.counts.unprinted }}</td></tr>
        <template v-for="v in report.vat" :key="v.rate">
          <tr class="bg-surface-light"><td colspan="2" class="font-weight-medium">{{ $t('pos.sessionReport.vatRate', { rate: v.rate }) }}</td></tr>
          <tr><td class="ps-6">{{ $t('pos.sessionReport.net') }}</td><td class="text-end">{{ money(v.net) }}</td></tr>
          <tr><td class="ps-6">{{ $t('pos.sessionReport.vat') }}</td><td class="text-end">{{ money(v.vat) }}</td></tr>
          <tr><td class="ps-6">{{ $t('pos.sessionReport.gross') }}</td><td class="text-end">{{ money(v.gross) }}</td></tr>
        </template>
        <tr class="font-weight-bold"><td>{{ $t('pos.sessionReport.total') }}</td><td class="text-end" data-testid="session-report-total">{{ money(report.total) }}</td></tr>
        <tr><td>{{ $t('pos.sessionReport.cash') }}</td><td class="text-end">{{ money(report.byMethod.cash) }}</td></tr>
        <tr><td>{{ $t('pos.sessionReport.card') }}</td><td class="text-end">{{ money(report.byMethod.card) }}</td></tr>
        <tr v-if="report.byMethod.other"><td>{{ $t('pos.sessionReport.other') }}</td><td class="text-end">{{ money(report.byMethod.other) }}</td></tr>
        <tr v-if="report.change"><td>{{ $t('pos.sessionReport.change') }}</td><td class="text-end">{{ money(report.change) }}</td></tr>
        <tr><td>{{ $t('pos.sessionReport.opening') }}</td><td class="text-end">{{ money(report.drawer.opening) }}</td></tr>
        <tr v-if="report.drawer.expected !== undefined"><td>{{ $t('pos.sessionReport.expected') }}</td><td class="text-end">{{ money(report.drawer.expected) }}</td></tr>
        <tr v-if="report.drawer.counted !== undefined"><td>{{ $t('pos.sessionReport.counted') }}</td><td class="text-end">{{ money(report.drawer.counted) }}</td></tr>
        <tr v-if="report.drawer.difference !== undefined"><td>{{ $t('pos.sessionReport.difference') }}</td><td class="text-end">{{ money(report.drawer.difference) }}</td></tr>
        <tr v-if="report.documents"><td>{{ $t('pos.sessionReport.documents') }}</td><td class="text-end">{{ report.documents.first }} – {{ report.documents.last }}</td></tr>
        <tr v-if="report.receipts"><td>{{ $t('pos.sessionReport.receipts') }}</td><td class="text-end">{{ report.receipts.first }} – {{ report.receipts.last }}</td></tr>
        <tr v-if="report.zReportNumber"><td>{{ $t('pos.sessionReport.z') }}</td><td class="text-end">{{ report.zReportNumber }}</td></tr>
      </tbody>
    </v-table>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../store/app.store'

/** The wire shape of `SessionReport` (services/biz/cash-register/session-report.ts). */
export interface SessionReportData {
  sessionNumber: string
  currency: string
  counts: { sales: number; stornos: number; voided: number; fiscal: number; text: number; unprinted: number }
  vat: Array<{ rate: number; net: number; vat: number; gross: number }>
  total: number
  byMethod: { cash: number; card: number; other: number }
  change: number
  drawer: { opening: number; expected?: number; counted?: number; difference?: number }
  documents?: { first: string; last: string }
  receipts?: { first: string; last: string }
  zReportNumber?: string
}

const props = defineProps<{ report: SessionReportData }>()
const appStore = useAppStore()
const localeTag = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))
const money = (n: number) =>
  new Intl.NumberFormat(localeTag.value, { style: 'currency', currency: props.report.currency || 'EUR' }).format(Number(n) || 0)
</script>
