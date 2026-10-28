<template>
  <ShellFrame>
    <v-container class="py-6" style="max-width: 760px">
      <h1 class="text-h5 mb-5">{{ $t('shell.settings.title') }}</h1>

      <v-form v-if="form" @submit.prevent="onSave">
        <v-card variant="flat" border class="mb-4">
          <v-card-text>
            <v-text-field
              v-model="form.serverUrl"
              :label="$t('shell.settings.serverUrl')"
              :hint="$t('shell.settings.serverUrlHint')"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mb-4"
              data-field="server-url"
            />
            <v-text-field
              v-model="form.desktopName"
              :label="$t('shell.settings.desktopName')"
              :hint="$t('shell.settings.desktopNameHint')"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mb-4"
              data-field="desktop-name"
            />

            <!--
              ⚠ Read-only when an admin set it (C09). The person in front of the machine cannot
              change it, and a disabled field with no explanation reads as a bug — so the reason
              is in the hint, not in a tooltip nobody hovers.
            -->
            <v-text-field
              :model-value="startPathDisplay"
              :label="$t('shell.settings.startPath')"
              :hint="managed ? $t('shell.settings.startPathManaged') : $t('shell.settings.startPathDefault')"
              persistent-hint
              readonly
              :disabled="managed"
              :append-inner-icon="managed ? 'mdi-lock-outline' : undefined"
              variant="outlined"
              density="comfortable"
              data-field="start-path"
            />
          </v-card-text>
        </v-card>

        <v-card variant="flat" border class="mb-4">
          <v-card-text>
            <v-switch
              v-model="form.autostart"
              :label="$t('shell.settings.autostart')"
              color="primary"
              density="comfortable"
              hide-details
              data-field="autostart"
            />
            <v-switch
              v-model="form.openLgrOnLaunch"
              :label="$t('shell.settings.openLgrOnLaunch')"
              :hint="$t('shell.settings.openLgrOnLaunchHint')"
              persistent-hint
              color="primary"
              density="comfortable"
              data-field="open-on-launch"
            />
            <!-- FR-20.32 — a shop server opens in LGR Desktop's own window, whatever this says: a
                 browser cannot trust its certificate, and the window's way in stays in the window. -->
            <v-switch
              v-model="form.openInSystemBrowser"
              :label="$t('shell.settings.openInSystemBrowser')"
              :disabled="!!status?.serverPin"
              :hint="status?.serverPin ? $t('shell.settings.systemBrowserMaster') : undefined"
              :persistent-hint="!!status?.serverPin"
              :hide-details="!status?.serverPin"
              color="primary"
              density="comfortable"
              class="mt-2"
              data-field="system-browser"
            />
            <v-switch
              v-model="form.autoUpdate"
              :label="$t('shell.settings.autoUpdate')"
              :hint="$t('shell.settings.autoUpdateHint')"
              persistent-hint
              color="primary"
              density="comfortable"
              class="mt-2"
              data-field="auto-update"
            />
          </v-card-text>
        </v-card>

        <v-card variant="flat" border class="mb-4">
          <v-card-text>
            <v-select
              v-model="form.locale"
              :items="localeItems"
              item-title="label"
              item-value="value"
              :label="$t('shell.settings.language')"
              variant="outlined"
              density="comfortable"
              class="mb-4"
              data-field="language"
            />
            <v-select
              v-model="form.logLevel"
              :items="logLevels"
              :label="$t('shell.settings.logLevel')"
              variant="outlined"
              density="comfortable"
              class="mb-4"
              data-field="log-level"
            />
            <v-text-field
              v-model="form.proxy"
              :label="$t('shell.settings.proxy')"
              :hint="$t('shell.settings.proxyHint')"
              persistent-hint
              variant="outlined"
              density="comfortable"
              placeholder="http://proxy.example:8080"
              data-field="proxy"
            />
          </v-card-text>
        </v-card>

        <v-card variant="flat" border class="mb-4">
          <v-card-item>
            <v-card-title class="text-subtitle-1">{{ $t('shell.settings.rotateKey') }}</v-card-title>
            <v-card-subtitle class="text-wrap">{{ $t('shell.settings.rotateKeyHint') }}</v-card-subtitle>
          </v-card-item>
          <v-card-actions class="px-4 pb-4 pt-0">
            <v-btn
              variant="outlined"
              size="small"
              :disabled="!isRegistered"
              :loading="rotating"
              data-action="rotate-key"
              @click="rotateDialog = true"
            >
              {{ $t('shell.settings.rotateKey') }}
            </v-btn>
            <span v-if="!isRegistered" class="text-caption text-medium-emphasis ml-3">
              {{ $t('shell.settings.rotateKeyNeedsRegistration') }}
            </span>
          </v-card-actions>
        </v-card>

        <div class="d-flex justify-end">
          <v-btn color="primary" variant="flat" :loading="saving" type="submit" data-action="save">
            {{ $t('shell.common.save') }}
          </v-btn>
        </div>
      </v-form>

      <!-- Changing the server address unregisters this desktop (FR-14.32) -->
      <v-dialog v-model="serverDialog" max-width="520" persistent>
        <v-card>
          <v-card-title class="text-subtitle-1">{{ $t('shell.settings.serverUrlChange.title') }}</v-card-title>
          <v-card-text class="text-body-2">
            {{ $t('shell.settings.serverUrlChange.body', { current: originalServerUrl, next: form?.serverUrl }) }}
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="cancelServerChange">{{ $t('shell.common.cancel') }}</v-btn>
            <v-btn color="warning" variant="flat" :loading="saving" @click="commit">
              {{ $t('shell.settings.serverUrlChange.confirm') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-dialog v-model="rotateDialog" max-width="480">
        <v-card>
          <v-card-title class="text-subtitle-1">{{ $t('shell.settings.rotateKeyConfirm.title') }}</v-card-title>
          <v-card-text class="text-body-2">{{ $t('shell.settings.rotateKeyConfirm.body') }}</v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="rotateDialog = false">{{ $t('shell.common.cancel') }}</v-btn>
            <v-btn color="warning" variant="flat" :loading="rotating" @click="onRotate">
              {{ $t('shell.settings.rotateKeyConfirm.confirm') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
  </ShellFrame>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ShellFrame from '../components/ShellFrame.vue'
import { useShellState } from '../composables/useShellState'
import { rotateDesktopKey, saveSettings, type ShellSettings } from '../shell'
import { LOCALE_OPTIONS, resolveLocale } from '../plugins/i18n'

const { status, settings, load } = useShellState()
const { t, locale } = useI18n()
const { showSuccess, showError } = useSnackbar()

const form = ref<ShellSettings | null>(null)
const originalServerUrl = ref('')
const saving = ref(false)
const rotating = ref(false)
const serverDialog = ref(false)
const rotateDialog = ref(false)

const logLevels = ['error', 'warn', 'info', 'debug']
const localeItems = computed(() => [
  { value: '', label: t('shell.settings.languageSystem') },
  ...LOCALE_OPTIONS,
])

const managed = computed(() => status.value?.assignment.managed === true)
const isRegistered = computed(() => status.value?.registration.state === 'registered')
const startPathDisplay = computed(() =>
  status.value?.assignment.startPath || t('shell.settings.startPathDefault'))

/**
 * Applying the language as it is picked, rather than on save, is deliberate: the picker is the
 * one setting whose effect you can see, and seeing it is how you know you picked the right one.
 */
watch(() => form.value?.locale, v => {
  if (v !== undefined) locale.value = resolveLocale(v)
})

function cancelServerChange() {
  if (form.value) form.value.serverUrl = originalServerUrl.value
  serverDialog.value = false
}

async function onSave() {
  if (!form.value) return
  // ⚠ Confirm BEFORE writing. The dialog explains that the registration goes with it, which is
  // only an honest warning if nothing has been written yet.
  if (form.value.serverUrl !== originalServerUrl.value && isRegistered.value) {
    serverDialog.value = true
    return
  }
  await commit()
}

async function commit() {
  if (!form.value) return
  saving.value = true
  try {
    const saved = await saveSettings({ ...form.value })
    form.value = { ...saved }
    originalServerUrl.value = saved.serverUrl
    serverDialog.value = false
    await load()
    showSuccess(t('shell.common.saved'))
  } catch (e: any) {
    showError(String(e?.message || e))
  } finally {
    saving.value = false
  }
}

async function onRotate() {
  rotating.value = true
  try {
    await rotateDesktopKey()
    await load()
    showSuccess(t('shell.common.saved'))
  } catch (e: any) {
    showError(String(e?.message || e))
  } finally {
    rotating.value = false
    rotateDialog.value = false
  }
}

onMounted(async () => {
  await load()
  if (settings.value) {
    form.value = { ...settings.value }
    originalServerUrl.value = settings.value.serverUrl
  }
})
</script>
