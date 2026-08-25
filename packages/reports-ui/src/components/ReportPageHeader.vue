<template>
  <div class="mb-4">
    <div class="d-flex align-center ga-2">
      <v-btn
        icon="mdi-arrow-left"
        variant="text"
        size="small"
        :title="$t('reports.backToHub')"
        :aria-label="$t('reports.backToHub')"
        @click="back"
      />
      <h1 class="text-h5">{{ title }}</h1>
    </div>
    <p v-if="subtitle" class="text-body-2 text-medium-emphasis mt-1 ml-10 mb-0">{{ subtitle }}</p>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

/**
 * FR-06 (#14) — the header every report page wears.
 *
 * This app has no menu bar by design (the card hub IS the navigation), so without a back
 * affordance a report is a dead end: the only way out is the browser's Back button, and
 * that fails outright when the page was reached from a ★ favorite, a shared link, or one of
 * the invoicing redirect stubs — there is no in-app history to go back to.
 *
 * `AppShell` never renders `AppBreadcrumb`, so the routes' `meta.breadcrumb` is inert and
 * cannot serve this purpose. Wiring breadcrumbs into the shell would change every app;
 * this stays inside reports-ui.
 *
 * Navigation is an explicit push to the hub rather than `router.back()`, so the button
 * always lands in the same, predictable place regardless of how the page was entered.
 */

defineProps<{
  title: string
  subtitle?: string
}>()

const router = useRouter()

function back() {
  router.push('/')
}
</script>
