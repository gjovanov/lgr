<template>
  <div class="mb-4 d-flex align-center">
    <v-btn
      icon="mdi-arrow-left"
      variant="text"
      size="small"
      class="mr-2"
      :title="backLabel"
      :aria-label="backLabel"
      @click="back"
    />
    <div>
      <h1 class="text-h5 mb-1">{{ title }}</h1>
      <p v-if="subtitle" class="text-body-2 text-grey mb-0">{{ subtitle }}</p>
    </div>
    <v-spacer />
    <slot name="actions" />
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

/**
 * The header a page in a CARD-HUB app wears — one whose hub screen *is* its navigation.
 *
 * ⚠ Without it such a page is a dead end. These apps render no menu bar by design, so the
 * only way out is the browser's Back button — and that fails outright when the page was
 * reached from a ★ favorite, a shared link, or a cross-app redirect, because there is no
 * in-app history to go back to. The user lands somewhere with no visible exit.
 *
 * ⚠ `AppShell` never renders `AppBreadcrumb`, so every route's `meta.breadcrumb` is inert
 * data. Wiring breadcrumbs into the shell would change the layout of every app in the suite;
 * a back affordance on the pages that need one does not.
 *
 * Navigation is an explicit push to the hub rather than `router.back()`, so the button always
 * lands in the same predictable place no matter how the page was entered.
 *
 * The markup matches the header these pages already hand-rolled — back arrow, title over
 * subtitle, spacer, then whatever controls the page puts in the `actions` slot — so adopting
 * it is a wrap rather than a redesign.
 *
 * NOTE: `reports-ui/src/components/ReportPageHeader.vue` is the same idea, predating this and
 * used in 8 views. Consolidating those onto this is a clean follow-up; they were left alone
 * rather than touching 8 working screens for a navigation fix in another app.
 */

const props = withDefaults(defineProps<{
  title: string
  subtitle?: string
  /** Where the arrow goes. The app's hub, for every current caller. */
  to?: string
  backLabel?: string
}>(), {
  to: '/',
  backLabel: 'Back',
})

const router = useRouter()

function back() {
  router.push(props.to)
}
</script>
