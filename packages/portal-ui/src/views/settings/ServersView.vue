<template>
  <v-container>
    <div class="d-flex align-center mb-2 flex-wrap ga-2">
      <h1 class="text-h5">{{ $t('servers.title') }}</h1>
      <v-spacer />
      <v-btn v-if="!notHere" color="primary" data-test="add-server" @click="openAdd">
        <v-icon start>mdi-plus</v-icon>
        {{ $t('servers.add') }}
      </v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('servers.intro') }}</p>

    <!-- A master itself registers nowhere: the page is served by lgrai.app. -->
    <v-alert v-if="notHere" type="info" variant="tonal" data-test="servers-not-here">
      {{ $t('servers.notHere') }}
    </v-alert>

    <template v-else>
      <!-- FR-20.79: a move under way, or one that ended in the last day. -->
      <v-alert
        v-if="move && moveShown"
        :type="move.state === 'done' ? 'success' : move.state === 'aborted' ? 'warning' : 'info'"
        variant="tonal"
        class="mb-3"
        data-test="move-banner"
      >
        <div v-if="LIVE.includes(move.state)">{{ $t('servers.move.live', { name: nodeName(move.to), state: $t(`servers.move.state.${move.state}`) }) }}</div>
        <div v-else-if="move.state === 'done'">
          {{ $t('servers.move.done', { name: nodeName(move.to) }) }}
          <div class="text-caption mt-1">{{ $t('servers.move.desktopsNote') }}</div>
        </div>
        <div v-else>{{ $t('servers.move.state.aborted') }}<span v-if="move.error"> · {{ move.error }}</span></div>
        <template v-if="ABORTABLE.includes(move.state)" #append>
          <v-btn size="small" variant="text" color="error" :loading="moveBusy" data-test="abort-move" @click="abortMove">{{ $t('servers.move.abort') }}</v-btn>
        </template>
      </v-alert>
      <!-- FR-20.69 (P3-3): while one of the org's servers is its home, its files on lgrai.app. -->
      <v-card v-if="mirror && mirror.home !== 'global'" variant="outlined" class="mb-3" data-test="mirror-files">
        <v-card-title class="text-subtitle-1">{{ $t('servers.files.title') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-2">{{ $t('servers.files.intro', { name: nodeName(mirror.home) }) }}</p>
          <v-switch
            :model-value="mirror.files"
            :label="$t('servers.files.switch')"
            :hint="mirror.files ? '' : $t('servers.files.metadataOnly')"
            :persistent-hint="!mirror.files"
            :loading="mirrorBusy"
            :disabled="mirrorBusy"
            color="primary"
            density="compact"
            data-test="mirror-files-switch"
            @update:model-value="v => setMirrorFiles(!!v)"
          />
          <div class="text-body-2 mt-2" data-test="mirror-files-status">
            <template v-if="!mirror.referenced">{{ $t('servers.files.none') }}</template>
            <template v-else-if="mirror.complete">{{ $t('servers.files.complete', { count: mirror.referenced }) }}</template>
            <template v-else>{{ $t('servers.files.progress', { held: mirror.held, count: mirror.referenced }) }}</template>
            <span v-if="mirror.arriving"> {{ $t('servers.files.arriving', { count: mirror.arriving }) }}</span>
            <span v-if="mirror.files && mirror.waiting"> {{ $t('servers.files.waiting', { count: mirror.waiting }) }}</span>
          </div>
          <div v-if="mirror.missingOnMaster" class="text-body-2 text-warning mt-1">{{ $t('servers.files.missing', { count: mirror.missingOnMaster }) }}</div>
          <div v-if="mirror.failing" class="text-caption text-medium-emphasis mt-1">{{ $t('servers.files.failing', { count: mirror.failing }) }}</div>
        </v-card-text>
      </v-card>
      <v-switch
        v-model="includeRevoked"
        :label="$t('servers.includeRevoked')"
        density="compact"
        hide-details
        color="primary"
        class="mb-2"
      />
      <v-data-table
        :headers="headers"
        :items="items"
        :loading="loading"
        item-value="id"
        density="comfortable"
        :no-data-text="$t('servers.none')"
      >
        <template #item.name="{ item }">
          <div class="d-flex align-center ga-2">
            <span>{{ item.name }}</span>
            <v-chip v-if="item.ephemeral" size="x-small" variant="tonal" color="info">{{ $t('servers.ephemeral') }}</v-chip>
            <v-chip v-if="item.cloneAlarm" size="x-small" color="error" variant="flat" data-test="clone-alarm">{{ $t('servers.cloneAlarm') }}</v-chip>
          </div>
          <div class="text-caption text-medium-emphasis"><code>{{ item.id }}</code></div>
        </template>
        <template #item.linkLevel="{ item }">
          <v-chip size="small" variant="tonal" :color="item.linkLevel === 'full' ? 'primary' : undefined">
            {{ $t(`servers.linkLevel.${item.linkLevel}`) }}
          </v-chip>
        </template>
        <template #item.status="{ item }">
          <v-chip :color="item.status === 'active' ? 'success' : 'error'" size="small" variant="tonal">
            {{ item.status === 'active' ? $t('common.active') : $t('servers.revoked') }}
          </v-chip>
        </template>
        <template #item.os="{ item }">
          {{ item.os?.platform ? `${item.os.platform} ${item.os.version ?? ''}`.trim() : '—' }}
        </template>
        <template #item.version="{ item }">{{ item.health?.appVersion || item.versions?.app || '—' }}</template>
        <template #item.connected="{ item }">
          <div class="d-flex ga-1">
            <v-chip v-for="ch in ['interactive', 'bulk']" :key="ch" size="x-small" variant="tonal" :color="item.connected?.[ch] ? 'success' : undefined">
              {{ ch === 'interactive' ? 'I' : 'B' }} {{ item.connected?.[ch] ? $t('servers.live') : '—' }}
            </v-chip>
          </div>
        </template>
        <template #item.health="{ item }">
          <span v-if="item.health">
            <span v-if="typeof item.health.diskFreeBytes === 'number'">{{ $t('servers.diskFree', { gb: (item.health.diskFreeBytes / 2 ** 30).toFixed(1) }) }}</span>
            <span v-if="item.health.apiOk === false" class="text-error"> · {{ $t('servers.apiDown') }}</span>
            <!-- FR-20.20: an update that waits, and why; the alarm after seven nights kept out. -->
            <span v-if="item.health.update?.state === 'installing'"> · {{ $t('servers.updateInstalling', { version: item.health.update.available }) }}</span>
            <span v-if="item.health.update?.state === 'deferred'" :class="item.health.update.alarm ? 'text-error' : undefined">
              · {{ $t('servers.updateWaits', { version: item.health.update.available, reason: item.health.update.reason }) }}
              <template v-if="item.health.update.alarm"> · {{ $t('servers.updateAlarm', { n: item.health.update.blockedWindows }) }}</template>
            </span>
          </span>
          <span v-else class="text-medium-emphasis">—</span>
        </template>
        <template #item.relays="{ item }">
          <template v-if="item.status === 'active'">
            <v-switch
              v-for="kind in RELAY_KINDS"
              :key="kind"
              :model-value="!!item.relays?.[kind]"
              :label="$t(kind === 'mail' ? 'servers.relayMail' : 'servers.relayDocuments')"
              :hint="item.relays?.[kind + 'Chosen'] ? '' : $t('servers.relayDefault')"
              :persistent-hint="!item.relays?.[kind + 'Chosen']"
              :loading="relayBusy === item.id + ':' + kind"
              density="compact"
              color="primary"
              :data-test="'relay-' + kind"
              @update:model-value="v => setRelay(item, kind, !!v)"
            />
          </template>
        </template>
        <template #item.lastSeenAt="{ item }">
          {{ item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : '—' }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            v-if="item.status === 'active' && item.linkLevel === 'full' && !(move && LIVE.includes(move.state)) && move?.state !== 'done'"
            size="small"
            variant="text"
            color="primary"
            data-test="move-here"
            @click="openMove(item)"
          >
            {{ $t('servers.move.action') }}
          </v-btn>
          <v-btn
            v-if="item.status === 'active'"
            size="small"
            variant="text"
            color="error"
            data-test="remove-server"
            @click="openRemove(item)"
          >
            {{ $t('servers.remove') }}
          </v-btn>
        </template>
      </v-data-table>
      <p class="text-caption text-medium-emphasis mt-2">{{ $t('servers.relayWhat') }}</p>
      <p class="text-caption text-medium-emphasis mt-1">{{ $t('servers.relayDocumentsWhat') }}</p>
    </template>

    <!-- ── Add a server: a code for the master's setup ──────────────────────────────────────── -->
    <v-dialog v-model="addOpen" max-width="520" @after-leave="stopPolling">
      <v-card>
        <v-card-title>{{ $t('servers.add') }}</v-card-title>
        <v-card-text>
          <div v-if="minted">
            <p class="text-body-2 mb-3">{{ $t('servers.addHint') }}</p>
            <div class="text-center py-2">
              <div class="text-h3 font-weight-bold" style="letter-spacing: .15em" data-test="server-code">{{ minted.code }}</div>
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
            <div class="text-caption text-medium-emphasis">
              {{ countdownSeconds > 0 ? $t('servers.expiresIn', { time: countdownLabel }) : $t('servers.expired') }}
            </div>
          </div>
          <div v-else class="text-center py-6">
            <v-progress-circular indeterminate color="primary" />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="addOpen = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Move the org here (FR-20.79): every check at once, then the move ───────────────── -->
    <v-dialog v-model="moveOpen" max-width="620">
      <v-card>
        <v-card-title class="text-wrap">{{ $t('servers.move.title', { org: appStore.currentOrg?.name ?? '', name: moveTarget?.name }) }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ $t('servers.move.intro') }}</p>
          <div v-if="!preflight" class="text-center py-4">
            <v-progress-circular indeterminate color="primary" />
            <div class="text-caption mt-2">{{ $t('servers.move.checking') }}</div>
          </div>
          <template v-else>
            <div class="text-subtitle-2 mb-1">{{ $t('servers.move.checksTitle') }}</div>
            <v-list density="compact" class="py-0" data-test="move-checks">
              <v-list-item v-for="c in shownChecks" :key="c.name" :data-test="'check-' + c.name">
                <template #prepend>
                  <v-icon :color="c.ok ? 'success' : 'error'" size="small">{{ c.ok ? 'mdi-check-circle' : 'mdi-close-circle' }}</v-icon>
                </template>
                <v-list-item-title class="text-body-2 text-wrap">{{ $t(`servers.move.check.${c.name}`) }}</v-list-item-title>
                <v-list-item-subtitle v-if="!c.ok && c.detail" class="text-wrap">{{ c.detail }}</v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <template v-if="preflight.missingCredentials.length">
              <div class="text-subtitle-2 mt-3">{{ $t('servers.move.missingTitle') }}</div>
              <p class="text-caption text-medium-emphasis mb-1">{{ $t('servers.move.missingHint') }}</p>
              <v-checkbox
                v-for="p in preflight.missingCredentials"
                :key="p.identityId"
                v-model="allowMissing"
                :value="p.identityId"
                :label="p.email ? `${p.name} (${p.email})` : p.name"
                density="compact"
                hide-details
                data-test="allow-missing"
              />
            </template>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="moveOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :disabled="!canStart" :loading="moveBusy" data-test="start-move" @click="startMove">{{ $t('servers.move.start') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Take this org off a server ──────────────────────────────────────────────────────── -->
    <v-dialog v-model="removeOpen" max-width="520">
      <v-card>
        <v-card-title>{{ $t('servers.removeTitle', { name: removeTarget?.name }) }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ $t('servers.removeHint') }}</p>
          <v-text-field
            v-model="removeReason"
            :label="$t('servers.removeReason')"
            density="compact"
            variant="outlined"
            maxlength="200"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="removeOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="saving" data-test="confirm-remove" @click="handleRemove">{{ $t('servers.remove') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../../store/app.store'

/**
 * The Servers page (FR-20.2, plan step P2-1): the shop servers (masters) registered for this org,
 * a code to register another, and taking the org off one.
 *
 * ⚠ Gated SERVER-SIDE (`admin.settings`), like the Desktops page: portal routes have no client
 * guard. On a master every `/nodes` route is 404, and the page says servers are managed on
 * lgrai.app instead of showing an error.
 *
 * A plain `v-data-table`: an org has a handful of servers, never a page of them.
 *
 * FR-20.79 (P3-6a): "Move here" on a server linked at Full runs the move's preflight (every check
 * at once, the people without a local password the admin may let through), starts it, and the
 * banner follows it to the end. The server decides everything; the page only shows it.
 */

interface ServerRow {
  id: string
  name: string
  linkLevel: 'control' | 'full'
  status: 'active' | 'revoked'
  ephemeral: boolean
  os?: { platform?: string; version?: string }
  versions?: { app?: string }
  lastSeenAt?: string
  cloneAlarm?: boolean
  connected?: { interactive: boolean; bulk: boolean }
  health?: {
    appVersion?: string
    diskFreeBytes?: number
    apiOk?: boolean
    update?: { state?: string; available?: string; reason?: string; blockedWindows?: number; alarm?: boolean }
  } | null
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSnackbar } = useSnackbar()

const base = () => `${appStore.orgUrl()}/nodes`
const items = ref<ServerRow[]>([])
const loading = ref(false)
const includeRevoked = ref(false)
const notHere = ref(false)

const headers = computed(() => [
  { title: t('servers.name'), key: 'name' },
  { title: t('servers.linkLevelLabel'), key: 'linkLevel' },
  { title: t('servers.status'), key: 'status' },
  { title: t('servers.os'), key: 'os', sortable: false },
  { title: t('servers.version'), key: 'version', sortable: false },
  { title: t('servers.connected'), key: 'connected', sortable: false },
  { title: t('servers.health'), key: 'health', sortable: false },
  { title: t('servers.lastSeen'), key: 'lastSeenAt' },
  { title: t('servers.relays'), key: 'relays', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
])

/**
 * FR-20.59 (P2-6, P2-6b): whether lgrai.app sends this org's mail, and reads its documents, on the
 * server's behalf. The page says what leaves the building before either is turned on (FR-20.90).
 */
const RELAY_KINDS = ['mail', 'documents'] as const
const relayBusy = ref<string | null>(null)
async function setRelay(item: any, kind: (typeof RELAY_KINDS)[number], on: boolean) {
  relayBusy.value = `${item.id}:${kind}`
  try {
    const { data } = await httpClient.put(`${base()}/${item.id}/relays`, { [kind]: on })
    Object.assign(item, { relays: data.node?.relays })
  } finally {
    relayBusy.value = null
  }
}

/**
 * FR-20.69 (P3-3): the org's files on lgrai.app's mirror while one of its servers is its home, and
 * the org's choice to keep them there too or its records only.
 */
interface MirrorFiles {
  home: string
  files: boolean
  referenced: number
  held: number
  arriving: number
  waiting: number
  missingOnMaster: number
  failing: number
  complete: boolean
}
const mirror = ref<MirrorFiles | null>(null)
const mirrorBusy = ref(false)
async function loadMirror() {
  try {
    mirror.value = (await httpClient.get(`${base()}/mirror`)).data.mirror
  } catch {
    mirror.value = null
  }
}
async function setMirrorFiles(on: boolean) {
  mirrorBusy.value = true
  try {
    mirror.value = (await httpClient.put(`${base()}/mirror`, { files: on })).data.mirror
    showSnackbar(t('servers.files.saved'), 'success')
  } finally {
    mirrorBusy.value = false
  }
}

async function load() {
  void loadMove()
  void loadMirror()
  loading.value = true
  try {
    const { data } = await httpClient.get(base(), { params: { size: 100, ...(includeRevoked.value ? { includeRevoked: 'true' } : {}) } })
    items.value = data.nodes ?? []
  } catch (e: any) {
    if (e?.response?.status === 404) notHere.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(includeRevoked, load)

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showSnackbar(t('common.copied'), 'success')
  } catch { /* the code stays on screen */ }
}

// ── Add ─────────────────────────────────────────────────────────────────────────────────────
const addOpen = ref(false)
const minted = ref<{ id: string; code: string; expiresAt: string } | null>(null)
const countdownSeconds = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const countdownPercent = computed(() => Math.max(0, Math.min(100, (countdownSeconds.value / 600) * 100)))
const countdownLabel = computed(() => `${Math.floor(countdownSeconds.value / 60)}:${String(countdownSeconds.value % 60).padStart(2, '0')}`)

async function openAdd() {
  minted.value = null
  addOpen.value = true
  try {
    minted.value = (await httpClient.post(`${base()}/enrollment-codes`, {})).data
  } catch {
    addOpen.value = false
    return
  }
  const expiry = new Date(minted.value!.expiresAt).getTime()
  const tick = () => { countdownSeconds.value = Math.max(0, Math.round((expiry - Date.now()) / 1000)) }
  tick()
  countdownTimer = setInterval(tick, 1000)
  // Closes by itself once the server's setup has used the code.
  pollTimer = setInterval(async () => {
    if (!minted.value) return
    try {
      const { data } = await httpClient.get(`${base()}/enrollment-codes/${minted.value.id}`)
      if (data.state === 'used') {
        showSnackbar(t('servers.registered', { name: data.usedBy ?? '' }), 'success', 6000)
        addOpen.value = false
        await load()
      }
    } catch { /* transient: the countdown keeps running */ }
  }, 3000)
}

function stopPolling() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  minted.value = null
}
onUnmounted(() => {
  stopPolling()
  if (moveTimer) { clearInterval(moveTimer); moveTimer = null }
})

// ── Move here (FR-20.79) ────────────────────────────────────────────────────────────────────
interface MoveRow { id: string; state: string; to: string; endedAt?: string | null; error?: string | null }
interface Preflight { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }>; missingCredentials: Array<{ identityId: string; name: string; email?: string }> }

const LIVE = ['freezing', 'copying', 'verifying', 'flipped']
const ABORTABLE = ['freezing', 'copying', 'verifying']
const moveBase = () => `${appStore.orgUrl()}/moves`
const move = ref<MoveRow | null>(null)
const moveOpen = ref(false)
const moveTarget = ref<ServerRow | null>(null)
const preflight = ref<Preflight | null>(null)
const allowMissing = ref<string[]>([])
const moveBusy = ref(false)
let moveTimer: ReturnType<typeof setInterval> | null = null

const nodeName = (id: string) => items.value.find(i => i.id === id)?.name ?? id
/** A live move, or one that ended within a day. */
const moveShown = computed(() => !!move.value && (LIVE.includes(move.value.state) || (!!move.value.endedAt && Date.now() - new Date(move.value.endedAt).getTime() < 24 * 3600_000)))
/** The credentials check is the admin's to settle here: every person listed, ticked. */
const shownChecks = computed(() => (preflight.value?.checks ?? []).map(c => (c.name === 'credentials' ? { ...c, ok: credentialsSettled.value } : c)))
const credentialsSettled = computed(() => (preflight.value?.missingCredentials ?? []).every(p => allowMissing.value.includes(p.identityId)))
const canStart = computed(() => !!preflight.value && shownChecks.value.every(c => c.ok))

async function loadMove() {
  try {
    const { data } = await httpClient.get(`${moveBase()}/current`)
    move.value = data.move
  } catch { move.value = null }
  const live = !!move.value && LIVE.includes(move.value.state)
  if (live && !moveTimer) moveTimer = setInterval(loadMove, 3000)
  if (!live && moveTimer) {
    clearInterval(moveTimer)
    moveTimer = null
    if (move.value?.state === 'done') showSnackbar(t('servers.move.done', { name: nodeName(move.value.to) }), 'success', 6000)
  }
}

async function openMove(item: ServerRow) {
  moveTarget.value = item
  preflight.value = null
  allowMissing.value = []
  moveOpen.value = true
  try {
    preflight.value = (await httpClient.post(`${moveBase()}/preflight`, { nodeId: item.id })).data
  } catch {
    moveOpen.value = false
  }
}

async function startMove() {
  if (!moveTarget.value) return
  moveBusy.value = true
  try {
    const { data } = await httpClient.post(`${moveBase()}/`, { nodeId: moveTarget.value.id, allowMissing: allowMissing.value })
    move.value = data.move
    moveOpen.value = false
    showSnackbar(t('servers.move.started'), 'success')
    await loadMove()
  } catch (e: any) {
    // The checks changed under the dialog: show them as the server sees them now.
    if (e?.response?.data?.checks) preflight.value = { ok: false, checks: e.response.data.checks, missingCredentials: e.response.data.missingCredentials ?? [] }
  } finally {
    moveBusy.value = false
  }
}

async function abortMove() {
  if (!move.value) return
  moveBusy.value = true
  try {
    await httpClient.post(`${moveBase()}/${move.value.id}/abort`, {})
    showSnackbar(t('servers.move.aborted'), 'success')
    await loadMove()
  } catch { /* the shared client shows the error */ } finally {
    moveBusy.value = false
  }
}

// ── Remove ──────────────────────────────────────────────────────────────────────────────────
const removeOpen = ref(false)
const removeTarget = ref<ServerRow | null>(null)
const removeReason = ref('')
const saving = ref(false)

function openRemove(item: ServerRow) {
  removeTarget.value = item
  removeReason.value = ''
  removeOpen.value = true
}

async function handleRemove() {
  if (!removeTarget.value) return
  saving.value = true
  try {
    await httpClient.post(`${base()}/${removeTarget.value.id}/revoke`, removeReason.value ? { reason: removeReason.value } : {})
    showSnackbar(t('servers.removed', { name: removeTarget.value.name }), 'success')
    removeOpen.value = false
    await load()
  } catch { /* the shared client shows the error */ } finally {
    saving.value = false
  }
}
</script>
