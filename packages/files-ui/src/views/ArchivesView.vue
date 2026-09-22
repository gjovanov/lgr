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
        <!--
          ⚠ Mirrors the Backups table (portal-ui/views/admin/BackupView.vue) deliberately, and
          for a sharper version of the same reason: NOTHING off-site must never render as a
          neutral dash.

          A packed unit has had its loose files DELETED (FR-13.40) — that is what packing is.
          So an archive that reached no destination is the ONLY copy of that fiscal year's
          documents, sitting on the same 5 Gi volume as the live database, against a ten-year
          legal retention (ЗСч чл. 12). That is the single most important thing this table can
          tell an operator, and it is the one state with no row of its own to render.

          Chips carry the destination NAME, not the status: "which copies exist" is the
          question, and `reached` on its own does not answer it when there are two tiers.
        -->
        <template #item.offsite="{ item }">
          <v-chip v-for="d in reached(item)" :key="d.name" color="success" size="x-small" label class="mr-1"
                  :title="d.verified ? $t('files.archives.offsiteVerified') : undefined">
            {{ d.name }}
            <!-- Read back from the destination and re-hashed, rather than assumed from a 200. -->
            <v-icon v-if="d.verified" end size="x-small" icon="mdi-shield-check" />
          </v-chip>

          <!-- A failed or expired-credential push is actionable, so it keeps its reason. -->
          <v-chip v-for="d in problems(item)" :key="d.name" color="error" size="x-small" label class="mr-1"
                  :title="d.reason || undefined">
            {{ d.name }}
          </v-chip>

          <!--
            Shown whenever a packed unit reached nothing — including alongside a red chip. The
            red one says what went wrong; this one says what it COSTS, which is the part an
            operator scanning the column needs and the part no per-destination row can carry.
          -->
          <v-chip v-if="isPacked(item) && !reached(item).length" color="warning" size="x-small" label>
            {{ $t('files.archives.noOffsite') }}
          </v-chip>
          <!-- Still building: absent is genuinely "not yet", not "nowhere". -->
          <span v-else-if="!reached(item).length && !problems(item).length" class="text-grey text-caption">—</span>
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

/**
 * Off-site copies of one archive unit.
 *
 * ⚠ `reached` is the only status that means the bytes are elsewhere. The backup runner records
 * attempts as well as successes (`destinations[]` carries both), so filtering on it — rather
 * than on the array being non-empty — is what stops a row of failures reading as coverage.
 */
const reached = (u: any) => (u?.destinations || []).filter((d: any) => d.status === 'reached')

/**
 * ⚠ `skipped` is NOT a problem and must not render as one. The destination service reports
 * four statuses — `reached | failed | skipped | reconsent_required` — and `skipped` means the
 * tier was never configured (no refresh token, `BACKUP_S3_SCOPE=off`). Painting it red says
 * "S3 is broken" about a deployment that simply does not use S3.
 *
 * It still counts as no copy, so it does not suppress the warning below; it just does not
 * accuse anyone. `reconsent_required` DOES belong here — it is the dead-token state that never
 * fixes itself on a retry and needs a human.
 */
const problems = (u: any) =>
  (u?.destinations || []).filter((d: any) => d.status === 'failed' || d.status === 'reconsent_required')

/**
 * ⚠ `packed` is the state where the loose files are gone (FR-13.40); `verified` has proven the
 * bytes can be reproduced but has not deleted anything yet. Both are units that SHOULD have an
 * off-site copy, so both warn when they have none — while a `building` or `failed` unit is not
 * yet making any claim about where its bytes live, and an empty list there means "not yet".
 */
const isPacked = (u: any) => u?.status === 'packed' || u?.status === 'verified'

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
