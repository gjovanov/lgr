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
      <v-btn variant="text" @click="hideSnackbar">{{ $t('shell.common.close') }}</v-btn>
    </template>
  </v-snackbar>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { onViewRequested, reportReady, takePendingDeepLink, takePendingView, getSettings } from './shell'
import { resolveLocale } from './plugins/i18n'
import { useShellState } from './composables/useShellState'

const { snackbar, hideSnackbar } = useSnackbar()
const router = useRouter()
const { locale } = useI18n()
const { pendingDeepLink } = useShellState()

onMounted(async () => {
  // ⚠ First, and before anything that could fail: this line in the log is what distinguishes
  // "the page never rendered" from "the app never started" (FR-14.10), and a blank window looks
  // identical either way to whoever reports it.
  await reportReady()

  // ⚠ The stored choice wins; an empty `locale` means follow the OS, which the i18n instance
  // already did at construction. Doing this here rather than in `main.ts` keeps the mount
  // synchronous — reading settings is IPC, and a window that renders nothing until Rust
  // answers is the blank window FR-14.10 exists to tell apart from a crash.
  try {
    const cfg = await getSettings()
    if (cfg) locale.value = resolveLocale(cfg.locale)
  } catch {
    /* no shell, or an older one: the OS locale stands */
  }

  // A `--view=` argument or a tray item picked a view before this page existed (FR-14.5).
  const pending = await takePendingView()
  if (pending) await router.push({ name: pending }).catch(() => {})

  // The tray and second-instance launches push views while it runs.
  onViewRequested(view => {
    router.push({ name: view }).catch(() => {})
  })

  // ⚠ A deep link is CONSUMED here and acted on nowhere. `enroll` must ask for confirmation
  // (FR-14.12), and the view that asks is Onboarding — so the payload is parked for it rather
  // than dropped. Rust hands the link over only once, which is why exactly one place may call
  // the command.
  const link = await takePendingDeepLink()
  if (link) {
    pendingDeepLink.value = link
    const isEnroll = /^lgr:\/\/enroll\b/i.test(link) || /^lgr:\/{0,2}enroll\b/i.test(link)
    if (isEnroll) await router.push({ name: 'onboarding' }).catch(() => {})
  }
})
</script>
