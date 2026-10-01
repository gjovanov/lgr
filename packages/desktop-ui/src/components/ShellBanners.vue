<template>
  <div v-if="banners.length" class="d-flex flex-column ga-3 mb-5">
    <v-alert
      v-for="b in banners"
      :key="b.id"
      :type="b.severity"
      variant="tonal"
      density="comfortable"
      :data-banner="b.id"
    >
      <v-alert-title class="text-body-1 font-weight-medium">
        {{ $t(b.titleKey, b.params || {}) }}
      </v-alert-title>
      <div class="text-body-2 mt-1">{{ $t(b.bodyKey, b.params || {}) }}</div>
      <div v-if="b.action || b.secondary" class="mt-3 d-flex ga-2 flex-wrap">
        <v-btn
          v-if="b.action"
          size="small"
          variant="flat"
          :color="b.severity"
          :loading="busy === b.id"
          @click="run(b.id, b.action.kind)"
        >
          {{ $t(b.action.labelKey) }}
        </v-btn>
        <v-btn
          v-if="b.secondary"
          size="small"
          variant="outlined"
          :loading="busy === b.id + ':2'"
          @click="run(b.id + ':2', b.secondary.kind)"
        >
          {{ $t(b.secondary.labelKey) }}
        </v-btn>
      </div>
    </v-alert>
  </div>
</template>

<script setup lang="ts">
/**
 * FR-14.30's attention banners.
 *
 * ⚠ Every state must be nameable over the phone (C09's trap): each alert carries a TITLE in
 * words, not a colour alone, and `data-banner` carries a stable id so C15 can assert on the
 * condition rather than on translated text.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useShellState } from '../composables/useShellState'
import { createDiagnosticsBundle } from '../shell'

const { banners, load } = useShellState()
const router = useRouter()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()
const busy = ref<string | null>(null)

async function run(key: string, kind: 'register' | 'update' | 'retry' | 'diagnostics') {
  busy.value = key
  try {
    if (kind === 'register') {
      await router.push({ name: 'onboarding' })
      return
    }
    if (kind === 'diagnostics') {
      const path = await createDiagnosticsBundle()
      showSuccess(t('shell.diagnostics.created', { path }))
      return
    }
    // `retry` re-reads the shell's own view of the world; C10 makes the server probe real.
    // `update` is wired by C13 — until then the button must not pretend to have worked.
    if (kind === 'update') {
      showError(t('shell.common.notAvailableYet'))
      return
    }
    await load()
  } catch (e: any) {
    showError(String(e?.message || e))
  } finally {
    busy.value = null
  }
}
</script>
