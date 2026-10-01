<template>
  <ShellFrame>
    <v-container class="py-6" style="max-width: 680px">
      <h1 class="text-h5 mb-5">{{ $t('shell.onboarding.title') }}</h1>

      <v-stepper v-model="step" :items="stepLabels" flat class="border rounded-lg" hide-actions>
        <!-- 1. Server -->
        <template #item.1>
          <div class="pa-2">
            <p class="text-body-2 mb-4">{{ $t('shell.onboarding.serverIntro') }}</p>
            <v-text-field
              v-model="serverInput"
              :label="$t('shell.settings.serverUrl')"
              :error-messages="serverError ? [$t('shell.onboarding.serverInvalid')] : []"
              variant="outlined"
              density="comfortable"
              autofocus
              data-field="server-url"
              @blur="applyServer"
            />
            <v-alert
              v-if="serverUpgraded"
              type="info"
              variant="tonal"
              density="compact"
              class="mb-2"
              data-banner="server-upgraded"
            >
              {{ $t('shell.onboarding.serverUpgraded', { url: serverInput }) }}
            </v-alert>
          </div>
        </template>

        <!-- 2. Name -->
        <template #item.2>
          <div class="pa-2">
            <p class="text-body-2 mb-4">{{ $t('shell.onboarding.nameIntro') }}</p>
            <v-text-field
              v-model="nameInput"
              :label="$t('shell.settings.desktopName')"
              variant="outlined"
              density="comfortable"
              autofocus
              data-field="desktop-name"
            />
          </div>
        </template>

        <!-- 3. Registration code -->
        <template #item.3>
          <div class="pa-2">
            <p class="text-body-2 mb-4">{{ $t('shell.onboarding.codeIntro') }}</p>
            <v-alert
              v-if="codeFromLink"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-4"
              data-banner="code-from-link"
            >
              {{ $t('shell.onboarding.codeFromLink') }}
            </v-alert>
            <v-text-field
              v-model="codeInput"
              :label="$t('shell.onboarding.codeLabel')"
              :placeholder="$t('shell.onboarding.codePlaceholder')"
              :error-messages="codeError ? [$t('shell.onboarding.codeInvalid')] : []"
              variant="outlined"
              density="comfortable"
              autofocus
              data-field="code"
            />
            <v-alert
              v-if="registerError"
              type="error"
              variant="tonal"
              density="compact"
              data-banner="register-failed"
            >
              {{ $t('shell.onboarding.registerFailed', { reason: registerError }) }}
            </v-alert>
          </div>
        </template>

        <!-- 4. Options -->
        <template #item.4>
          <div class="pa-2">
            <p class="text-body-2 mb-2">{{ $t('shell.onboarding.optionsIntro') }}</p>
            <v-switch
              v-model="autostart"
              :label="$t('shell.settings.autostart')"
              color="primary"
              density="comfortable"
              hide-details
              data-field="autostart"
            />
            <v-switch
              v-model="openOnLaunch"
              :label="$t('shell.settings.openLgrOnLaunch')"
              color="primary"
              density="comfortable"
              hide-details
              data-field="open-on-launch"
            />
          </div>
        </template>
      </v-stepper>

      <div class="d-flex justify-space-between align-center mt-4">
        <v-btn variant="text" :disabled="step === 1" @click="step--">{{ $t('shell.common.back') }}</v-btn>
        <div class="d-flex ga-2">
          <v-btn v-if="step === 3" variant="text" @click="step = 4">{{ $t('shell.onboarding.skip') }}</v-btn>
          <v-btn
            v-if="step < 4"
            color="primary"
            variant="flat"
            :loading="registering"
            data-action="next"
            @click="onNext"
          >
            {{ step === 3 ? $t('shell.onboarding.register') : $t('shell.common.next') }}
          </v-btn>
          <v-btn v-else color="primary" variant="flat" :loading="saving" data-action="finish" @click="onFinish">
            {{ $t('shell.common.finish') }}
          </v-btn>
        </div>
      </div>
    </v-container>
  </ShellFrame>
</template>

<script setup lang="ts">
/**
 * FR-14.11's four screens. The registration EXCHANGE lands in C11; this screen collects the
 * code, validates its shape and calls the command, which refuses with `not_implemented` until
 * then — a refusal the screen shows rather than swallowing.
 *
 * It ends on the Overview with Open LGR highlighted (C09).
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ShellFrame from '../components/ShellFrame.vue'
import { useShellState } from '../composables/useShellState'
import { enrollDesktop, saveSettings } from '../shell'
import { normaliseServerUrl } from '../server-url'

const { settings, load, takeDeepLink } = useShellState()
const router = useRouter()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const step = ref(1)
const serverInput = ref('')
const nameInput = ref('')
const codeInput = ref('')
const autostart = ref(false)
const openOnLaunch = ref(false)

const serverError = ref(false)
const serverUpgraded = ref(false)
const codeError = ref(false)
const codeFromLink = ref(false)
const registerError = ref('')
const registering = ref(false)
const saving = ref(false)

const stepLabels = computed(() => [
  t('shell.onboarding.stepServer'),
  t('shell.onboarding.stepName'),
  t('shell.onboarding.stepCode'),
  t('shell.onboarding.stepOptions'),
])

/** A code is `XXXX-XXXX`; the dash is optional on input because people type it both ways. */
const normalisedCode = computed(() =>
  codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
const codeLooksRight = computed(() => /^[A-Z0-9]{8}$/.test(normalisedCode.value))

function applyServer() {
  const { url, upgraded } = normaliseServerUrl(serverInput.value)
  serverError.value = serverInput.value.trim().length > 0 && url === null
  serverUpgraded.value = upgraded
  if (url) serverInput.value = url
}

async function onNext() {
  if (step.value === 1) {
    applyServer()
    if (serverError.value || !serverInput.value) return
    step.value = 2
    return
  }
  if (step.value === 2) {
    step.value = 3
    return
  }
  // Step 3 — register.
  codeError.value = !codeLooksRight.value
  if (codeError.value) return
  registering.value = true
  registerError.value = ''
  try {
    await enrollDesktop({
      serverUrl: serverInput.value,
      name: nameInput.value.trim(),
      code: `${normalisedCode.value.slice(0, 4)}-${normalisedCode.value.slice(4)}`,
    })
    await load()
    step.value = 4
  } catch (e: any) {
    registerError.value = String(e?.message || e)
  } finally {
    registering.value = false
  }
}

async function onFinish() {
  saving.value = true
  try {
    if (settings.value) {
      await saveSettings({
        ...settings.value,
        serverUrl: serverInput.value || settings.value.serverUrl,
        desktopName: nameInput.value.trim() || settings.value.desktopName,
        autostart: autostart.value,
        openLgrOnLaunch: openOnLaunch.value,
      })
    }
    await load()
    showSuccess(t('shell.onboarding.done'))
    await router.push({ name: 'overview' })
  } catch (e: any) {
    showError(String(e?.message || e))
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await load()
  if (settings.value) {
    serverInput.value = settings.value.serverUrl
    nameInput.value = settings.value.desktopName
    autostart.value = settings.value.autostart
    openOnLaunch.value = settings.value.openLgrOnLaunch
  }

  /**
   * ⚠ A deep link PRE-FILLS and asks for confirmation (FR-14.12) — it never registers by
   * itself. `lgr://enroll?server=&code=` is a link anyone can send; acting on it unattended
   * would let a stranger point a till at their own server.
   */
  const link = takeDeepLink()
  if (!link) return
  try {
    const u = new URL(link)
    if (u.host !== 'enroll' && u.pathname.replace(/\//g, '') !== 'enroll') return
    const server = u.searchParams.get('server')
    const code = u.searchParams.get('code')
    if (server) {
      const { url } = normaliseServerUrl(server)
      if (url) serverInput.value = url
    }
    if (code) {
      codeInput.value = code
      codeFromLink.value = true
      step.value = 3
    }
  } catch {
    /* a malformed link pre-fills nothing; the screen still works by hand */
  }
})
</script>
