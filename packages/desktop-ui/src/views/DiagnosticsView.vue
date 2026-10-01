<template>
  <ShellFrame>
    <v-container class="py-6" style="max-width: 760px">
      <h1 class="text-h5 mb-5">{{ $t('shell.diagnostics.title') }}</h1>

      <v-card variant="flat" border>
        <v-card-text>
          <p class="text-body-2 mb-4">{{ $t('shell.diagnostics.intro') }}</p>

          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-package-variant-closed"
            :loading="busy"
            data-action="create-bundle"
            @click="create"
          >
            {{ busy ? $t('shell.diagnostics.creating') : $t('shell.diagnostics.create') }}
          </v-btn>

          <v-alert
            v-if="path"
            type="success"
            variant="tonal"
            density="comfortable"
            class="mt-4"
            data-banner="bundle-created"
          >
            <div class="text-body-2">{{ $t('shell.diagnostics.created', { path }) }}</div>
            <div class="mt-3 d-flex ga-2">
              <v-btn size="small" variant="outlined" prepend-icon="mdi-folder-open-outline" @click="reveal">
                {{ $t('shell.diagnostics.reveal') }}
              </v-btn>
              <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyPath">
                {{ $t('shell.common.copy') }}
              </v-btn>
            </div>
          </v-alert>

          <v-alert
            v-if="error"
            type="error"
            variant="tonal"
            density="comfortable"
            class="mt-4"
            data-banner="bundle-failed"
          >
            {{ $t('shell.diagnostics.failed', { reason: error }) }}
          </v-alert>
        </v-card-text>
      </v-card>
    </v-container>
  </ShellFrame>
</template>

<script setup lang="ts">
/**
 * Triggers C08's bundle and says where it landed (C09).
 *
 * ⚠ The path is shown and copyable, not just opened. Support asks "where is it?" over the
 * phone, and a folder that opened on the user's screen is not an answer anyone can read out.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ShellFrame from '../components/ShellFrame.vue'
import { createDiagnosticsBundle, openLogFolder } from '../shell'

const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const busy = ref(false)
const path = ref('')
const error = ref('')

async function create() {
  busy.value = true
  error.value = ''
  try {
    path.value = await createDiagnosticsBundle()
  } catch (e: any) {
    error.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function reveal() {
  try {
    await openLogFolder()
  } catch (e: any) {
    showError(String(e?.message || e))
  }
}

async function copyPath() {
  try {
    await navigator.clipboard.writeText(path.value)
    showSuccess(t('shell.common.copied'))
  } catch {
    // A webview without clipboard permission still shows the path on screen, which is the
    // thing that matters; a failed copy is not worth an error dialog.
  }
}
</script>
