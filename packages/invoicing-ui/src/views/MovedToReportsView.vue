<template>
  <v-container class="d-flex flex-column align-center justify-center" style="min-height: 40vh">
    <v-progress-circular indeterminate color="primary" class="mb-4" />
    <p class="text-body-2 text-medium-emphasis">{{ $t('reports.movedNotice') }}</p>
    <v-btn class="mt-3" variant="text" :href="target">{{ $t('reports.hub.title') }}</v-btn>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { appHref } from 'ui-shared/nav/navigate'

/**
 * FR-6.19a — redirect stub for the two report pages that moved into the Reports app.
 *
 * A Vue-Router `redirect` cannot do this: `/reports/*` is a DIFFERENT SPA, so the hop has
 * to be a full `window.location` navigation. The old routes keep their names
 * (`invoicing.aging-report`, `invoicing.reporting.export`) per the repo-wide constraint
 * that Playwright and `useGridColumns` key off route names.
 *
 * The query string is forwarded verbatim: an old bookmark carrying FR-05 grid state keeps
 * it, and the moved grids hydrate from exactly the same keys.
 */

const props = defineProps<{ to: string }>()

const target = computed(() => {
  const search = window.location.search || ''
  return appHref('reports', `/reports${props.to}${search}`)
})

onMounted(() => {
  // `replace`, not `assign`: Back should return where the user came from, not bounce off
  // this stub and forward again.
  window.location.replace(target.value)
})
</script>
