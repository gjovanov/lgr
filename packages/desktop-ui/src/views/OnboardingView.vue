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
            <p class="text-caption text-medium-emphasis">{{ $t('shell.onboarding.serverHintLan') }}</p>

            <!-- FR-20.28 — LGR Servers that answered on this network. Choosing one fills the address;
                 it is then probed and confirmed exactly as a typed one. -->
            <div class="mt-4" data-panel="on-this-network">
              <div class="d-flex align-center justify-space-between">
                <span class="text-subtitle-2">{{ $t('shell.onboarding.onNetwork') }}</span>
                <v-btn size="small" variant="text" :loading="discovering" data-action="discover" @click="discover">
                  {{ $t('shell.onboarding.lookForServers') }}
                </v-btn>
              </div>
              <v-list v-if="found.length" density="compact" class="border rounded" data-field="found-servers">
                <v-list-item
                  v-for="f in found"
                  :key="f.url"
                  :title="f.name"
                  :subtitle="f.url"
                  prepend-icon="mdi-server-network"
                  :active="serverInput === f.url"
                  @click="choose(f)"
                />
              </v-list>
              <p v-else-if="discovered && !discovering" class="text-caption text-medium-emphasis" data-banner="none-found">
                {{ $t('shell.onboarding.noServersFound') }}
              </p>
            </div>
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
              v-if="enrollmentKey"
              type="info"
              variant="tonal"
              density="compact"
              class="mb-4"
              data-banner="code-is-key"
            >
              {{ $t('shell.onboarding.codeIsKey') }}
            </v-alert>
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

      <!--
        FR-20.29 — whether this server is trusted. Shown on the server step and on the code step (a
        registration link jumps straight to the code), never later: by then it has been decided.
      -->
      <div v-if="step === 1 || step === 3" class="mt-4" data-panel="server-trust">
        <v-alert v-if="probing" type="info" variant="tonal" density="compact" data-banner="checking-server">
          {{ $t('shell.onboarding.checkingServer') }}
        </v-alert>
        <v-alert v-else-if="probeError" type="error" variant="tonal" density="compact" data-banner="server-unreachable">
          {{ $t('shell.onboarding.probeFailed', { reason: probeError }) }}
        </v-alert>
        <template v-else-if="probe">
          <v-alert v-if="linkMismatch" type="error" variant="tonal" density="compact" data-banner="fingerprint-mismatch">
            {{ $t('shell.onboarding.fingerprintMismatch') }}
          </v-alert>
          <v-alert v-else-if="linkWantsMaster && !masterProbe" type="error" variant="tonal" density="compact" data-banner="not-a-master">
            {{ $t('shell.onboarding.notAMaster') }}
          </v-alert>
          <v-alert v-else-if="advertMismatch" type="error" variant="tonal" density="compact" data-banner="advert-mismatch">
            {{ $t('shell.onboarding.advertMismatch') }}
          </v-alert>
          <v-alert v-else-if="masterProbe && linkMatches" type="success" variant="tonal" density="compact" data-banner="fingerprint-verified">
            <div>{{ $t('shell.onboarding.fingerprintVerified') }}</div>
            <div class="text-body-1 font-weight-medium mt-1" data-field="fingerprint-words">{{ masterProbe.words.join(' ') }}</div>
          </v-alert>
          <v-alert v-else-if="masterProbe" type="info" variant="tonal" density="compact" data-banner="compare-words">
            <div>{{ $t('shell.onboarding.compareWords') }}</div>
            <div class="text-body-1 font-weight-medium my-1" data-field="fingerprint-words">{{ masterProbe.words.join(' ') }}</div>
            <v-checkbox
              v-model="wordsConfirmed"
              :label="$t('shell.onboarding.wordsMatch')"
              density="compact"
              hide-details
              data-field="words-confirmed"
            />
          </v-alert>
        </template>
      </div>

      <div class="d-flex justify-space-between align-center mt-4">
        <v-btn variant="text" :disabled="step === 1" @click="step--">{{ $t('shell.common.back') }}</v-btn>
        <div class="d-flex ga-2">
          <v-btn v-if="step === 3" variant="text" @click="step = 4">{{ $t('shell.onboarding.skip') }}</v-btn>
          <v-btn
            v-if="step < 4"
            color="primary"
            variant="flat"
            :loading="registering || probing"
            :disabled="blockedByTrust"
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
 *
 * FR-20.29 — **pairing with a master.** Before a code is exchanged, the shell asks what the server is
 * (`probeServer`). An LGR Server on this network is trusted only once its CA's fingerprint is
 * confirmed: against the registration link's `fp`, or by a person who compares its six words with
 * the ones the server's Desktops page shows. lgrai.app is never asked anything: the OS trust store
 * vouches for it, as before.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ShellFrame from '../components/ShellFrame.vue'
import { useShellState } from '../composables/useShellState'
import { discoverServers, enrollDesktop, isFingerprint, probeServer, saveSettings, type FoundServer, type ServerKind } from '../shell'
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

// ── FR-20.29: what the server is, and whether it is trusted ──
const probe = ref<ServerKind | null>(null)
/** The address `probe` answers for. Editing the address forgets the answer. */
const probedUrl = ref('')
const probing = ref(false)
const probeError = ref('')
const wordsConfirmed = ref(false)
/** The fingerprint a registration link carried, and the server it carried it for. */
const linkFingerprint = ref<string | null>(null)
const linkServer = ref('')

const masterProbe = computed(() => (probe.value?.kind === 'master' ? probe.value : null))
/** The link's fingerprint, while the address is still the one the link named. */
const linkFp = computed(() => (serverInput.value === linkServer.value ? linkFingerprint.value : null))
const linkWantsMaster = computed(() => !!linkFp.value)
const linkMatches = computed(() => !!masterProbe.value && !!linkFp.value && masterProbe.value.fingerprint === linkFp.value)
const linkMismatch = computed(() => !!masterProbe.value && !!linkFp.value && masterProbe.value.fingerprint !== linkFp.value)

// ── FR-20.28: servers that answered on this network ──
const found = ref<FoundServer[]>([])
const discovering = ref(false)
const discovered = ref(false)
/** The server chosen from the list, and the fingerprint its advert claimed. */
const advertised = ref<FoundServer | null>(null)
/**
 * ⚠ An advert is anyone's to send, so a match proves nothing and the words are still asked for. A
 * mismatch, though, is a server that is not what it said, and it is refused.
 */
const advertMismatch = computed(() =>
  !!masterProbe.value && advertised.value?.url === serverInput.value && advertised.value.fingerprint !== masterProbe.value.fingerprint)

/**
 * A master is trusted once the link's fingerprint matched it, or (with no link) once a person said
 * the six words match. ⚠ A link's mismatch is never overridden by a tick: the link is the thing the
 * administrator gave out, and a different certificate is exactly what a man in the middle shows. Nor
 * is a server that is not the one it advertised.
 */
const masterTrusted = computed(() => {
  if (!masterProbe.value) return !linkWantsMaster.value
  if (linkFp.value) return linkMatches.value
  return !advertMismatch.value && wordsConfirmed.value
})

async function discover() {
  discovering.value = true
  try {
    const list = await discoverServers()
    found.value = Array.isArray(list) ? list : []
  } catch {
    found.value = []
  } finally {
    discovering.value = false
    discovered.value = true
  }
}

async function choose(f: FoundServer) {
  advertised.value = f
  serverInput.value = f.url
  serverError.value = false
  serverUpgraded.value = false
  await checkServer()
}
/** Next and Register wait on a server that has been asked and is not yet trusted. */
const blockedByTrust = computed(() =>
  (step.value === 1 || step.value === 3) && !!probe.value && probedUrl.value === serverInput.value && !masterTrusted.value)

watch(serverInput, url => {
  if (url !== probedUrl.value) {
    probe.value = null
    probedUrl.value = ''
    probeError.value = ''
    wordsConfirmed.value = false
  }
})

/** Ask the server what it is, once per address. `false` when it did not answer. */
async function checkServer(): Promise<boolean> {
  if (probe.value && probedUrl.value === serverInput.value) return true
  probing.value = true
  probeError.value = ''
  wordsConfirmed.value = false
  try {
    probe.value = await probeServer(serverInput.value)
    probedUrl.value = serverInput.value
    return true
  } catch (e: any) {
    probe.value = null
    probedUrl.value = ''
    probeError.value = String(e?.message || e)
    return false
  } finally {
    probing.value = false
  }
}

const stepLabels = computed(() => [
  t('shell.onboarding.stepServer'),
  t('shell.onboarding.stepName'),
  t('shell.onboarding.stepCode'),
  t('shell.onboarding.stepOptions'),
])

/** A code is `XXXX-XXXX`; the dash is optional on input because people type it both ways. */
const normalisedCode = computed(() =>
  codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
/**
 * #328 — or an enrollment KEY (FR-14.19): 43 base64url characters, which make an ephemeral desktop.
 * ⚠ Sent exactly as pasted: case, `-` and `_` are part of it, and the code's normalising would turn
 * it into something the server never issued.
 */
const enrollmentKey = computed(() => {
  const key = codeInput.value.trim()
  return /^[A-Za-z0-9_-]{43}$/.test(key) ? key : ''
})
const codeLooksRight = computed(() => !!enrollmentKey.value || /^[A-Z0-9]{8}$/.test(normalisedCode.value))

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
    // A master shows its words here and waits for them to be confirmed (the panel below).
    if (!(await checkServer()) || !masterTrusted.value) return
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
  // A registration link lands here directly, so the server may not have been asked yet.
  if (!(await checkServer()) || !masterTrusted.value) return
  registering.value = true
  registerError.value = ''
  try {
    await enrollDesktop({
      serverUrl: serverInput.value,
      name: nameInput.value.trim(),
      code: enrollmentKey.value || `${normalisedCode.value.slice(0, 4)}-${normalisedCode.value.slice(4)}`,
      // Only the fingerprint: Rust fetches the CA itself and checks it against this.
      ...(masterProbe.value ? { fingerprint: masterProbe.value.fingerprint } : {}),
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
  // With no link to follow, look for a server on this network straight away (FR-20.28).
  if (!link) {
    void discover()
    return
  }
  try {
    const u = new URL(link)
    if (u.host !== 'enroll' && u.pathname.replace(/\//g, '') !== 'enroll') return
    const server = u.searchParams.get('server')
    // #328: an enrollment key rides in `key` (Rust accepted the link only with a plausible one).
    const code = u.searchParams.get('key') ?? u.searchParams.get('code')
    const fp = u.searchParams.get('fp')
    if (server) {
      const { url } = normaliseServerUrl(server)
      if (url) {
        serverInput.value = url
        linkServer.value = url
        // FR-20.29 — a master's link pins its CA. Rust refused the link outright if this was
        // malformed or named a server a pin may not apply to, so a bad one never gets this far.
        if (isFingerprint(fp)) linkFingerprint.value = fp.trim()
      }
    }
    if (code) {
      codeInput.value = code
      codeFromLink.value = true
      step.value = 3
    }
  } catch {
    /* a malformed link pre-fills nothing; the screen still works by hand */
  }
  // Ask now, so the code step already says whether the server matches its link.
  if (linkServer.value) await checkServer()
})
</script>
