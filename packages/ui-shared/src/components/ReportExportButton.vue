<template>
  <!-- FR-31.11: a list's Export is its report in Reports, which exports to Excel and PDF, opened on the list's filters. -->
  <v-btn
    v-if="allowed"
    variant="outlined"
    prepend-icon="mdi-download"
    :href="href"
    :title="$t('common.exportInReport')"
    data-testid="report-export"
    @click.prevent="goTo(href)"
  >
    {{ $t('common.export') }}
  </v-btn>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { goTo } from '../nav/navigate'
import { canOpenPage, pageById } from '../nav/page-registry'
import { sessionViewer } from '../composables/useStorageIdentity'
import { reportHref, type ReportQuery } from './report-export'

const props = defineProps<{
  /** The report's id in the registry: `stock-levels`, `stock-movements`, `inventory-valuation`. */
  report: string
  /** The list's filters, under the report's own parameter names. An empty one is left out. */
  query?: ReportQuery
}>()

/** Only for a person who may open the report: for anybody else it would lead to a refusal. */
const allowed = computed(() => {
  const page = pageById(`/reports/${props.report}`)
  return !!page && canOpenPage(page, sessionViewer())
})

const href = computed(() => reportHref(props.report, props.query))
</script>
