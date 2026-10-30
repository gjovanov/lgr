<template>
  <v-container>
    <div class="d-flex align-center mb-2 flex-wrap ga-2">
      <h1 class="text-h5">{{ $t('adminNodes.title') }}</h1>
      <v-spacer />
      <v-btn v-if="!forbidden" size="small" variant="text" color="warning" prepend-icon="mdi-pause-octagon-outline" data-test="held-after-restore" @click="askRestoreHold">{{ $t('adminNodes.held.afterRestore') }}</v-btn>
      <v-switch v-model="includeRevoked" :label="$t('servers.includeRevoked')" density="compact" hide-details color="primary" />
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('adminNodes.intro') }}</p>

    <v-alert v-if="forbidden" type="warning" variant="tonal" data-test="nodes-forbidden">{{ $t('adminNodes.forbidden') }}</v-alert>

    <!-- FR-20.72 (P3-4a): the orgs' addresses on the internet, and the requests to approve. -->
    <v-card v-if="!forbidden && addresses.length" variant="outlined" class="mb-4" data-test="nodes-addresses">
      <v-card-title class="text-subtitle-1">{{ $t('adminNodes.addresses.title') }}</v-card-title>
      <v-card-text>
        <div v-for="a in addresses" :key="a.id" class="d-flex align-center flex-wrap ga-2 py-1" :data-test="`address-${a.label}`">
          <code>{{ a.url }}</code>
          <v-chip size="x-small" variant="outlined">{{ a.org.slug ?? a.org.id }}</v-chip>
          <v-chip size="x-small" variant="tonal" :color="a.state === 'active' ? 'success' : a.state === 'requested' ? 'info' : undefined">{{ $t(`servers.address.state.${a.state}`) }}</v-chip>
          <v-spacer />
          <template v-if="a.state === 'requested'">
            <v-btn size="small" color="primary" variant="tonal" :loading="addressBusy === a.id" data-test="address-approve" @click="decide(a, 'approve')">{{ $t('adminNodes.addresses.approve') }}</v-btn>
            <v-btn size="small" variant="text" :loading="addressBusy === a.id" data-test="address-refuse" @click="refusing = { a, reason: '' }">{{ $t('adminNodes.addresses.refuse') }}</v-btn>
          </template>
          <v-btn v-else-if="a.state === 'active'" size="small" variant="text" color="warning" :loading="addressBusy === a.id" data-test="address-retire" @click="retiring = a">{{ $t('adminNodes.addresses.retire') }}</v-btn>
        </div>
      </v-card-text>
    </v-card>
    <v-dialog :model-value="!!refusing" max-width="520" @update:model-value="v => { if (!v) refusing = null }">
      <v-card v-if="refusing">
        <v-card-title class="text-wrap">{{ $t('adminNodes.addresses.refuseTitle', { url: refusing.a.url }) }}</v-card-title>
        <v-card-text><v-text-field v-model="refusing.reason" :label="$t('adminNodes.addresses.reason')" maxlength="300" autofocus /></v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="refusing = null">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="warning" variant="flat" :disabled="!refusing.reason.trim()" @click="decide(refusing.a, 'refuse', refusing.reason)">{{ $t('adminNodes.addresses.refuse') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-dialog :model-value="!!retiring" max-width="520" @update:model-value="v => { if (!v) retiring = null }">
      <v-card v-if="retiring">
        <v-card-text class="text-body-2 pt-5">{{ $t('adminNodes.addresses.confirmRetire', { url: retiring.url }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="retiring = null">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="warning" variant="flat" @click="retire(retiring)">{{ $t('adminNodes.addresses.retire') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- FR-20.3 (P3-8d): the orgs lgrai.app holds, and settling them. -->
    <v-card v-if="!forbidden && held.length" variant="outlined" color="warning" class="mb-4" data-test="nodes-held">
      <v-card-title class="text-subtitle-1">{{ $t('adminNodes.held.title', { n: held.length }) }}</v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-2">{{ $t('adminNodes.held.intro') }}</p>
        <div v-for="o in held" :key="o.orgId" class="d-flex align-center flex-wrap ga-2 py-1" :data-test="`held-${o.orgId}`">
          <v-chip size="small" variant="outlined">{{ o.slug ?? o.orgId }}</v-chip>
          <span class="text-body-2">{{ heldText(o) }}</span>
          <v-spacer />
          <v-btn v-if="o.claim" size="small" variant="tonal" color="warning" :loading="settling === o.orgId" data-test="held-adopt" @click="asking = { o, adopt: true }">{{ $t('adminNodes.held.adopt', { node: o.claim.nodeId, epoch: o.claim.epoch }) }}</v-btn>
          <v-btn size="small" variant="text" :loading="settling === o.orgId" data-test="held-release" @click="asking = { o, adopt: false }">{{ $t('adminNodes.held.release') }}</v-btn>
        </div>
      </v-card-text>
    </v-card>
    <v-dialog :model-value="!!asking" max-width="560" @update:model-value="v => { if (!v) asking = null }">
      <v-card v-if="asking" data-test="held-confirm">
        <v-card-text class="text-body-2 pt-5">{{ askingText }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="asking = null">{{ $t('common.cancel') }}</v-btn>
          <v-btn v-if="asking.restore" color="warning" variant="flat" data-test="held-confirm-go" @click="holdAll">{{ $t('adminNodes.held.afterRestore') }}</v-btn>
          <v-btn v-else color="warning" variant="flat" data-test="held-confirm-go" @click="settle(asking.o, asking.adopt)">{{ asking.adopt ? $t('adminNodes.held.adopt', { node: asking.o.claim?.nodeId, epoch: asking.o.claim?.epoch }) : $t('adminNodes.held.release') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-data-table v-if="!forbidden" :headers="headers" :items="items" :loading="loading" item-value="id" density="comfortable" :no-data-text="$t('adminNodes.none')">
      <template #item.name="{ item }">
        <div class="d-flex align-center ga-2">
          <span>{{ item.name }}</span>
          <v-chip v-if="item.cloneAlarm" size="x-small" color="error" variant="flat">{{ $t('servers.cloneAlarm') }}</v-chip>
          <v-chip v-if="item.ephemeral" size="x-small" variant="tonal" color="info">{{ $t('servers.ephemeral') }}</v-chip>
        </div>
        <div class="text-caption text-medium-emphasis"><code>{{ item.id }}</code></div>
      </template>
      <template #item.orgs="{ item }">
        <span v-for="o in item.orgs" :key="o.id" class="mr-1"><v-chip size="x-small" variant="outlined">{{ o.slug ?? o.id }}</v-chip></span>
      </template>
      <template #item.connected="{ item }"><ConnectedChips :connected="item.connected" /></template>
      <template #item.status="{ item }">
        <v-chip :color="item.status === 'active' ? 'success' : 'error'" size="small" variant="tonal">
          {{ item.status === 'active' ? $t('common.active') : $t('servers.revoked') }}
        </v-chip>
      </template>
      <template #item.health="{ item }">{{ healthText(item.health) }}</template>
      <template #item.backup="{ item }">{{ item.health?.lastBackupAt ? t('adminNodes.backupAgo', { age: duration((Date.now() - new Date(item.health.lastBackupAt).getTime()) / 1000) }) : '—' }}</template>
      <!-- FR-20.99/101 (P3-8): what needs a sys-admin's eye. -->
      <template #item.alarms="{ item }">
        <div class="d-flex flex-wrap ga-1" data-test="node-alarms">
          <v-chip v-for="a in item.alarms ?? []" :key="a.kind + (a.orgId ?? '')" size="x-small" color="warning" variant="tonal">{{ alarmText(a) }}</v-chip>
        </div>
      </template>
      <template #item.lastSeenAt="{ item }">{{ item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : '—' }}</template>
    </v-data-table>
  </v-container>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { VChip } from 'vuetify/components'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useNodeAlarms } from 'ui-shared/composables/useNodeAlarms'

/**
 * The sys-admin Nodes page (FR-20 plan step P2-3a): every master registered with global, across
 * every org. Read-only. Since P3-8 (FR-20.99, FR-20.101): its link, its last backup, its alarms.
 *
 * ⚠ Gated SERVER-SIDE by the backup allow-list (`BACKUP_SYS_ADMINS`). The nav entry is shown only
 * to an admitted caller, which secures nothing: the server answers 403 to everyone else, and the
 * page says so.
 */

const { t } = useI18n()
const { alarmText, duration } = useNodeAlarms()
const items = ref<any[]>([])
const loading = ref(false)
const forbidden = ref(false)
const includeRevoked = ref(false)
/** FR-20.72 (P3-4a): the orgs' addresses and requests. */
const addresses = ref<any[]>([])
const addressBusy = ref<string | null>(null)
const refusing = ref<{ a: any; reason: string } | null>(null)
const retiring = ref<any | null>(null)
async function decide(a: any, decision: 'approve' | 'refuse', reason?: string) {
  refusing.value = null
  addressBusy.value = a.id
  try {
    await httpClient.post(`/admin/addresses/${a.id}/${decision}`, decision === 'refuse' ? { reason } : {})
    await load()
  } finally {
    addressBusy.value = null
  }
}
async function retire(a: any) {
  retiring.value = null
  addressBusy.value = a.id
  try {
    await httpClient.post(`/admin/addresses/${a.id}/retire`)
    await load()
  } finally {
    addressBusy.value = null
  }
}
/** FR-20.3 (P3-8d): orgs on hold, and the one being settled. */
const held = ref<any[]>([])
const settling = ref<string | null>(null)
const asking = ref<{ o: any; adopt: boolean; restore?: number } | null>(null)
const askingText = computed(() => {
  const a = asking.value
  if (!a) return ''
  if (a.restore !== undefined) return t('adminNodes.held.confirmAfterRestore', { n: a.restore })
  const org = a.o.slug ?? a.o.orgId
  return a.adopt ? t('adminNodes.held.confirmAdopt', { org, node: a.o.claim?.nodeId, epoch: a.o.claim?.epoch }) : t('adminNodes.held.confirmRelease', { org })
})

const headers = computed(() => [
  { title: t('servers.name'), key: 'name' },
  { title: t('adminNodes.orgs'), key: 'orgs', sortable: false },
  { title: t('servers.connected'), key: 'connected', sortable: false },
  { title: t('servers.status'), key: 'status' },
  { title: t('servers.health'), key: 'health', sortable: false },
  { title: t('adminNodes.link'), key: 'linkLevel' },
  { title: t('adminNodes.backup'), key: 'backup', sortable: false },
  { title: t('adminNodes.alarms'), key: 'alarms', sortable: false },
  { title: t('servers.lastSeen'), key: 'lastSeenAt' },
])

/** Both channels as two small chips: live, or not. */
const ConnectedChips = defineComponent({
  props: { connected: { type: Object, default: null } },
  setup(props) {
    return () => h('div', { class: 'd-flex ga-1' }, (['interactive', 'bulk'] as const).map(ch =>
      h(VChip, { size: 'x-small', variant: 'tonal', color: (props.connected as any)?.[ch] ? 'success' : undefined }, () => `${ch === 'interactive' ? 'I' : 'B'} ${(props.connected as any)?.[ch] ? t('servers.live') : '—'}`),
    ))
  },
})

function healthText(health: any): string {
  if (!health) return '—'
  const parts = [health.appVersion ? `v${health.appVersion}` : null]
  if (typeof health.diskFreeBytes === 'number') parts.push(t('servers.diskFree', { gb: (health.diskFreeBytes / 2 ** 30).toFixed(1) }))
  if (health.apiOk === false) parts.push(t('servers.apiDown'))
  // FR-20.20: an update that waits, and why; the alarm after seven nights kept out.
  const u = health.update
  if (u?.state === 'installing') parts.push(t('servers.updateInstalling', { version: u.available }))
  if (u?.state === 'deferred') {
    parts.push(t('servers.updateWaits', { version: u.available, reason: u.reason ?? '' }))
    if (u.alarm) parts.push(t('servers.updateAlarm', { n: u.blockedWindows ?? 0 }))
  }
  // #373: replaced libraries the night restart waits to load, kept out by open tills.
  if (health.nightRestart?.alarm) parts.push(t('servers.restartAlarm', { n: health.nightRestart.blockedNights ?? 0 }))
  return parts.filter(Boolean).join(' · ') || '—'
}

function heldText(o: any): string {
  const home = o.home === 'global' ? 'lgrai.app' : o.home
  const why = t(`adminNodes.held.reason.${o.reason}`, { node: o.claim?.nodeId ?? '', epoch: o.claim?.epoch ?? '' })
  return `${why} · ${t('adminNodes.held.record', { home, epoch: o.epoch })}`
}

/** The runbook's step after a disaster-recovery restore: how many it would hold, then hold them. */
async function askRestoreHold() {
  const { data } = await httpClient.get('/admin/nodes/held/after-restore')
  asking.value = { o: null, adopt: false, restore: Number(data.held ?? 0) }
}
async function holdAll() {
  asking.value = null
  await httpClient.post('/admin/nodes/held/after-restore')
  await load()
}

/** Release (lgrai.app's record stands) or adopt the server's newer record, once asked. */
async function settle(o: any, adopt: boolean) {
  asking.value = null
  settling.value = o.orgId
  try {
    await httpClient.post(`/admin/nodes/held/${o.orgId}/release`, { adopt })
    await load()
  } finally {
    settling.value = null
  }
}

async function load() {
  loading.value = true
  try {
    const { data } = await httpClient.get('/admin/nodes', { params: includeRevoked.value ? { includeRevoked: 'true' } : {} })
    items.value = data.nodes ?? []
    held.value = (await httpClient.get('/admin/nodes/held')).data.held ?? []
    addresses.value = (await httpClient.get('/admin/addresses')).data.addresses ?? []
  } catch (e: any) {
    if (e?.response?.status === 403 || e?.response?.status === 404) forbidden.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(includeRevoked, load)
</script>
