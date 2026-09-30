<template>
  <v-container>
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <h1 class="text-h5">{{ $t('desktops.title') }}</h1>
      <v-spacer />
      <v-text-field
        v-model="search"
        :label="$t('common.search')"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        variant="outlined"
        hide-details
        clearable
        style="max-width: 220px"
      />
      <v-btn variant="text" :loading="updatingAll" @click="handleUpdateAll">
        <v-icon start>mdi-update</v-icon>
        {{ $t('desktops.updateAll') }}
      </v-btn>
      <v-btn color="primary" @click="openRegister">
        <v-icon start>mdi-plus</v-icon>
        {{ $t('desktops.register') }}
      </v-btn>
    </div>

    <div class="d-flex align-center mb-2 ga-4">
      <v-switch
        v-model="includeRevoked"
        :label="$t('desktops.includeRevoked')"
        density="compact"
        hide-details
        color="primary"
      />
      <v-switch
        v-model="autoRefresh"
        :label="$t('desktops.autoRefresh')"
        density="compact"
        hide-details
        color="primary"
      />
    </div>

    <v-data-table-server
      :headers="headers"
      :items="items"
      :items-length="pagination.total"
      :loading="loading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      @update:options="onUpdateOptions"
      item-value="id"
      density="comfortable"
    >
      <template #item.name="{ item }">
        <div class="d-flex align-center ga-2">
          <v-tooltip :text="presenceLabel(item.presence)" location="top">
            <template #activator="{ props }">
              <v-icon v-bind="props" :color="presenceColor(item.presence)" size="12">mdi-circle</v-icon>
            </template>
          </v-tooltip>
          <span>{{ item.name }}</span>
          <v-chip v-if="item.ephemeral" size="x-small" variant="tonal" color="info">
            {{ $t('desktops.ephemeral') }}
          </v-chip>
          <v-btn icon size="x-small" variant="text" @click="copy(item.id)">
            <v-icon size="small">mdi-content-copy</v-icon>
          </v-btn>
        </div>
      </template>

      <template #item.status="{ item }">
        <v-chip :color="item.status === 'active' ? 'success' : 'error'" size="small" variant="tonal">
          {{ item.status === 'active' ? $t('common.active') : $t('desktops.revoked') }}
        </v-chip>
      </template>

      <template #item.appVersion="{ item }">
        {{ item.appVersion || '—' }}
      </template>

      <template #item.os="{ item }">
        {{ item.os?.platform ? `${item.os.platform} ${item.os.version ?? ''}`.trim() : '—' }}
      </template>

      <template #item.fiscalDevices="{ item }">
        <span v-if="!item.fiscalDeviceIds?.length" class="text-medium-emphasis">—</span>
        <span v-else>{{ item.fiscalDeviceIds.map(deviceLabel).join(', ') }}</span>
      </template>

      <template #item.startPath="{ item }">
        <code v-if="item.startPath">{{ item.startPath }}</code>
        <span v-else class="text-medium-emphasis">/</span>
      </template>

      <template #item.lastSeenAt="{ item }">
        {{ item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : '—' }}
      </template>

      <!--
        FR-14.21 — skew beyond ±2 min is flagged. It is worth showing because a wrong clock on a
        till breaks fiscal device time sync, which is Bulgarian-time-sensitive.
      -->
      <template #item.clock="{ item }">
        <v-chip v-if="skewFlagged(item.clockSkewMs)" color="warning" size="small" variant="tonal">
          {{ formatSkew(item.clockSkewMs) }}
        </v-chip>
        <span v-else-if="item.clockSkewMs != null" class="text-medium-emphasis">
          {{ formatSkew(item.clockSkewMs) }}
        </span>
        <span v-else class="text-medium-emphasis">—</span>
      </template>

      <template #item.actions="{ item }">
        <v-menu>
          <template #activator="{ props }">
            <v-btn icon size="small" variant="text" v-bind="props">
              <v-icon>mdi-dots-vertical</v-icon>
            </v-btn>
          </template>
          <v-list density="compact">
            <v-list-item :disabled="item.status !== 'active'" @click="openAssign(item)">
              <template #prepend><v-icon size="small">mdi-pencil</v-icon></template>
              <v-list-item-title>{{ $t('desktops.renameAssign') }}</v-list-item-title>
            </v-list-item>
            <v-list-item :disabled="item.status !== 'active'" @click="handleUpdate(item)">
              <template #prepend><v-icon size="small">mdi-update</v-icon></template>
              <v-list-item-title>{{ $t('desktops.updateNow') }}</v-list-item-title>
            </v-list-item>
            <v-list-item :disabled="item.status !== 'active'" @click="handleRotate(item)">
              <template #prepend><v-icon size="small">mdi-key-change</v-icon></template>
              <v-list-item-title>{{ $t('desktops.rotateKey') }}</v-list-item-title>
            </v-list-item>
            <v-divider />
            <v-list-item
              :disabled="item.status !== 'active'"
              base-color="error"
              @click="openRevoke(item)"
            >
              <template #prepend><v-icon size="small">mdi-close-circle-outline</v-icon></template>
              <v-list-item-title>{{ $t('desktops.revokeAction') }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
      </template>
    </v-data-table-server>

    <!-- ── Register a desktop ─────────────────────────────────────────────────────────────── -->
    <v-dialog v-model="registerOpen" max-width="560" @after-leave="stopPolling">
      <v-card>
        <v-card-title>{{ $t('desktops.register') }}</v-card-title>
        <v-card-text>
          <div v-if="minted">
            <p class="text-body-2 mb-3">{{ $t('desktops.registerHint') }}</p>
            <div class="text-center py-2">
              <div class="text-h3 font-weight-bold" style="letter-spacing: .15em">{{ minted.code }}</div>
              <v-btn variant="text" size="small" class="mt-1" @click="copy(minted.code)">
                <v-icon start size="small">mdi-content-copy</v-icon>
                {{ $t('common.copy') }}
              </v-btn>
            </div>
            <v-progress-linear
              :model-value="countdownPercent"
              :color="countdownSeconds > 60 ? 'primary' : 'warning'"
              height="6"
              rounded
              class="mb-1"
            />
            <div class="text-caption text-medium-emphasis mb-4">
              {{ countdownSeconds > 0
                ? $t('desktops.expiresIn', { time: countdownLabel })
                : $t('desktops.expired') }}
            </div>

            <!--
              The deep link, as text. ⚠ No QR code: there is no QR library in this repo and
              FR-14.23's QR is not worth a new frontend dependency in the chunk that only needs
              the code to reach one machine. It is a one-line addition later if asked for.
            -->
            <v-text-field
              :model-value="minted.deepLink"
              :label="$t('desktops.deepLink')"
              readonly
              density="compact"
              variant="outlined"
              append-inner-icon="mdi-content-copy"
              @click:append-inner="copy(minted.deepLink)"
            />
            <p class="text-caption text-medium-emphasis mb-0">{{ $t('desktops.deepLinkHint') }}</p>
          </div>
          <div v-else class="text-center py-6">
            <v-progress-circular indeterminate color="primary" />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="registerOpen = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Rename + assign ──────────────────────────────────────────────────────────────── -->
    <v-dialog v-model="assignOpen" max-width="520">
      <v-card>
        <v-card-title>{{ $t('desktops.renameAssign') }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="assignForm.name"
            :label="$t('desktops.name')"
            density="compact"
            variant="outlined"
          />
          <v-text-field
            v-model="assignForm.startPath"
            :label="$t('desktops.startPath')"
            :hint="$t('desktops.startPathHint')"
            persistent-hint
            placeholder="/pos/"
            density="compact"
            variant="outlined"
            class="mb-3"
          />
          <v-select
            v-model="assignForm.fiscalDeviceIds"
            :items="fiscalDevices"
            item-title="label"
            item-value="id"
            :label="$t('desktops.fiscalDevices')"
            :hint="$t('desktops.fiscalDevicesHint')"
            persistent-hint
            multiple
            chips
            density="compact"
            variant="outlined"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="assignOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" @click="handleAssign">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Revoke ───────────────────────────────────────────────────────────────────────── -->
    <v-dialog v-model="revokeOpen" max-width="520">
      <v-card>
        <v-card-title>{{ $t('desktops.revokeTitle', { name: revokeTarget?.name }) }}</v-card-title>
        <v-card-text>
          <!--
            ⚠ The confirmation says WHAT HAPPENS, not "are you sure". Revoking a till stops its
            fiscal bridge, and a dialog that does not say so is how a shop loses its printer
            mid-day (FR-14.23).
          -->
          <v-alert type="warning" variant="tonal" density="comfortable" class="mb-3">
            {{ $t('desktops.revokeWarning') }}
          </v-alert>
          <p v-if="revokeTarget?.ephemeral" class="text-body-2 mb-3">
            {{ $t('desktops.revokeEphemeral') }}
          </p>
          <v-text-field
            v-model="revokeReason"
            :label="$t('desktops.revokeReason')"
            density="compact"
            variant="outlined"
            hide-details
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="revokeOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="saving" @click="handleRevoke">
            {{ $t('desktops.revokeAction') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../../store/app.store'
import { useDesktopStore, type Desktop } from '../../store/desktop.store'

/**
 * The Desktops page (FR-14.23) — presence, assignment and revocation for every registered
 * LGR Desktop of the org.
 *
 * ⚠ Gated SERVER-SIDE. Portal routes have no client-side guard (FR-13 trap 20), so the
 * `admin.settings` check on every endpoint is the whole control; this page simply shows the 403
 * if a non-admin reaches it.
 *
 * ⚠ It uses `v-data-table-server` rather than `ListScaffold`. `ListScaffold` (and with it
 * `useGridColumns`' column picker) lives in the domain UIs — portal-ui has never used it, and
 * introducing it here for one page would be a bigger change than the page.
 */

const { t } = useI18n()
const appStore = useAppStore()
const desktopStore = useDesktopStore()
const { showSnackbar } = useSnackbar()

const search = ref('')
const includeRevoked = ref(false)
const autoRefresh = ref(true)

const filters = computed(() => ({
  ...(search.value ? { search: search.value } : {}),
  ...(includeRevoked.value ? { includeRevoked: 'true' } : {}),
}))

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/desktops`),
  entityKey: 'desktops',
  defaultSize: 25,
  defaultSortBy: 'lastSeenAt',
  filters: filters as any,
})

const headers = computed(() => [
  { title: '', key: 'actions', sortable: false, width: 50 },
  { title: t('desktops.desktop'), key: 'name', sortable: false },
  { title: t('common.status'), key: 'status', sortable: false },
  { title: t('desktops.version'), key: 'appVersion', sortable: false },
  { title: t('desktops.os'), key: 'os', sortable: false },
  { title: t('desktops.fiscalDevices'), key: 'fiscalDevices', sortable: false },
  { title: t('desktops.startPath'), key: 'startPath', sortable: false },
  { title: t('desktops.lastSeen'), key: 'lastSeenAt' },
  { title: t('desktops.clock'), key: 'clock', sortable: false },
])

// ── Presence ────────────────────────────────────────────────────────────────────────────────
function presenceColor(p: string) {
  return p === 'online' ? 'success' : p === 'stale' ? 'warning' : 'grey'
}
function presenceLabel(p: string) {
  return t(`desktops.presence.${p}`)
}

/** FR-14.21: anything beyond ±2 min is flagged. */
function skewFlagged(ms?: number) {
  return ms != null && Math.abs(ms) > 2 * 60 * 1000
}
function formatSkew(ms?: number) {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (Math.abs(s) < 60) return `${s > 0 ? '+' : ''}${s}s`
  const m = Math.round(s / 60)
  if (Math.abs(m) < 60) return `${m > 0 ? '+' : ''}${m}m`
  return `${m > 0 ? '+' : ''}${(m / 60).toFixed(1)}h`
}

// ── Fiscal devices, for the assign dialog ───────────────────────────────────────────────────
const fiscalDevices = ref<{ id: string; label: string }[]>([])
async function loadFiscalDevices() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/fiscal/device`, {
      params: { isActive: 'true', size: 0 },
    })
    fiscalDevices.value = (data.fiscalDevices || []).map((d: any) => ({
      id: String(d.id ?? d._id),
      label: `${d.name} (${d.deviceNumber})`,
    }))
  } catch {
    // Not fatal: the dialog still opens, just without a picker list.
    fiscalDevices.value = []
  }
}
function deviceLabel(id: string) {
  return fiscalDevices.value.find(d => d.id === id)?.label ?? id.slice(-6)
}

// ── Auto-refresh ────────────────────────────────────────────────────────────────────────────
// ⚠ Paused while any dialog is open. A 10 s refresh that reorders the table under an open row
// menu, or repaints while someone is typing a name, is worse than a stale list.
let refreshTimer: ReturnType<typeof setInterval> | null = null
const anyDialogOpen = computed(() => registerOpen.value || assignOpen.value || revokeOpen.value)

watch([autoRefresh, anyDialogOpen], ([on, dialog]) => {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (on && !dialog) refreshTimer = setInterval(() => { void fetchItems() }, 10_000)
}, { immediate: true })

onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })

// ── Register ────────────────────────────────────────────────────────────────────────────────
const registerOpen = ref(false)
const minted = ref<{ id: string; code: string; expiresAt: string; deepLink: string } | null>(null)
const countdownSeconds = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

const countdownPercent = computed(() => Math.max(0, Math.min(100, (countdownSeconds.value / 600) * 100)))
const countdownLabel = computed(() => {
  const s = countdownSeconds.value
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

async function openRegister() {
  minted.value = null
  registerOpen.value = true
  try {
    minted.value = await desktopStore.mintCode()
  } catch {
    registerOpen.value = false
    return
  }
  const expiry = new Date(minted.value.expiresAt).getTime()
  const tick = () => { countdownSeconds.value = Math.max(0, Math.round((expiry - Date.now()) / 1000)) }
  tick()
  countdownTimer = setInterval(tick, 1000)
  // Close by itself once the desktop has used the code (FR-14.23).
  pollTimer = setInterval(async () => {
    if (!minted.value) return
    try {
      const state = await desktopStore.codeState(minted.value.id)
      if (state.state === 'used') {
        showSnackbar(t('desktops.registered', { name: state.usedBy ?? '' }), 'success', 6000)
        registerOpen.value = false
        await fetchItems()
      }
    } catch { /* transient; the countdown keeps running */ }
  }, 3000)
}

function stopPolling() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  minted.value = null
}
onUnmounted(stopPolling)

// ── Row actions ─────────────────────────────────────────────────────────────────────────────
const saving = ref(false)
const updatingAll = ref(false)

const assignOpen = ref(false)
const assignTarget = ref<Desktop | null>(null)
const assignForm = reactive({ name: '', startPath: '', fiscalDeviceIds: [] as string[] })

async function openAssign(item: Desktop) {
  assignTarget.value = item
  assignForm.name = item.name
  assignForm.startPath = item.startPath ?? ''
  assignForm.fiscalDeviceIds = [...(item.fiscalDeviceIds ?? [])]
  assignOpen.value = true
  if (!fiscalDevices.value.length) await loadFiscalDevices()
}

async function handleAssign() {
  if (!assignTarget.value) return
  saving.value = true
  try {
    await desktopStore.update(assignTarget.value.id, {
      name: assignForm.name,
      startPath: assignForm.startPath,
      fiscalDeviceIds: assignForm.fiscalDeviceIds,
    })
    assignOpen.value = false
    await fetchItems()
  } finally {
    saving.value = false
  }
}

const revokeOpen = ref(false)
const revokeTarget = ref<Desktop | null>(null)
const revokeReason = ref('')

function openRevoke(item: Desktop) {
  revokeTarget.value = item
  revokeReason.value = ''
  revokeOpen.value = true
}

async function handleRevoke() {
  if (!revokeTarget.value) return
  saving.value = true
  try {
    await desktopStore.revoke(revokeTarget.value.id, revokeReason.value || undefined)
    revokeOpen.value = false
    await fetchItems()
  } finally {
    saving.value = false
  }
}

async function handleRotate(item: Desktop) {
  const epoch = await desktopStore.rotateKey(item.id)
  showSnackbar(t('desktops.keyRotated', { epoch }), 'success')
  await fetchItems()
}

async function handleUpdate(item: Desktop) {
  const delivered = await desktopStore.requestUpdate(item.id)
  // ⚠ Not delivered is NOT an error: a till that is switched off checks on its next start.
  showSnackbar(
    delivered ? t('desktops.updateSent') : t('desktops.updateQueued'),
    delivered ? 'success' : 'info',
  )
}

async function handleUpdateAll() {
  updatingAll.value = true
  try {
    const r = await desktopStore.requestUpdateAll()
    showSnackbar(t('desktops.updateAllResult', { delivered: r.delivered, requested: r.requested }), 'info', 8000)
  } finally {
    updatingAll.value = false
  }
}

function copy(text: string) {
  navigator.clipboard.writeText(text)
  showSnackbar(t('common.copied'), 'success', 2000)
}
</script>
