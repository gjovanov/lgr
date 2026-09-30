<template>
  <router-view />
  <v-snackbar
    v-model="snackbar.visible"
    :color="snackbar.color"
    :timeout="snackbar.timeout"
    location="bottom right"
  >
    {{ snackbar.message }}
    <template #actions>
      <v-btn variant="text" @click="hideSnackbar">Close</v-btn>
    </template>
  </v-snackbar>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { onViewRequested, reportReady, takePendingDeepLink, takePendingView } from './shell'

const { snackbar, hideSnackbar } = useSnackbar()
const router = useRouter()

onMounted(async () => {
  // ⚠ First, and before anything that could fail: this line in the log is what distinguishes
  // "the page never rendered" from "the app never started" (FR-14.10), and a blank window looks
  // identical either way to whoever reports it.
  await reportReady()

  // A `--view=` argument or a tray item picked a view before this page existed (FR-14.5).
  const pending = await takePendingView()
  if (pending) await router.push({ name: pending }).catch(() => {})

  // The tray and second-instance launches push views while it runs.
  onViewRequested(view => {
    router.push({ name: view }).catch(() => {})
  })

  // ⚠ A deep link is only CONSUMED here — never acted on. `enroll` must ask for confirmation
  // (FR-14.12), and the view that asks is Onboarding, which Rust has already routed to. Draining
  // it keeps a stale link from being re-applied on the next navigation.
  const link = await takePendingDeepLink()
  if (link) console.info('[shell] deep link pending:', link)
})
</script>
