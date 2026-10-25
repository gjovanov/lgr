<template>
  <v-container>
    <div class="d-flex align-center mb-2 flex-wrap ga-2">
      <h1 class="text-h5">{{ $t('adminNodes.title') }}</h1>
      <v-spacer />
      <v-switch v-model="includeRevoked" :label="$t('servers.includeRevoked')" density="compact" hide-details color="primary" />
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('adminNodes.intro') }}</p>

    <v-alert v-if="forbidden" type="warning" variant="tonal" data-test="nodes-forbidden">{{ $t('adminNodes.forbidden') }}</v-alert>

    <v-data-table v-else :headers="headers" :items="items" :loading="loading" item-value="id" density="comfortable" :no-data-text="$t('adminNodes.none')">
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
      <template #item.lastSeenAt="{ item }">{{ item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : '—' }}</template>
    </v-data-table>
  </v-container>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { VChip } from 'vuetify/components'
import { httpClient } from 'ui-shared/composables/useHttpClient'

/**
 * The sys-admin Nodes page (FR-20 plan step P2-3a): every master registered with global, across
 * every org. Read-only.
 *
 * ⚠ Gated SERVER-SIDE by the backup allow-list (`BACKUP_SYS_ADMINS`). The nav entry is shown only
 * to an admitted caller, which secures nothing: the server answers 403 to everyone else, and the
 * page says so.
 */

const { t } = useI18n()
const items = ref<any[]>([])
const loading = ref(false)
const forbidden = ref(false)
const includeRevoked = ref(false)

const headers = computed(() => [
  { title: t('servers.name'), key: 'name' },
  { title: t('adminNodes.orgs'), key: 'orgs', sortable: false },
  { title: t('servers.connected'), key: 'connected', sortable: false },
  { title: t('servers.status'), key: 'status' },
  { title: t('servers.health'), key: 'health', sortable: false },
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
  return parts.filter(Boolean).join(' · ') || '—'
}

async function load() {
  loading.value = true
  try {
    const { data } = await httpClient.get('/admin/nodes', { params: includeRevoked.value ? { includeRevoked: 'true' } : {} })
    items.value = data.nodes ?? []
  } catch (e: any) {
    if (e?.response?.status === 403 || e?.response?.status === 404) forbidden.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(includeRevoked, load)
</script>
