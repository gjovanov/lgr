<template>
  <v-container>
    <h1 class="text-h5 mb-2">{{ $t('serverStatus.title') }}</h1>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('serverStatus.intro') }}</p>

    <v-alert v-if="elsewhere" type="info" variant="tonal" data-test="server-elsewhere">
      {{ $t('serverStatus.elsewhere') }}
      <router-link to="/settings/servers">{{ $t('servers.title') }}</router-link>
    </v-alert>
    <v-progress-linear v-else-if="loading && !s" indeterminate />

    <template v-if="s">
      <v-alert v-if="!s.supervisor || !s.supervisor.fresh" type="warning" variant="tonal" class="mb-3" data-test="server-stale">
        {{ s.supervisor?.writtenAt ? $t('serverStatus.stale', { when: when(s.supervisor.writtenAt) }) : $t('serverStatus.noSupervisor') }}
      </v-alert>

      <v-row dense>
        <!-- The server itself (FR-20.98). -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" data-test="server-machine">
            <v-card-title class="text-subtitle-1">{{ $t('serverStatus.machine') }}</v-card-title>
            <v-card-text>
              <dl class="kv">
                <dt>{{ $t('serverStatus.version') }}</dt><dd>{{ s.supervisor?.version ?? '—' }}</dd>
                <dt>{{ $t('serverStatus.supto') }}</dt><dd data-test="server-supto">{{ s.supervisor?.update?.supto ?? '—' }}</dd>
                <dt>{{ $t('serverStatus.uptime') }}</dt><dd>{{ s.supervisor?.uptimeSecs != null ? duration(s.supervisor.uptimeSecs) : '—' }}</dd>
                <dt>{{ $t('serverStatus.processes') }}</dt>
                <dd><v-chip v-for="c in s.supervisor?.children ?? []" :key="c.name" size="x-small" :color="c.state === 'running' ? 'success' : 'error'" variant="tonal" class="mr-1">{{ c.name }}: {{ c.state }}</v-chip></dd>
                <dt>{{ $t('serverStatus.disk') }}</dt><dd>{{ diskText }}</dd>
                <dt>{{ $t('serverStatus.oplog') }}</dt><dd>{{ s.supervisor?.oplogWindowSecs != null ? duration(s.supervisor.oplogWindowSecs) : $t('serverStatus.oplogNotFull') }}</dd>
                <dt>{{ $t('serverStatus.update') }}</dt><dd :class="s.supervisor?.update?.alarm || s.supervisor?.update?.suptoWaiting ? 'text-error' : undefined">{{ updateText }}</dd>
              </dl>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- The link to lgrai.app, and this org's copy there. -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" data-test="server-link">
            <v-card-title class="text-subtitle-1">{{ $t('serverStatus.link') }}</v-card-title>
            <v-card-text>
              <dl class="kv">
                <dt>{{ $t('serverStatus.linkLevel') }}</dt><dd>{{ linkText }}</dd>
                <dt>{{ $t('serverStatus.sockets') }}</dt>
                <dd>
                  <v-chip size="x-small" :color="s.supervisor?.uplink?.interactive === 'connected' ? 'success' : undefined" variant="tonal" class="mr-1">{{ $t('serverStatus.socketControl') }}: {{ s.supervisor?.uplink?.interactive ?? '—' }}</v-chip>
                  <v-chip size="x-small" :color="s.supervisor?.uplink?.bulk === 'connected' ? 'success' : undefined" variant="tonal">{{ $t('serverStatus.socketMirror') }}: {{ s.supervisor?.uplink?.bulk ?? '—' }}</v-chip>
                </dd>
                <dt>{{ $t('serverStatus.pacing') }}</dt><dd>{{ pacingText }}</dd>
                <dt>{{ $t('serverStatus.journal') }}</dt><dd>{{ s.org.journalHead }}</dd>
                <dt>{{ $t('serverStatus.mirror') }}</dt><dd data-test="server-mirror">{{ mirrorText }}</dd>
                <dt>{{ $t('serverStatus.outbox') }}</dt><dd>{{ s.org.outboxQueued }}</dd>
              </dl>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- The org on this server. -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" data-test="server-org">
            <v-card-title class="text-subtitle-1">{{ $t('serverStatus.org') }}</v-card-title>
            <v-card-text>
              <dl class="kv">
                <dt>{{ $t('serverStatus.home') }}</dt><dd>{{ s.org.home?.here ? $t('serverStatus.homeHere', { state: s.org.home.state }) : $t('serverStatus.homeElsewhere') }}</dd>
                <dt>{{ $t('serverStatus.numbering') }}</dt><dd>{{ s.org.home?.numberingLocked ? $t('servers.numberingLocked') : $t('serverStatus.numberingOpen') }}</dd>
                <dt>{{ $t('serverStatus.backup') }}</dt><dd>{{ s.org.lastBackupAt ? when(s.org.lastBackupAt) : $t('servers.alarm.backup_none') }}</dd>
                <dt>{{ $t('serverStatus.licence') }}</dt><dd>{{ licenceText }}</dd>
                <dt>{{ $t('serverStatus.desktops') }}</dt><dd>{{ $t('serverStatus.desktopsText', { online: s.org.desktops.online, active: s.org.desktops.active }) }}</dd>
              </dl>
              <div class="text-subtitle-2 mt-3">{{ $t('serverStatus.fiscal') }}</div>
              <div v-if="!s.org.fiscalDevices.length" class="text-body-2 text-medium-emphasis">—</div>
              <div v-for="d in s.org.fiscalDevices" :key="d.deviceNumber" class="text-body-2">
                {{ d.name }} · {{ d.manufacturer }} {{ d.deviceNumber }} · {{ d.connectionType }} · <v-chip size="x-small" variant="tonal" :color="d.status === 'online' ? 'success' : undefined">{{ d.status }}</v-chip>
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- FR-20.50: the trader's Прил. 32, ready to copy. -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" data-test="server-pril32">
            <v-card-title class="text-subtitle-1 d-flex align-center">
              {{ $t('serverStatus.pril32') }}
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" data-test="pril32-copy" @click="copyPril32">{{ $t('serverStatus.copy') }}</v-btn>
            </v-card-title>
            <v-card-text>
              <p class="text-caption text-medium-emphasis mb-2">{{ $t('serverStatus.pril32Intro') }}</p>
              <dl class="kv">
                <template v-for="row in pril32Rows" :key="row.label">
                  <dt>{{ row.label }}</dt><dd>{{ row.value }}</dd>
                </template>
              </dl>
              <!-- FR-20.47 (P3-8e): where an inspector reaches this server (Н-18 чл. 52и(1)). -->
              <v-alert v-if="inspectionAlert" :type="inspectionAlert.type" variant="tonal" density="compact" class="mt-3" data-test="inspection-alert">
                {{ inspectionAlert.text }}
              </v-alert>
              <div class="mt-2">
                <v-btn size="small" variant="tonal" prepend-icon="mdi-shield-search" data-test="inspection-edit" @click="openInspection">{{ $t('serverStatus.inspection.edit') }}</v-btn>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </template>

    <v-dialog v-model="inspectionDialog" max-width="560">
      <v-card data-test="inspection-dialog">
        <v-card-title>{{ $t('serverStatus.inspection.title') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ $t('serverStatus.inspection.intro') }}</p>
          <v-radio-group v-model="form.premises" :label="$t('serverStatus.inspection.premises')" data-test="inspection-premises">
            <v-radio value="shop" :label="$t('serverStatus.inspection.shop')" />
            <v-radio value="offsite" :label="$t('serverStatus.inspection.offsite')" />
          </v-radio-group>
          <template v-if="form.premises === 'offsite'">
            <v-radio-group v-model="form.path" :label="$t('serverStatus.inspection.path')" data-test="inspection-path">
              <v-radio value="tunnel" :disabled="!!tunnelBlocked" :label="tunnelLabel" />
              <v-radio value="overlay" :label="$t('serverStatus.inspection.overlay')" />
              <v-radio value="vpn" :label="$t('serverStatus.inspection.vpn')" />
            </v-radio-group>
            <v-text-field
              v-if="form.path === 'overlay' || form.path === 'vpn'"
              v-model="form.detail"
              :label="$t('serverStatus.inspection.detail')"
              :hint="$t('serverStatus.inspection.detailHint')"
              persistent-hint
              maxlength="200"
              data-test="inspection-detail"
            />
          </template>
          <v-alert v-if="inspectionError" type="error" variant="tonal" density="compact" class="mt-3">{{ inspectionError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="inspectionDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="savingInspection" :disabled="!formReady" data-test="inspection-save" @click="saveInspection">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useNodeAlarms } from 'ui-shared/composables/useNodeAlarms'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../../store/app.store'

/**
 * A master's own status page (FR-20.98, FR-20.50, plan step P3-8b): on the server, for the org's
 * admins, offline above all. What the supervisor last wrote of itself, what this database says of
 * the org, and the Прил. 32 fields ready to copy. Refreshed every 30 s, as the supervisor writes.
 * On lgrai.app the route answers 404 and the page says where its servers are shown.
 */

const { t, te } = useI18n()
const { duration } = useNodeAlarms()
const { showSnackbar } = useSnackbar()
const appStore = useAppStore()
const s = ref<any | null>(null)
const loading = ref(false)
const elsewhere = ref(false)

const when = (v: string) => new Date(v).toLocaleString()
const gb = (b: number) => (b / 2 ** 30).toFixed(1)

const diskText = computed(() => {
  const d = s.value?.supervisor?.disk
  if (!d || d.freeBytes == null) return '—'
  return d.totalBytes ? t('serverStatus.diskText', { free: gb(d.freeBytes), total: gb(d.totalBytes), pct: Math.round((d.freeBytes / d.totalBytes) * 100) }) : `${gb(d.freeBytes)} GB`
})
const updateText = computed(() => {
  const u = s.value?.supervisor?.update
  if (!u) return '—'
  if (u.state === 'installing') return t('servers.updateInstalling', { version: u.available })
  if (u.state === 'deferred' && u.suptoWaiting) return t('serverStatus.updateSuptoWaits', { version: u.available, supto: u.suptoWaiting })
  if (u.state === 'deferred') {
    const waits = t('servers.updateWaits', { version: u.available, reason: u.reason ?? '' })
    return u.alarm ? `${waits} · ${t('servers.updateAlarm', { n: u.blockedWindows })}` : waits
  }
  if (u.state === 'not-versioned') return t('serverStatus.updateNotVersioned')
  return t('serverStatus.updateUpToDate', { running: u.running ?? '—' })
})
const pacingText = computed(() => {
  const p = s.value?.supervisor?.uplink?.pacing
  if (!p) return '—'
  return t('serverStatus.pacingText', { rate: Math.round((p.rateBytesPerSec ?? 0) / 1024), delay: p.delayMs ?? '—' })
})
const linkText = computed(() => {
  const level = s.value?.supervisor?.linkLevel
  if (!level) return t('serverStatus.notRegistered')
  return te(`servers.linkLevel.${level}`) ? t(`servers.linkLevel.${level}`) : level
})
const licenceText = computed(() => {
  const l = s.value?.org?.licence
  if (!l) return t('serverStatus.noLicence')
  if (l.error) return t('serverStatus.licenceUnreadable')
  return t('serverStatus.licenceText', { plan: l.plan ?? '—', through: l.paidThrough ?? '—' })
})
const mirrorText = computed(() => {
  const m = s.value?.org?.mirror
  if (!m) return t('serverStatus.mirrorUnknown')
  return m.behind ? t('serverStatus.mirrorBehind', { n: m.behind, when: m.lastPageAt ? when(m.lastPageAt) : '—' }) : t('serverStatus.mirrorCurrent', { when: m.lastPageAt ? when(m.lastPageAt) : '—' })
})
const pril32Rows = computed(() => {
  const p = s.value?.pril32
  if (!p) return []
  return [
    { label: t('serverStatus.p32.internet'), value: t('serverStatus.p32.internetValue', { mirror: p.mirror ?? 'lgrai.app' }) },
    { label: t('serverStatus.p32.installation'), value: t('serverStatus.p32.installationValue', { host: p.host, desktops: p.desktops }) },
    { label: t('serverStatus.p32.location'), value: t('serverStatus.p32.locationValue', { host: p.host, lan: p.lanUrl ?? '—', mirror: p.mirror ?? 'lgrai.app' }) },
    { label: t('serverStatus.p32.database'), value: t('serverStatus.p32.databaseValue', { db: p.database, address: p.databaseAddress ?? '—' }) },
    { label: t('serverStatus.p32.protocol'), value: t('serverStatus.p32.protocolValue') },
    { label: t('serverStatus.p32.supto'), value: p.supto ?? '—' },
    { label: t('serverStatus.p32.topology'), value: t('serverStatus.p32.topologyValue', { desktops: p.desktops, mirror: p.mirror ?? 'lgrai.app', link: linkText.value, version: p.version ?? '?' }) },
    { label: t('serverStatus.p32.inspection'), value: inspectionText.value },
  ]
})

// FR-20.47 (P3-8e): where an inspector reaches this server, as the trader declares it in Прил. 32.
const inspection = computed(() => s.value?.pril32?.inspection ?? null)
const inspectionText = computed(() => {
  const i = inspection.value
  if (!i?.declared) return t('serverStatus.inspection.undeclaredShort')
  if (i.premises === 'shop') return t('serverStatus.inspection.shopValue')
  if (i.path === 'tunnel') return t('serverStatus.inspection.tunnelValue', { address: i.address ?? '—' })
  if (i.path === 'overlay') return t('serverStatus.inspection.overlayValue', { detail: i.detail ?? '—' })
  if (i.path === 'vpn') return t('serverStatus.inspection.vpnValue', { detail: i.detail ?? '—' })
  return t('serverStatus.inspection.pathMissingShort')
})
const inspectionAlert = computed(() => {
  const problem = inspection.value?.problem
  if (!problem) return null
  if (problem === 'undeclared') return { type: 'info' as const, text: t('serverStatus.inspection.undeclared') }
  return { type: 'warning' as const, text: t(`serverStatus.inspection.problem.${problem}`) }
})
const tunnelBlocked = computed(() => inspection.value?.tunnel?.problem ?? 'link_not_full')
const tunnelLabel = computed(() => (tunnelBlocked.value
  ? `${t('serverStatus.inspection.tunnel')} (${t(`serverStatus.inspection.problem.${tunnelBlocked.value}`)})`
  : t('serverStatus.inspection.tunnelAt', { address: inspection.value?.tunnel?.address ?? '' })))
const inspectionDialog = ref(false)
const savingInspection = ref(false)
const inspectionError = ref('')
const form = reactive<{ premises: string | null; path: string | null; detail: string }>({ premises: null, path: null, detail: '' })
const formReady = computed(() => form.premises === 'shop'
  || (form.premises === 'offsite' && (form.path === 'tunnel' || ((form.path === 'overlay' || form.path === 'vpn') && form.detail.trim().length > 0))))
function openInspection() {
  const i = inspection.value
  form.premises = i?.premises ?? null
  form.path = i?.path ?? null
  form.detail = i?.detail ?? ''
  inspectionError.value = ''
  inspectionDialog.value = true
}
async function saveInspection() {
  const orgId = appStore.currentOrg?.id
  if (!orgId) return
  savingInspection.value = true
  inspectionError.value = ''
  try {
    await httpClient.put(`/org/${orgId}/server/inspection`, {
      premises: form.premises,
      path: form.premises === 'offsite' ? form.path : null,
      detail: form.premises === 'offsite' && form.path !== 'tunnel' ? form.detail.trim() : null,
    })
    inspectionDialog.value = false
    showSnackbar(t('serverStatus.inspection.saved'), 'success')
    await load()
  } catch (e: any) {
    const code = e?.response?.data?.code
    inspectionError.value = code && te(`serverStatus.inspection.problem.${code}`) ? t(`serverStatus.inspection.problem.${code}`) : (e?.response?.data?.message ?? t('serverStatus.inspection.failed'))
  } finally {
    savingInspection.value = false
  }
}

async function copyPril32() {
  const text = pril32Rows.value.map(r => `${r.label}: ${r.value}`).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    showSnackbar(t('serverStatus.copied'), 'success')
  } catch {
    showSnackbar(t('serverStatus.copyFailed'), 'error')
  }
}

async function load() {
  const orgId = appStore.currentOrg?.id
  if (!orgId) return
  loading.value = true
  try {
    s.value = (await httpClient.get(`/org/${orgId}/server/status`)).data.status
  } catch (e: any) {
    if (e?.response?.status === 404) elsewhere.value = true
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  timer = setInterval(() => { if (!elsewhere.value) void load() }, 30_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.kv { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr; gap: 0.25rem 1rem; }
.kv dt { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.kv dd { margin: 0; }
</style>
