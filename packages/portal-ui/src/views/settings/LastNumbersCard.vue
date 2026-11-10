<template>
  <div>
    <!-- FR-20.51, FR-20.81: legal numbering waits for the site's last numbers (a promotion, a restore, a clone). -->
    <v-card v-if="lastNumbers?.frozen" variant="outlined" color="warning" class="mb-3" data-test="last-numbers">
      <v-card-title class="text-subtitle-1 text-wrap">{{ $t('servers.lastNumbers.title') }}</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-1">{{ $t(onServer ? 'servers.lastNumbers.introServer' : 'servers.lastNumbers.intro') }}</p>
        <p v-if="lastNumbers.reason" class="text-body-2 font-weight-medium" :class="lastNumbers.detail ? 'mb-1' : 'mb-3'" data-test="last-numbers-reason">
          {{ te(`servers.lastNumbers.reason.${lastNumbers.reason}`) ? $t(`servers.lastNumbers.reason.${lastNumbers.reason}`) : lastNumbers.reason }}
        </p>
        <p v-if="lastNumbers.detail" class="text-caption text-medium-emphasis mb-3" data-test="last-numbers-detail">{{ lastNumbers.detail }}</p>
        <v-row v-for="s in lastNumbers.series" :key="s.prefix + s.year" dense align="center">
          <v-col cols="12" sm="6" class="text-body-2">
            {{ seriesLabel(s) }}
            <div class="text-caption text-medium-emphasis">{{ $t(onServer ? 'servers.lastNumbers.hereServer' : 'servers.lastNumbers.here', { n: s.last }) }}</div>
            <div v-if="mirrorOf(s) !== null" class="text-caption text-medium-emphasis" data-test="last-numbers-mirror">{{ $t('servers.lastNumbers.mirror', { n: mirrorOf(s) }) }}</div>
            <!-- #549: what this server's own mark says it issued; numbering resumes above it too. -->
            <div v-if="markOf(s) !== null" class="text-caption text-medium-emphasis" data-test="last-numbers-mark">{{ $t('servers.lastNumbers.mark', { n: markOf(s) }) }}</div>
          </v-col>
          <v-col cols="12" sm="6">
            <v-text-field v-model.number="siteNumbers[s.prefix + '|' + s.year]" type="number" :min="0" density="compact" hide-details :data-test="'last-' + s.prefix" />
          </v-col>
        </v-row>
        <!-- AC 49: what each fiscal device says, beside the last receipt this database recorded on it. -->
        <template v-if="lastNumbers.devices?.length">
          <div class="text-subtitle-2 mt-4 mb-1">{{ $t('servers.lastNumbers.devices.title') }}</div>
          <p class="text-caption text-medium-emphasis mb-2">{{ $t('servers.lastNumbers.devices.intro') }}</p>
          <div v-for="d in lastNumbers.devices" :key="d.id" class="text-body-2 mb-2" data-test="last-numbers-device">
            <span class="font-weight-medium">{{ d.name || d.deviceNumber }}</span> <span class="text-medium-emphasis">({{ d.deviceNumber }})</span>
            <div class="text-caption" data-test="last-numbers-device-reading">{{ deviceReading(d) }}</div>
            <div class="text-caption">{{ d.recorded ? $t('servers.lastNumbers.devices.recorded', { receipt: d.recorded.receiptNo, number: d.recorded.number || '—', unp: d.recorded.unp || '—', at: fmtDate(d.recorded.printedAt) }) : $t('servers.lastNumbers.devices.none') }}</div>
            <div v-if="d.since !== null" class="text-caption" :class="d.since > 0 ? 'text-warning font-weight-medium' : d.since < 0 ? 'text-error' : ''" data-test="last-numbers-device-since">
              {{ d.since > 0 ? $t('servers.lastNumbers.devices.ahead', { n: d.since }) : d.since < 0 ? $t('servers.lastNumbers.devices.behind') : $t('servers.lastNumbers.devices.same') }}
            </div>
          </div>
        </template>
        <v-checkbox v-model="lastNumbersConfirmed" :label="$t('servers.lastNumbers.confirm')" density="compact" hide-details class="mt-2" data-test="last-numbers-confirm" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn v-cap="'numbering.manage'" color="primary" :disabled="!lastNumbersConfirmed" :loading="lastNumbersBusy" data-test="last-numbers-save" @click="saveLastNumbers">{{ $t('servers.lastNumbers.save') }}</v-btn>
      </v-card-actions>
    </v-card>

    <!-- #549, on the org's server: a person locks numbering by hand, after a revert nothing there can see. -->
    <v-card v-else-if="onServer && lastNumbers" variant="outlined" class="mb-3" data-test="numbering-lock-card">
      <v-card-title class="text-subtitle-1 text-wrap">{{ $t('servers.lastNumbers.lock.title') }}</v-card-title>
      <v-card-text>
        <p class="text-body-2">{{ $t('servers.lastNumbers.lock.intro') }}</p>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn v-cap="'numbering.manage'" color="warning" variant="tonal" prepend-icon="mdi-lock" data-test="numbering-lock" @click="openLock">{{ $t('servers.lastNumbers.lock.action') }}</v-btn>
      </v-card-actions>
    </v-card>

    <v-dialog v-model="lockDialog" max-width="560">
      <v-card data-test="numbering-lock-dialog">
        <v-card-title class="text-wrap">{{ $t('servers.lastNumbers.lock.dialogTitle') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ $t('servers.lastNumbers.lock.dialogIntro') }}</p>
          <v-textarea v-model="lockNote" :label="$t('servers.lastNumbers.lock.note')" rows="2" maxlength="300" counter auto-grow data-test="numbering-lock-note" />
          <v-checkbox v-model="lockConfirmed" :label="$t('servers.lastNumbers.lock.confirm')" density="compact" hide-details data-test="numbering-lock-confirm" />
          <v-alert v-if="lockError" type="error" variant="tonal" density="compact" class="mt-2">{{ lockError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="lockDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn v-cap="'numbering.manage'" color="warning" variant="flat" :disabled="!lockConfirmed" :loading="lockBusy" data-test="numbering-lock-save" @click="lock">{{ $t('servers.lastNumbers.lock.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { announceHomeChanged } from 'ui-shared/composables/useHomeChanged'
import { useAppStore } from '../../store/app.store'

/**
 * Whether the org's legal numbering waits for the last numbers issued at the site, and recording
 * them (FR-20.51, FR-20.81): on lgrai.app after a promotion (the Servers page), and on the org's own
 * server after a restore, a revert or a clone (its status page). `onServer` is that page: the series
 * are this server's database's, and while numbering is open a person locks it by hand (#549), the
 * runbook's step after a revert nothing there can see.
 */

const props = defineProps<{ onServer?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const { t, te } = useI18n()
const { showSnackbar } = useSnackbar()
const appStore = useAppStore()

interface SeriesRow { prefix: string; year: number; last: number }
/** AC 49: one fiscal device's word, beside the last receipt this database recorded on it. */
interface DeviceWitness {
  id: string
  name: string
  deviceNumber: string
  reading: { state: 'read' | 'not_connected' | 'unsupported' | 'error'; lastDocument?: number; readAt?: string; error?: string }
  recorded: { receiptNo: string; unp: string | null; number: string; printedAt: string | null } | null
  since: number | null
}
const lastNumbers = ref<{
  frozen: boolean
  reason: string | null
  detail?: string | null
  series: SeriesRow[]
  mirror: SeriesRow[] | null
  mark?: SeriesRow[] | null
  devices?: DeviceWitness[]
} | null>(null)

const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—')
const deviceReading = (d: DeviceWitness) => d.reading.state === 'read'
  ? t('servers.lastNumbers.devices.read', { n: d.reading.lastDocument, at: fmtDate(d.reading.readAt) })
  : d.reading.state === 'error'
    ? t('servers.lastNumbers.devices.error', { error: d.reading.error ?? '' })
    : t(`servers.lastNumbers.devices.${d.reading.state}`)
const same = (a: SeriesRow, b: SeriesRow) => a.prefix === b.prefix && a.year === b.year
/** On a master, what lgrai.app's mirror holds of a series: numbering resumes above it too. */
const mirrorOf = (s: SeriesRow) => lastNumbers.value?.mirror?.find(m => same(m, s))?.last ?? null
/** On a master, what its own mark says it issued (#549): numbering resumes above it too. */
const markOf = (s: SeriesRow) => lastNumbers.value?.mark?.find(m => same(m, s))?.last ?? null
const siteNumbers = ref<Record<string, number>>({})
const lastNumbersConfirmed = ref(false)
const lastNumbersBusy = ref(false)
const seriesLabel = (s: SeriesRow) => s.prefix.startsWith('UNP-')
  ? t('servers.lastNumbers.series.UNP', { device: s.prefix.slice(4) })
  : t(`servers.lastNumbers.series.${s.prefix}`, { year: s.year })

async function reload() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/numbering/last-numbers`)
    lastNumbers.value = data
    // Offered at the highest this server knows of: a person reads the site's off its last documents and corrects them.
    siteNumbers.value = Object.fromEntries((data.series ?? []).map((s: SeriesRow) => {
      const mirror = (data.mirror ?? []).find((m: SeriesRow) => same(m, s))?.last ?? 0
      const mark = (data.mark ?? []).find((m: SeriesRow) => same(m, s))?.last ?? 0
      return [`${s.prefix}|${s.year}`, Math.max(s.last, mirror, mark)]
    }))
  } catch {
    lastNumbers.value = null
  }
}

async function saveLastNumbers() {
  if (!lastNumbers.value) return
  lastNumbersBusy.value = true
  try {
    const series = lastNumbers.value.series.map(s => ({ prefix: s.prefix, year: s.year, last: Math.max(0, Math.floor(Number(siteNumbers.value[`${s.prefix}|${s.year}`] ?? s.last))) }))
    await httpClient.post(`${appStore.orgUrl()}/numbering/last-numbers`, { series })
    showSnackbar(t('servers.lastNumbers.saved'), 'success')
    announceHomeChanged()
    lastNumbersConfirmed.value = false
    await reload()
    emit('changed')
  } catch (e: any) {
    showSnackbar(e?.response?.data?.message ?? t('common.operationFailed'), 'error')
  } finally {
    lastNumbersBusy.value = false
  }
}

// ── #549: lock by hand, on the org's server ─────────────────────────────────────────────────────
const lockDialog = ref(false)
const lockNote = ref('')
const lockConfirmed = ref(false)
const lockBusy = ref(false)
const lockError = ref('')

function openLock() {
  lockNote.value = ''
  lockConfirmed.value = false
  lockError.value = ''
  lockDialog.value = true
}

async function lock() {
  if (!props.onServer) return
  lockBusy.value = true
  lockError.value = ''
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/numbering/lock`, { note: lockNote.value.trim() })
    lockDialog.value = false
    showSnackbar(t(data?.already ? 'servers.lastNumbers.lock.already' : 'servers.lastNumbers.lock.done'), data?.already ? 'info' : 'success')
    announceHomeChanged()
    await reload()
    emit('changed')
  } catch (e: any) {
    lockError.value = e?.response?.data?.message ?? t('common.operationFailed')
  } finally {
    lockBusy.value = false
  }
}

defineExpose({ reload })
onMounted(reload)
</script>
