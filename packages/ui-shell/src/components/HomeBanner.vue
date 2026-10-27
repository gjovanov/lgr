<template>
  <v-alert
    v-if="text && !(dismissed && kind === 'info')"
    :type="kind"
    variant="tonal"
    density="compact"
    rounded="0"
    class="home-banner"
    :closable="kind === 'info'"
    data-test="home-banner"
    @click:close="dismissed = true"
  >
    <div class="text-body-2">{{ text }}</div>
  </v-alert>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient, setRefusalTranslator } from 'ui-shared/composables/useHttpClient'

/**
 * FR-20.75 (plan step P3-5) — where the org lives, above every page of every app, when it is not
 * written here:
 * - on lgrai.app, for an org homed on one of its servers: a read-only copy, as of its last change,
 *   with the server online or offline since when;
 * - on a master, for an org that went back to lgrai.app: the read-only copy this server keeps;
 * - anywhere, while a move freezes the org.
 * Nothing shows for an org written here. And a write the server refuses for that reason is said in
 * words (`setRefusalTranslator`), not as the server's English.
 */

const props = defineProps<{ orgId?: string | null }>()
const { t, locale } = useI18n()

interface HomeStatus {
  home: 'here' | 'master' | 'global'
  moving: boolean
  server?: { id: string; name: string }
  online?: boolean
  since?: string | null
  asOf?: string | null
}

const status = ref<HomeStatus | null>(null)
const dismissed = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function load(orgId?: string | null) {
  if (!orgId) {
    status.value = null
    return
  }
  try {
    status.value = (await httpClient.get(`/org/${orgId}/home`)).data
  } catch {
    // Kept as it was: a banner never blinks away on one failed look.
  }
}

watch(() => props.orgId, id => {
  status.value = null
  dismissed.value = false
  if (timer) clearInterval(timer)
  timer = null
  void load(id)
  // Every two minutes: a server going offline, or coming back, shows without a reload.
  if (id) timer = setInterval(() => void load(id), 120_000)
}, { immediate: true })

setRefusalTranslator(code => (code === 'org_home_elsewhere' ? t('home.writeRefused') : null))
onUnmounted(() => {
  if (timer) clearInterval(timer)
  setRefusalTranslator(null)
})

const when = (v?: string | null) => (v ? new Date(v).toLocaleString(locale.value) : t('home.unknown'))

const kind = computed(() => (status.value?.moving || (status.value?.home === 'master' && !status.value.online) ? 'warning' : 'info'))

const text = computed(() => {
  const s = status.value
  if (!s) return ''
  if (s.moving) return t('home.moving')
  if (s.home === 'master') {
    const name = s.server?.name ?? ''
    return s.online ? t('home.writtenOnServer', { name, asOf: when(s.asOf) }) : t('home.serverOffline', { name, since: when(s.since), asOf: when(s.asOf) })
  }
  if (s.home === 'global') return t('home.livesOnCloud')
  return ''
})
</script>

<style scoped>
.home-banner {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
