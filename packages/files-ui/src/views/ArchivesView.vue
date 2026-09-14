<template>
  <v-container>
    <HubPageHeader
      :title="$t('files.archives.title')"
      :subtitle="$t('files.archives.subtitle')"
      :back-label="$t('files.backToHub')"
    >
      <template #actions>
        <v-btn variant="text" icon="mdi-refresh" :loading="loading" @click="reload" />
      </template>
    </HubPageHeader>

    <!--
      The documents are still listed, searchable and downloadable while archived — this screen
      is an index of where their bytes are, not a gate in front of them. Приложение 29 т. 16
      requires exactly that, and it is easy to read the table as "these are gone" otherwise.
    -->
    <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
      {{ $t('files.archives.explainer') }}
    </v-alert>

    <v-card variant="outlined" class="mb-4">
      <v-card-title class="text-subtitle-1">{{ $t('files.archives.units') }}</v-card-title>
      <v-data-table
        :headers="unitHeaders"
        :items="units"
        :loading="loading"
        density="compact"
        item-value="_id"
        :no-data-text="$t('files.archives.none')"
      >
        <template #item.status="{ item }">
          <v-chip size="x-small" :color="statusColor(item.status)" label>{{ item.status }}</v-chip>
        </template>
        <template #item.coverage="{ item }">{{ item.coversFrom }} → {{ item.coversTo }}</template>
        <template #item.size="{ item }">
          {{ mb(item.bytes) }}
          <span class="text-grey text-caption"> ({{ ratio(item) }})</span>
        </template>
        <template #item.offsite="{ item }">
          <v-chip v-for="(d, i) in (item.destinations || [])" :key="i" size="x-small" class="mr-1"
                  :color="d.status === 'reached' ? 'success' : 'warning'" label>
            {{ d.status }}
          </v-chip>
          <span v-if="!(item.destinations || []).length" class="text-grey text-caption">—</span>
        </template>
        <template #item.sha256="{ item }">
          <code class="text-caption">{{ (item.sha256 || '').slice(0, 12) }}</code>
        </template>
        <template #item.actions="{ item }">
          <v-btn v-if="canWrite" size="x-small" variant="text" :loading="busy === item._id"
                 @click="unarchive(item)">
            {{ $t('files.archives.unarchive') }}
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Packing is an administrator action; an auditor sees the index and not this card. -->
    <v-card v-if="canWrite" variant="outlined">
      <v-card-title class="text-subtitle-1">{{ $t('files.archives.candidates') }}</v-card-title>
      <v-card-text class="pt-0">
        <p class="text-body-2 text-grey mb-3">{{ $t('files.archives.candidatesHint') }}</p>
        <v-data-table
          :headers="candidateHeaders"
          :items="candidates"
          :loading="loading"
          density="compact"
          item-value="fiscalYearId"
          :no-data-text="$t('files.archives.noCandidates')"
        >
          <template #item.coverage="{ item }">{{ item.coversFrom }} → {{ item.coversTo }}</template>
          <template #item.contentBytes="{ item }">{{ mb(item.contentBytes) }}</template>
          <template #item.actions="{ item }">
            <v-btn v-if="!item.archived" size="x-small" color="primary" variant="tonal"
                   :loading="busy === item.fiscalYearId" @click="pack(item)">
              {{ $t('files.archives.pack') }}
            </v-btn>
            <v-chip v-else size="x-small" label>{{ $t('files.archives.alreadyArchived') }}</v-chip>
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import HubPageHeader from 'ui-shell/components/HubPageHeader'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const units = ref<any[]>([])
const candidates = ref<any[]>([])
const loading = ref(false)
const busy = ref<string | null>(null)

/**
 * An `nra_auditor` reads this screen and cannot write to it (Приложение 29 т. 19 requires the
 * reading half; т. 16 requires the data to stay reachable at all).
 *
 * ⚠ Cosmetic only. The server's `readGate`/`gate` pair is the actual control — hiding a
 * button hides nothing from anyone who can open a devtools console.
 */
const canWrite = computed(() => appStore.user?.role !== 'nra_auditor')

const unitHeaders = computed(() => [
  { title: t('files.archives.year'), key: 'fiscalYearName' },
  { title: t('files.archives.coverage'), key: 'coverage', sortable: false },
  { title: t('files.archives.files'), key: 'fileCount' },
  { title: t('files.archives.size'), key: 'size', sortable: false },
  { title: t('files.archives.offsite'), key: 'offsite', sortable: false },
  { title: t('files.archives.checksum'), key: 'sha256', sortable: false },
  { title: t('files.col.status'), key: 'status' },
  { title: '', key: 'actions', sortable: false },
])

const candidateHeaders = computed(() => [
  { title: t('files.archives.year'), key: 'name' },
  { title: t('files.archives.coverage'), key: 'coverage', sortable: false },
  { title: t('files.archives.files'), key: 'fileCount' },
  { title: t('files.archives.size'), key: 'contentBytes', sortable: false },
  { title: '', key: 'actions', sortable: false },
])

function statusColor(s: string) {
  return ({ packed: 'success', verified: 'info', building: 'grey', failed: 'error' } as any)[s] || 'grey'
}
function mb(n: number) {
  if (!n) return '—'
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
}
/** Compression is modest here and saying so beats implying otherwise: PDFs are already deflate. */
function ratio(u: any) {
  if (!u.contentBytes || !u.bytes) return '—'
  return `${(u.contentBytes / u.bytes).toFixed(2)}×`
}

async function reload() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files/archives`)
    units.value = data.units || []
    if (canWrite.value) {
      const res = await httpClient.get(`${appStore.orgUrl()}/files/archives/candidates`)
      candidates.value = res.data.years || []
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

async function pack(item: any) {
  busy.value = item.fiscalYearId
  try {
    // Dispatches a BackgroundTask — a year is hundreds of MB read, hashed, compressed and
    // read back to verify, which outlives an ingress timeout at the projected volumes.
    await httpClient.post(`${appStore.orgUrl()}/files/archives/${item.fiscalYearId}`)
    showSuccess(t('files.archives.packStarted'))
    setTimeout(reload, 2000)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { busy.value = null }
}

async function unarchive(item: any) {
  busy.value = item._id
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/archives/${item._id}/unarchive`)
    showSuccess(t('files.archives.unarchived', { n: data.restored }))
    await reload()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { busy.value = null }
}

onMounted(reload)
</script>
