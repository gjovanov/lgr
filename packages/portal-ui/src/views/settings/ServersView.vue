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
          </span>
          <span v-else class="text-medium-emphasis">—</span>
        </template>
        <template #item.lastSeenAt="{ item }">
          {{ item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : '—' }}
        </template>
        <template #item.actions="{ item }">
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
  health?: { appVersion?: string; diskFreeBytes?: number; apiOk?: boolean } | null
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
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
])

async function load() {
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
onUnmounted(stopPolling)

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
