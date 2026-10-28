<template>
  <ShellFrame>
    <v-container class="py-6" style="max-width: 920px">
      <h1 class="text-h5 mb-1">{{ $t('shell.overview.title') }}</h1>
      <p class="text-body-2 text-medium-emphasis mb-5">{{ $t('shell.app.subtitle') }}</p>

      <v-alert
        v-if="!inShell"
        type="info"
        variant="tonal"
        density="comfortable"
        class="mb-5"
        data-banner="not-in-shell"
      >
        <v-alert-title class="text-body-1">{{ $t('shell.notInShell.title') }}</v-alert-title>
        <div class="text-body-2 mt-1">{{ $t('shell.notInShell.body') }}</div>
      </v-alert>

      <ShellBanners />

      <!-- This desktop -->
      <v-card variant="flat" border class="mb-4" data-card="this-desktop">
        <v-card-item>
          <v-card-title class="text-subtitle-1">{{ $t('shell.overview.thisDesktop') }}</v-card-title>
        </v-card-item>
        <v-card-text>
          <v-row dense>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('shell.registration.label') }}</div>
              <v-chip :color="registrationColor" size="small" label data-field="registration">
                {{ $t(`shell.registration.${registrationKey}`) }}
              </v-chip>
            </v-col>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('shell.overview.serverLink') }}</div>
              <v-chip :color="linkColor" size="small" label data-field="server-link">
                {{ $t(`shell.link.${linkKey}`) }}
              </v-chip>
            </v-col>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('shell.overview.name') }}</div>
              <div class="text-body-2" data-field="desktop-name">{{ status?.desktopName || dash }}</div>
            </v-col>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('shell.overview.organisation') }}</div>
              <div class="text-body-2" data-field="org">{{ status?.registration.orgSlug || dash }}</div>
            </v-col>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('shell.overview.server') }}</div>
              <div class="text-body-2 text-truncate" data-field="server">{{ status?.serverUrl || dash }}</div>
            </v-col>
            <v-col cols="12" sm="6">
              <div class="text-caption text-medium-emphasis">{{ $t('shell.overview.appVersion') }}</div>
              <div class="text-body-2" data-field="version">{{ status?.appVersion || dash }}</div>
            </v-col>
            <!-- FR-20.29 — a master is trusted by the CA it was paired with: the same six words its
                 Desktops page shows, so a person can check which server this till trusts. -->
            <v-col v-if="status?.serverPin" cols="12">
              <div class="text-caption text-medium-emphasis">{{ $t('shell.overview.serverPin') }}</div>
              <div class="text-body-2 font-weight-medium" data-field="server-pin">
                {{ status.serverPin.words.join(' ') }}
              </div>
            </v-col>
          </v-row>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-0">
          <!--
            The primary action on the page (FR-14.30). C10 gives it a window; here the command
            exists and logs, so the button is never a lie about what happened.
          -->
          <v-btn
            color="primary"
            variant="flat"
            size="large"
            prepend-icon="mdi-open-in-app"
            :loading="opening"
            data-action="open-lgr"
            @click="onOpenLgr"
          >
            {{ $t('shell.overview.openLgr') }}
          </v-btn>
          <span class="text-caption text-medium-emphasis ml-3">
            {{ settings?.openInSystemBrowser ? $t('shell.overview.openLgrBrowserHint') : $t('shell.overview.openLgrHint') }}
          </span>
        </v-card-actions>
      </v-card>

      <!-- Fiscal devices — only when some are assigned (FR-14.30) -->
      <v-card v-if="devices.length" variant="flat" border class="mb-4" data-card="fiscal-devices">
        <v-card-item>
          <v-card-title class="text-subtitle-1">{{ $t('shell.overview.fiscalDevices') }}</v-card-title>
        </v-card-item>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ $t('shell.overview.name') }}</th>
              <th>{{ $t('shell.overview.devicePort') }}</th>
              <th>{{ $t('shell.overview.deviceState') }}</th>
              <th>{{ $t('shell.overview.deviceLastCommand') }}</th>
            </tr>
          </thead>
          <tbody>
            <!--
              ⚠ A row per device the BRIDGE reports (C18), falling back to the bare assignment
              when it reports nothing — an unregistered shell, or one that could not read the
              assignment from the hub. A dash is honest; an invented "Ready" is not.
            -->
            <tr v-for="d in deviceRows" :key="d.id">
              <td class="text-body-2">
                {{ d.name || d.id }}
                <span v-if="d.deviceNumber" class="text-medium-emphasis">({{ d.deviceNumber }})</span>
              </td>
              <td :class="d.port ? 'text-body-2' : 'text-medium-emphasis'">{{ d.port || dash }}</td>
              <td>
                <v-chip v-if="d.state" size="x-small" label :color="deviceStateColor(d.state)">
                  {{ deviceStateLabel(d.state) }}
                </v-chip>
                <span v-else class="text-medium-emphasis">{{ dash }}</span>
                <!--
                  ⚠ The reason is shown next to the state, not behind a tooltip: "in_use" without
                  "cannot open COM4: Access denied" sends an operator hunting the wrong fault.
                -->
                <div v-if="d.lastError" class="text-caption text-medium-emphasis">{{ d.lastError }}</div>
              </td>
              <td class="text-medium-emphasis">{{ lastCommandLabel(d.lastCommandSecsAgo) }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

      <!-- Updates -->
      <v-card variant="flat" border data-card="updates">
        <v-card-item>
          <v-card-title class="text-subtitle-1">{{ $t('shell.overview.updates') }}</v-card-title>
          <v-card-subtitle>
            {{ $t('shell.overview.currentVersion') }}: {{ status?.appVersion || dash }}
          </v-card-subtitle>
        </v-card-item>
        <v-card-text class="pt-0">
          <p v-if="check?.available" class="text-body-2 mb-0" data-field="update-available">
            {{ $t('shell.overview.updateAvailable', { version: check.available }) }}
          </p>
          <!--
            ⚠ A per-machine install never self-installs and never elevates (FR-14.28 §5). Saying
            who will do it beats offering a button that produces a UAC prompt nobody on a till
            will answer.
          -->
          <p v-else-if="check?.managed" class="text-body-2 text-medium-emphasis mb-0" data-field="update-managed">
            {{ $t('shell.overview.updatesManaged') }}
          </p>
          <p v-else-if="check" class="text-body-2 text-medium-emphasis mb-0" data-field="update-none">
            {{ $t('shell.overview.upToDate') }}
          </p>
          <p v-else class="text-body-2 text-medium-emphasis mb-0">{{ $t('shell.overview.updatesHint') }}</p>
          <p v-if="updateError" class="text-body-2 text-error mt-2 mb-0">{{ updateError }}</p>
          <p v-if="settings" class="text-caption text-medium-emphasis mt-2 mb-0" data-field="auto-update-state">
            {{ settings.autoUpdate ? $t('shell.overview.autoUpdateOn') : $t('shell.overview.autoUpdateOff') }}
          </p>
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-0 ga-2">
          <v-btn variant="outlined" size="small" :loading="checking" data-action="check-updates" @click="onCheck">
            {{ $t('shell.overview.checkForUpdates') }}
          </v-btn>
          <v-btn
            variant="outlined"
            size="small"
            :disabled="!check?.available || check?.managed"
            :loading="installing"
            data-action="install-update"
            @click="onInstall"
          >
            {{ $t('shell.overview.installUpdate') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-container>
  </ShellFrame>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ShellFrame from '../components/ShellFrame.vue'
import ShellBanners from '../components/ShellBanners.vue'
import { useShellState } from '../composables/useShellState'
import { openLgr, checkForUpdates, installUpdate, type UpdateCheck } from '../shell'

const { status, settings, inShell, load } = useShellState()
const { t, te } = useI18n()
const { showError, showSuccess } = useSnackbar()
const opening = ref(false)
const checking = ref(false)
const installing = ref(false)
const check = ref<UpdateCheck | null>(null)
const updateError = ref('')
const dash = '—'

const devices = computed(() => status.value?.bridge.devices ?? [])

/**
 * What the Fiscal devices table renders (FR-14.27).
 *
 * ⚠ The bridge's own report wins when it has one; the bare assignment is the fallback, so a shell
 * that is registered but could not reach the hub still SHOWS its devices instead of hiding the card
 * — "the assignment exists but nothing opened it" is the state an admin most needs to see.
 */
const deviceRows = computed(() => {
  const fiscal = status.value?.bridge.fiscal ?? []
  if (fiscal.length) return fiscal
  return devices.value.map(id => ({
    id,
    deviceNumber: '',
    name: '',
    port: null as string | null,
    state: '',
    lastCommandSecsAgo: null as number | null,
    lastError: null as string | null,
  }))
})

/**
 * ⚠ `te()` before `t()`: a newer shell may report a state this build predates, and showing the raw
 * word is better than showing a missing-key path — vue-i18n has no fallback for an absent key.
 */
function deviceStateLabel(state: string): string {
  const key = `shell.overview.deviceStates.${state}`
  return te(key) ? t(key) : state
}

/** idle/printing are working; no_port/unassigned need an admin; the rest are faults. */
function deviceStateColor(state: string): string {
  if (state === 'idle' || state === 'printing') return 'success'
  if (state === 'opening') return 'info'
  if (state === 'no_port' || state === 'unassigned') return 'warning'
  return 'error'
}

/** "just now" under a minute, then whole minutes — a till does not need seconds. */
function lastCommandLabel(secs: number | null): string {
  if (secs === null || secs === undefined) return dash
  if (secs < 60) return t('shell.overview.deviceLastCommandJustNow')
  return t('shell.overview.deviceLastCommandMinutes', { minutes: Math.floor(secs / 60) })
}

/** camelCase for the i18n key; the Rust side speaks snake_case. */
const registrationKey = computed(() => {
  switch (status.value?.registration.state) {
    case 'registered': return 'registered'
    case 'revoked': return 'revoked'
    default: return 'notRegistered'
  }
})
const registrationColor = computed(() => (
  { registered: 'success', revoked: 'error', notRegistered: 'warning' }[registrationKey.value]
))

const linkKey = computed(() => {
  switch (status.value?.serverLink) {
    case 'connected': return 'connected'
    case 'unreachable': return 'unreachable'
    case 'signed_out': return 'signedOut'
    default: return 'unknown'
  }
})
const linkColor = computed(() => (
  { connected: 'success', unreachable: 'error', signedOut: 'warning', unknown: 'default' }[linkKey.value]
))

async function onOpenLgr() {
  opening.value = true
  try {
    await openLgr()
  } catch (e: any) {
    showError(String(e?.message || e) || t('shell.common.unknown'))
  } finally {
    opening.value = false
  }
}

async function onCheck() {
  checking.value = true
  updateError.value = ''
  try {
    check.value = await checkForUpdates()
  } catch (e: any) {
    // ⚠ A failed update CHECK is not a failed app. A till that cannot reach the hub is still a
    // working till; it just has nothing new to install, and the message says which.
    check.value = null
    updateError.value = String(e?.message || e)
  } finally {
    checking.value = false
  }
}

async function onInstall() {
  const version = check.value?.available
  if (!version) return
  installing.value = true
  updateError.value = ''
  try {
    const outcome = await installUpdate(version)
    // "deferred" is a success, not a failure: the till was busy and the update waits.
    showSuccess(outcome === 'deferred' ? t('shell.overview.updateDeferred') : t('shell.overview.updateStarted'))
  } catch (e: any) {
    updateError.value = String(e?.message || e)
  } finally {
    installing.value = false
  }
}

onMounted(load)
</script>
