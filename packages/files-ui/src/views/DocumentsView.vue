<template>
  <v-container>
    <div class="mb-4 d-flex align-center">
      <div>
        <h1 class="text-h5 mb-1">{{ $t('files.documents.title') }}</h1>
        <p class="text-body-2 text-grey mb-0">{{ $t('files.documents.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn-toggle v-model="viewMode" density="compact" variant="outlined" mandatory @update:model-value="onViewChange">
        <v-btn value="flat" size="small" prepend-icon="mdi-table">{{ $t('files.batch.viewFlat') }}</v-btn>
        <v-btn value="date" size="small" prepend-icon="mdi-calendar-month">{{ $t('files.batch.viewByDate') }}</v-btn>
      </v-btn-toggle>
    </div>

    <v-card variant="outlined" class="mb-3">
      <v-card-text class="d-flex flex-wrap ga-3 align-center">
        <v-text-field v-model="search" :label="$t('common.search')" prepend-inner-icon="mdi-magnify" density="compact" variant="outlined" hide-details clearable style="max-width: 220px" @update:model-value="reloadAll" />
        <v-select v-model="docType" :items="typeItems" :label="$t('files.col.type')" density="compact" variant="outlined" hide-details clearable style="max-width: 190px" @update:model-value="reloadAll" />
        <v-select v-model="statusFilter" :items="statusItems" :label="$t('files.col.status')" density="compact" variant="outlined" hide-details clearable style="max-width: 160px" @update:model-value="reloadAll" />
        <v-text-field v-if="viewMode === 'flat'" v-model="docDate" :label="$t('files.col.date')" placeholder="YYYY-MM-DD" density="compact" variant="outlined" hide-details clearable style="max-width: 150px" @update:model-value="reload" />
        <v-spacer />
        <v-btn variant="text" icon="mdi-refresh" @click="reloadAll" />
      </v-card-text>
    </v-card>

    <!-- Batch action bar -->
    <v-slide-y-transition>
      <v-card v-if="selected.size" variant="flat" color="primary" class="mb-3">
        <v-card-text class="d-flex flex-wrap align-center ga-3 py-2">
          <span class="font-weight-medium">{{ $t('files.batch.selected', { n: selected.size }) }}</span>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-magnify-scan" @click="analyzeSelected">{{ $t('files.batch.analyze') }}</v-btn>
          <v-checkbox v-model="options.force" :label="$t('files.batch.force')" density="compact" hide-details color="white" />
          <v-spacer />
          <v-btn size="small" variant="text" @click="clearSelection">{{ $t('files.batch.clear') }}</v-btn>
        </v-card-text>
        <v-progress-linear v-if="busy" :model-value="progress" color="white" height="4" />
      </v-card>
    </v-slide-y-transition>

    <!-- FLAT view -->
    <v-data-table-server
      v-if="viewMode === 'flat'"
      :headers="headers"
      :items="items"
      :items-length="total"
      :loading="loading"
      :items-per-page="size"
      :page="page + 1"
      density="compact"
      @update:options="onOptions"
    >
      <template #item.select="{ item }">
        <v-checkbox-btn :model-value="selected.has(item.docFileId)" density="compact" @update:model-value="toggle(item.docFileId)" />
      </template>
      <template #item.docType="{ item }"><v-chip size="x-small" label>{{ item.docType }}</v-chip></template>
      <template #item.status="{ item }"><v-chip size="x-small" :color="statusColor(item.status)" label>{{ item.status }}</v-chip></template>
      <template #item.version="{ item }">
        <v-btn v-if="item.version > 1" size="x-small" variant="tonal" @click="openVersions(item)">v{{ item.version }} · {{ $t('files.versions') }}</v-btn>
        <span v-else>v1</span>
      </template>
      <template #item.actions="{ item }">
        <v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(item)" target="_blank" />
      </template>
    </v-data-table-server>

    <!-- BY-DATE view -->
    <div v-else>
      <v-progress-linear v-if="datesLoading" indeterminate color="primary" class="mb-2" />
      <v-expansion-panels v-model="expanded" multiple variant="accordion">
        <v-expansion-panel v-for="d in dates" :key="d.docDate" :value="d.docDate" @group:selected="onExpand(d.docDate, $event)">
          <v-expansion-panel-title>
            <div class="d-flex align-center ga-3 flex-grow-1">
              <v-checkbox-btn :model-value="dateAllSelected(d.docDate)" :indeterminate="dateSomeSelected(d.docDate)" density="compact" @click.stop="toggleDate(d.docDate)" />
              <span class="font-weight-medium">{{ d.docDate }}</span>
              <v-chip size="x-small" label>{{ d.total }}</v-chip>
              <v-spacer />
              <v-chip v-if="d.uploaded" size="x-small" color="grey" label>{{ d.uploaded }} {{ $t('files.status.uploaded') }}</v-chip>
              <v-chip v-if="d.analyzed" size="x-small" color="warning" label>{{ d.analyzed }} {{ $t('files.status.analyzed') }}</v-chip>
              <v-chip v-if="d.committed" size="x-small" color="success" label>{{ d.committed }} {{ $t('files.status.committed') }}</v-chip>
            </div>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-progress-linear v-if="!dateDocs[d.docDate]" indeterminate color="primary" />
            <v-table v-else density="compact">
              <thead><tr>
                <th style="width:40px"></th><th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th>
                <th>{{ $t('files.col.status') }}</th><th>{{ $t('files.col.version') }}</th><th></th>
              </tr></thead>
              <tbody>
                <tr v-for="doc in dateDocs[d.docDate]" :key="doc.docFileId">
                  <td><v-checkbox-btn :model-value="selected.has(doc.docFileId)" density="compact" @update:model-value="toggle(doc.docFileId)" /></td>
                  <td><v-chip size="x-small" label>{{ doc.docType }}</v-chip></td>
                  <td class="text-caption">{{ doc.docNumber }}</td>
                  <td><v-chip size="x-small" :color="statusColor(doc.status)" label>{{ doc.status }}</v-chip></td>
                  <td>v{{ doc.version }}</td>
                  <td><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(doc)" target="_blank" /></td>
                </tr>
              </tbody>
            </v-table>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <p v-if="!datesLoading && !dates.length" class="text-body-2 text-grey text-center py-6">{{ $t('files.batch.noDocs') }}</p>
    </div>

    <!-- Review & Commit dialog -->
    <v-dialog v-model="reviewOpen" max-width="1100" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center">
          <span class="text-subtitle-1">{{ $t('files.review.title') }}</span>
          <v-spacer />
          <div class="d-flex ga-2">
            <v-chip size="small" color="success" label>{{ $t('files.review.ok') }}: {{ reviewCounts.ok }}</v-chip>
            <v-chip v-if="reviewCounts.warn" size="small" color="warning" label>{{ $t('files.review.withWarnings') }}: {{ reviewCounts.warn }}</v-chip>
            <v-chip v-if="reviewCounts.dup" size="small" color="orange" label>{{ $t('files.review.duplicate') }}: {{ reviewCounts.dup }}</v-chip>
            <v-chip v-if="reviewCounts.err" size="small" color="error" label>{{ $t('files.review.failed') }}: {{ reviewCounts.err }}</v-chip>
          </div>
        </v-card-title>
        <v-card-text style="max-height:60vh">
          <v-table density="compact">
            <thead><tr>
              <th style="width:40px">
                <v-checkbox-btn :model-value="allReviewSelected" :indeterminate="someReviewSelected" density="compact" @update:model-value="toggleAllReview" />
              </th>
              <th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th><th>{{ $t('files.col.kind') }}</th>
              <th class="text-center">{{ $t('files.col.matched') }}</th><th>{{ $t('files.review.warnings') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="r in analyzeResults" :key="r.docFileId" :class="r.error ? 'bg-red-lighten-5' : ''">
                <td>
                  <v-checkbox-btn :model-value="commitSel.has(r.docFileId)" :disabled="!r.committable" density="compact" @update:model-value="toggleCommit(r.docFileId)" />
                </td>
                <td><v-chip size="x-small" label>{{ r.docType }}</v-chip></td>
                <td class="text-caption">{{ r.docNumber }}<span v-if="r.reused" class="text-grey"> · {{ $t('files.review.reused') }}</span></td>
                <td class="text-caption">{{ r.docKind }}<span v-if="r.direction" class="text-grey"> / {{ r.direction }}</span></td>
                <td class="text-center">
                  <span :class="r.unmatched ? 'text-error font-weight-medium' : 'text-success'">{{ r.matched }}/{{ r.total }}</span>
                </td>
                <td class="text-caption">
                  <div v-if="r.error" class="text-error">{{ r.error }}</div>
                  <v-chip v-if="r.duplicate" size="x-small" color="orange" label class="mr-1 mb-1">{{ $t('files.review.duplicate') }}</v-chip>
                  <div v-for="(w, i) in r.warnings" :key="i" class="text-warning">⚠ {{ w }}</div>
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
        <v-divider />
        <v-card-actions class="flex-wrap ga-2 px-4">
          <v-checkbox v-model="options.adjustStock" :label="$t('files.batch.adjustStock')" density="compact" hide-details />
          <v-checkbox v-model="options.allowDuplicate" :label="$t('files.batch.allowDuplicate')" density="compact" hide-details />
          <v-spacer />
          <v-btn variant="text" @click="reviewOpen = false">{{ $t('common.close') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!commitSel.size" prepend-icon="mdi-database-check" @click="commitReviewed">
            {{ $t('files.review.commitSelected', { n: commitSel.size }) }}
          </v-btn>
        </v-card-actions>
        <v-progress-linear v-if="busy" :model-value="progress" color="primary" height="4" />
      </v-card>
    </v-dialog>

    <!-- Versions dialog -->
    <v-dialog v-model="versionsOpen" max-width="640">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ $t('files.versions') }} — {{ activeDoc?.originalName }}</v-card-title>
        <v-list density="compact">
          <v-list-item v-if="versionData?.current" :title="`v${versionData.current.version} · ${versionData.current.name}`" :subtitle="$t('files.currentVersion')">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(activeDoc)" target="_blank" /></template>
          </v-list-item>
          <v-divider />
          <v-list-item v-for="v in versionData?.versions || []" :key="v.name" :title="v.name" :subtitle="new Date(v.archivedAt).toLocaleString()">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" :href="downloadUrl(activeDoc, v.name)" target="_blank" /></template>
          </v-list-item>
          <v-list-item v-if="!(versionData?.versions || []).length" :title="$t('files.noVersions')" />
        </v-list>
        <v-card-actions><v-spacer /><v-btn variant="text" @click="versionsOpen = false">{{ $t('common.close') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const viewMode = ref<'flat' | 'date'>('flat')
const items = ref<any[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(0)
const size = ref(25)
const search = ref('')
const docType = ref<string | null>(null)
const docDate = ref('')
const statusFilter = ref<string | null>(null)

const selected = reactive(new Set<string>())
const busy = ref(false)
const progress = ref(0)
const options = reactive({ force: false, adjustStock: true, allowDuplicate: false })

const typeItems = ['invoice', 'cash_register', 'goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations', 'store_availability', 'unknown']
const statusItems = ['uploaded', 'analyzed', 'committed', 'superseded']
const headers = [
  { title: '', key: 'select', sortable: false, width: 40 },
  { title: t('files.col.type'), key: 'docType' },
  { title: t('files.col.number'), key: 'docNumber' },
  { title: t('files.col.date'), key: 'docDate' },
  { title: t('files.col.status'), key: 'status' },
  { title: t('files.col.version'), key: 'version', sortable: false },
  { title: '', key: 'actions', sortable: false },
]

function statusColor(s: string) {
  return { uploaded: 'grey', extracted: 'info', analyzed: 'warning', committed: 'success', superseded: 'error' }[s] || 'grey'
}
function base() {
  const dev = window.location.hostname === 'localhost' ? 'http://localhost:4001/api' : '/api'
  return `${dev}${appStore.orgUrl()}/files`
}
function downloadUrl(item: any, version?: string) {
  const v = version ? `?version=${encodeURIComponent(version)}` : ''
  return `${base()}/${item.docFileId || item._id}/download${v}`
}
const filterParams = () => ({ search: search.value || undefined, docType: docType.value || undefined, status: statusFilter.value || undefined })

function toggle(id: string) { selected.has(id) ? selected.delete(id) : selected.add(id) }
function clearSelection() { selected.clear() }

// ── flat ──
async function reload() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, {
      params: { page: page.value, size: size.value, ...filterParams(), docDate: docDate.value || undefined },
    })
    items.value = (data.docFiles || []).map((d: any) => ({ ...d, docFileId: d._id }))
    total.value = data.total || 0
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } finally { loading.value = false }
}
function onOptions(opts: any) { page.value = (opts.page || 1) - 1; size.value = opts.itemsPerPage || 25; reload() }

// ── by date ──
const dates = ref<any[]>([])
const datesLoading = ref(false)
const expanded = ref<string[]>([])
const dateDocs = reactive<Record<string, any[]>>({})
async function loadDates() {
  datesLoading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files/dates`, { params: filterParams() })
    dates.value = data.dates || []
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } finally { datesLoading.value = false }
}
async function loadDateDocs(date: string) {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, { params: { docDate: date, size: 500, ...filterParams() } })
    dateDocs[date] = (data.docFiles || []).map((d: any) => ({ ...d, docFileId: d._id }))
  } catch { dateDocs[date] = [] }
}
function onExpand(date: string, isOpen: boolean) { if (isOpen && !dateDocs[date]) loadDateDocs(date) }
function dateAllSelected(date: string) { const d = dateDocs[date]; return !!d?.length && d.every((x) => selected.has(x.docFileId)) }
function dateSomeSelected(date: string) { const d = dateDocs[date]; return !!d?.some((x) => selected.has(x.docFileId)) && !dateAllSelected(date) }
async function toggleDate(date: string) {
  if (!dateDocs[date]) await loadDateDocs(date)
  const d = dateDocs[date] || []
  const all = dateAllSelected(date)
  d.forEach((x) => (all ? selected.delete(x.docFileId) : selected.add(x.docFileId)))
}

function onViewChange() { reloadAll() }
function reloadAll() { selectedResetDocsCache(); viewMode.value === 'date' ? loadDates() : reload() }
function selectedResetDocsCache() { for (const k of Object.keys(dateDocs)) delete dateDocs[k] }

// ── background job poller ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function runJob(url: string, body: any): Promise<any> {
  progress.value = 0
  const { data: started } = await httpClient.post(url, body)
  const taskId = started.taskId
  if (!taskId) return started
  for (let i = 0; i < 300; i++) {
    await sleep(2000)
    const { data: task } = await httpClient.get(`${appStore.orgUrl()}/files/task/${taskId}`)
    if (typeof task.progress === 'number') progress.value = task.progress
    if (task.status === 'completed') return task.result
    if (task.status === 'failed') throw new Error(task.error || t('common.operationFailed'))
  }
  throw new Error(t('common.operationFailed'))
}

// ── analyze → review → commit ──
const reviewOpen = ref(false)
const analyzeResults = ref<any[]>([])
const commitSel = reactive(new Set<string>())
const reviewCounts = computed(() => ({
  ok: analyzeResults.value.filter((r) => r.committable && !r.error).length,
  warn: analyzeResults.value.filter((r) => (r.warnings?.length || 0) > 0 || r.unmatched > 0).length,
  dup: analyzeResults.value.filter((r) => r.duplicate).length,
  err: analyzeResults.value.filter((r) => r.error).length,
}))
const allReviewSelected = computed(() => { const c = analyzeResults.value.filter((r) => r.committable); return !!c.length && c.every((r) => commitSel.has(r.docFileId)) })
const someReviewSelected = computed(() => commitSel.size > 0 && !allReviewSelected.value)
function toggleCommit(id: string) { commitSel.has(id) ? commitSel.delete(id) : commitSel.add(id) }
function toggleAllReview() {
  const c = analyzeResults.value.filter((r) => r.committable)
  const all = c.every((r) => commitSel.has(r.docFileId))
  commitSel.clear(); if (!all) c.forEach((r) => commitSel.add(r.docFileId))
}

async function analyzeSelected() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/analyze-batch`, { docFileIds: [...selected], force: options.force })
    analyzeResults.value = res.results || []
    // Pre-select the recommended (clean, fully matched, not duplicate) docs for commit.
    commitSel.clear()
    analyzeResults.value.forEach((r) => { if (r.recommended) commitSel.add(r.docFileId) })
    reviewOpen.value = true
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

async function commitReviewed() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/commit-batch`, {
      docFileIds: [...commitSel], adjustStock: options.adjustStock, allowDuplicate: options.allowDuplicate,
    })
    const results = res.results || []
    const ok = results.filter((r: any) => r.ok).length
    const failed = results.filter((r: any) => !r.ok)
    if (failed.length) showError(t('files.review.commitPartial', { ok, fail: failed.length }))
    else showSuccess(t('files.review.commitDone', { n: ok }))
    reviewOpen.value = false
    clearSelection()
    reloadAll()
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

// ── versions ──
const versionsOpen = ref(false)
const activeDoc = ref<any>(null)
const versionData = ref<any>(null)
async function openVersions(item: any) {
  activeDoc.value = item; versionsOpen.value = true; versionData.value = null
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/files/${item._id}/versions`); versionData.value = data } catch { /* ignore */ }
}

onMounted(async () => {
  if (!appStore.currentOrg?.id) await appStore.fetchProfile()
  reload()
})
</script>
