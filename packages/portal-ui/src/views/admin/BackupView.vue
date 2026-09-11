<template>
  <v-container fluid>
    <h1 class="text-h4 mb-1">{{ $t('backup.title') }}</h1>
    <div class="text-caption text-medium-emphasis mb-4">{{ $t('backup.subtitle') }}</div>

    <!--
      ⚠ Presentation only. A signed-in user who types this URL gets the screen; the server's
      allow-list is what refuses the calls. This banner explains a wall of 403s rather than
      preventing them.
    -->
    <v-alert v-if="!store.sysAdmin" type="info" variant="tonal" class="mb-4" density="comfortable">
      <div class="font-weight-medium">{{ $t('backup.notSysAdmin') }}</div>
      <div class="text-caption mt-1">
        {{ store.configured ? $t('backup.notListed') : $t('backup.notConfigured') }}
      </div>
    </v-alert>

    <v-alert v-if="store.error" type="error" variant="tonal" class="mb-4" closable @click:close="store.error = ''">
      {{ store.error }}
    </v-alert>

    <!-- ── Create (FR-13.29) ─────────────────────────────────────────────── -->
    <v-card class="mb-4">
      <v-card-title class="text-subtitle-1">{{ $t('backup.createTitle') }}</v-card-title>
      <v-card-text>
        <v-row dense align="center">
          <v-col cols="12" sm="4">
            <v-select
              v-model="variant"
              :items="variantItems"
              :label="$t('backup.variant')"
              density="compact"
              hide-details
              :disabled="!store.sysAdmin"
            />
          </v-col>
          <v-col cols="12" sm="5" class="text-caption text-medium-emphasis">
            {{ variant === 'full' ? $t('backup.variantFullHint') : $t('backup.variantDataHint') }}
          </v-col>
          <v-col cols="12" sm="3" class="text-sm-right">
            <v-btn color="primary" :loading="creating" :disabled="!store.sysAdmin" @click="create">
              {{ $t('backup.createNow') }}
            </v-btn>
          </v-col>
        </v-row>
        <v-progress-linear v-if="creating" :model-value="taskProgress" height="6" class="mt-3" color="primary" />
        <div v-if="taskMessage" class="text-caption mt-1">{{ taskMessage }}</div>
      </v-card-text>
    </v-card>

    <!-- ── History ──────────────────────────────────────────────────────── -->
    <v-card class="mb-4">
      <v-card-title class="text-subtitle-1">{{ $t('backup.runsTitle') }}</v-card-title>
      <v-card-text>
        <v-data-table
          :headers="runHeaders"
          :items="store.runs"
          :loading="store.loading"
          item-value="_id"
          density="compact"
          hover
        >
          <template #item.startedAt="{ item }">
            <span class="text-caption">{{ formatDateTime(item.startedAt) }}</span>
          </template>
          <template #item.status="{ item }">
            <v-chip :color="item.status === 'completed' ? 'success' : item.status === 'failed' ? 'error' : 'warning'" size="x-small" label>
              {{ item.status }}
            </v-chip>
          </template>
          <template #item.variant="{ item }">
            <v-chip size="x-small" variant="outlined">{{ item.variant || 'data' }}</v-chip>
          </template>
          <template #item.bytes="{ item }">{{ humanBytes(item.bytes) }}</template>
          <template #item.destinations="{ item }">
            <!--
              ⚠ An empty list is a POSITIVE statement — this bundle went nowhere and sits on
              the same node-local volume as the live database. It must never render as blank.
            -->
            <template v-if="reached(item).length">
              <v-chip v-for="d in reached(item)" :key="d" color="success" size="x-small" label class="mr-1">{{ d }}</v-chip>
            </template>
            <v-chip v-else-if="item.status === 'completed'" color="warning" size="x-small" label>
              {{ $t('backup.noOffsite') }}
            </v-chip>
          </template>
          <template #item.actions="{ item }">
            <v-btn
              icon="mdi-download" size="x-small" variant="text"
              :disabled="item.artifactPruned || !item.filename"
              :href="store.downloadUrl(item._id)"
              :title="$t('backup.download')"
            />
            <v-btn
              icon="mdi-shield-check" size="x-small" variant="text"
              :disabled="item.artifactPruned || !item.filename"
              :title="$t('backup.verify')"
              @click="verify(item)"
            />
            <v-btn
              icon="mdi-database-import" size="x-small" variant="text"
              :disabled="!store.sysAdmin || item.artifactPruned || !item.filename"
              :title="$t('backup.useForRestore')"
              @click="pickRun(item)"
            />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- ── Restore (FR-13.30–13.36) ─────────────────────────────────────── -->
    <v-card v-if="store.sysAdmin" class="mb-4" variant="outlined">
      <v-card-title class="text-subtitle-1 d-flex align-center">
        <v-icon icon="mdi-restore-alert" color="error" class="mr-2" />
        {{ $t('backup.restoreTitle') }}
      </v-card-title>
      <v-card-text>
        <v-alert type="warning" variant="tonal" density="compact" class="mb-4">
          {{ $t('backup.restoreWarning') }}
        </v-alert>

        <!-- 1. Source -->
        <div class="text-subtitle-2 mb-2">{{ $t('backup.step1') }}</div>
        <v-row dense align="center">
          <v-col cols="12" sm="6">
            <v-text-field
              :model-value="sourceLabel"
              :label="$t('backup.source')"
              density="compact"
              readonly
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="6">
            <v-file-input
              v-model="uploadFile"
              :label="$t('backup.uploadBundle')"
              density="compact"
              hide-details
              prepend-icon="mdi-upload"
              accept=".zst"
              @update:model-value="onUpload"
            />
          </v-col>
        </v-row>

        <!-- 2. Inspect -->
        <div class="text-subtitle-2 mt-5 mb-2">{{ $t('backup.step2') }}</div>
        <v-btn color="primary" variant="tonal" :loading="store.busy" :disabled="!source" @click="inspect">
          {{ $t('backup.inspect') }}
        </v-btn>
        <span class="text-caption text-medium-emphasis ml-3">{{ $t('backup.inspectHint') }}</span>

        <template v-if="store.inspection">
          <v-alert
            v-for="(w, i) in store.inspection.warnings"
            :key="i" type="warning" variant="tonal" density="compact" class="mt-3"
          >{{ w }}</v-alert>

          <v-table density="compact" class="mt-3">
            <thead>
              <tr>
                <th>{{ $t('backup.collection') }}</th>
                <th class="text-right">{{ $t('backup.inBundle') }}</th>
                <th class="text-right">{{ $t('backup.inLive') }}</th>
                <th class="text-right">{{ $t('backup.missing') }}</th>
                <th class="text-right">{{ $t('backup.differing') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in store.inspection.collections" :key="c.name">
                <td>{{ c.name }}</td>
                <td class="text-right">{{ c.inBundle }}</td>
                <td class="text-right">{{ c.inLive }}</td>
                <td class="text-right" :class="c.missing ? 'text-warning font-weight-bold' : ''">{{ c.missing }}</td>
                <td class="text-right">{{ c.differing }}</td>
              </tr>
            </tbody>
          </v-table>

          <!-- 3. Mode -->
          <div class="text-subtitle-2 mt-5 mb-2">{{ $t('backup.step3') }}</div>
          <v-radio-group v-model="mode" density="compact" hide-details>
            <v-radio value="merge">
              <template #label>
                <div>
                  <div class="font-weight-medium">{{ $t('backup.modeMerge') }}</div>
                  <div class="text-caption text-medium-emphasis">{{ $t('backup.modeMergeHint') }}</div>
                </div>
              </template>
            </v-radio>
            <v-radio value="replace">
              <template #label>
                <div>
                  <div class="font-weight-medium text-error">{{ $t('backup.modeReplace') }}</div>
                  <div class="text-caption text-medium-emphasis">{{ $t('backup.modeReplaceHint') }}</div>
                </div>
              </template>
            </v-radio>
          </v-radio-group>

          <v-checkbox
            v-if="crossOrg"
            v-model="remap"
            :label="$t('backup.remap')"
            density="compact"
            hide-details
            class="mt-2"
          />
          <div v-if="crossOrg" class="text-caption text-medium-emphasis ml-8">{{ $t('backup.remapHint') }}</div>

          <v-checkbox
            v-model="restoreFiles"
            :label="$t('backup.restoreFiles')"
            density="compact"
            hide-details
            class="mt-2"
          />
          <div class="text-caption text-medium-emphasis ml-8">{{ $t('backup.restoreFilesHint') }}</div>

          <v-text-field
            v-if="mode === 'replace'"
            v-model="confirmSlug"
            :label="$t('backup.confirmSlug')"
            :placeholder="orgSlug"
            density="compact"
            class="mt-3"
            style="max-width:420px"
            hide-details
          />

          <div class="mt-4">
            <v-btn
              :color="mode === 'replace' ? 'error' : 'primary'"
              :loading="store.busy"
              :disabled="mode === 'replace' && confirmSlug !== orgSlug"
              @click="apply"
            >
              {{ mode === 'replace' ? $t('backup.applyReplace') : $t('backup.applyMerge') }}
            </v-btn>
            <span class="text-caption text-medium-emphasis ml-3">{{ $t('backup.safetyNote') }}</span>
          </div>
        </template>
      </v-card-text>
    </v-card>

    <!-- ── The report of the last restore ───────────────────────────────── -->
    <v-card v-if="store.lastRestore" class="mb-4">
      <v-card-title class="text-subtitle-1">{{ $t('backup.reportTitle') }}</v-card-title>
      <v-card-text>
        <div class="mb-2">
          <v-chip :color="store.lastRestore.status === 'completed' ? 'success' : 'error'" size="small" label>
            {{ store.lastRestore.mode }} · {{ store.lastRestore.status }}
          </v-chip>
          <span class="ml-3">{{ $t('backup.inserted') }}: {{ store.lastRestore.documentsInserted }}</span>
          <span class="ml-3">{{ $t('backup.deleted') }}: {{ store.lastRestore.documentsDeleted }}</span>
        </div>

        <!-- FR-13.35: every clamp, and by how much — a fiscal defect that did not happen. -->
        <v-alert v-if="store.lastRestore.sequenceClamps?.length" type="info" variant="tonal" density="compact" class="mb-2">
          <div class="font-weight-medium">{{ $t('backup.clampsTitle') }}</div>
          <div v-for="c in store.lastRestore.sequenceClamps" :key="`${c.prefix}-${c.year}`" class="text-caption">
            {{ c.prefix }} {{ c.year }}: {{ $t('backup.clampLine', { live: c.live, bundle: c.bundle, kept: c.kept }) }}
          </div>
        </v-alert>

        <!-- FR-13.37: say plainly that a data-only restore did not bring the documents back. -->
        <v-alert v-if="store.lastRestore.danglingFileCount" type="warning" variant="tonal" density="compact" class="mb-2">
          {{ $t('backup.dangling', { n: store.lastRestore.danglingFileCount }) }}
          <div class="text-caption mt-1">{{ (store.lastRestore.danglingFiles || []).slice(0, 10).join(', ') }}</div>
        </v-alert>

        <v-alert v-for="(w, i) in store.lastRestore.warnings" :key="i" type="warning" variant="tonal" density="compact" class="mb-2">
          {{ w }}
        </v-alert>

        <div v-if="store.lastRestore.safetyFilename" class="text-caption text-medium-emphasis">
          {{ $t('backup.safetyTaken') }}: {{ store.lastRestore.safetyFilename }}
        </div>
      </v-card-text>
    </v-card>

    <!-- ── Restore history ──────────────────────────────────────────────── -->
    <v-card v-if="store.sysAdmin">
      <v-card-title class="text-subtitle-1">{{ $t('backup.restoresTitle') }}</v-card-title>
      <v-card-text>
        <v-data-table
          :headers="restoreHeaders"
          :items="store.restores"
          item-value="_id"
          density="compact"
          hover
        >
          <template #item.startedAt="{ item }">
            <span class="text-caption">{{ formatDateTime(item.startedAt) }}</span>
          </template>
          <template #item.mode="{ item }">
            <v-chip :color="item.mode === 'replace' ? 'error' : item.mode === 'merge' ? 'warning' : 'default'" size="x-small" label>
              {{ item.mode }}
            </v-chip>
          </template>
          <template #item.status="{ item }">
            <v-chip :color="statusColor(item.status)" size="x-small" label>{{ item.status }}</v-chip>
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
/**
 * FR-13.27 (#24) — `admin/backup`, beside `admin/audit-log` and deliberately NOT under
 * `settings/`: that group is the org owner's self-service area, and restoring is not
 * self-service.
 *
 * The screen is one flow, top to bottom, because the FR's ordering is a safety property and
 * not a layout preference: pick a source → Inspect (which writes nothing) → read the diff →
 * only then choose a writing mode. The apply button does not exist until an Inspect result
 * does, and Replace stays disabled until the org's slug has been typed.
 */
import { ref, computed, onMounted } from 'vue'
import { useBackupStore } from '../../store/backup.store'
import { useAppStore } from '../../store/app.store'

const store = useBackupStore()
const appStore = useAppStore()

const variant = ref<'data' | 'full'>('data')
const creating = ref(false)
const taskProgress = ref(0)
const taskMessage = ref('')

const source = ref<{ type: string; runId?: string; path?: string } | null>(null)
const sourceLabel = ref('')
const uploadFile = ref<any>(null)
const mode = ref<'merge' | 'replace'>('merge')
const remap = ref(false)
const restoreFiles = ref(false)
const confirmSlug = ref('')

const orgSlug = computed(() => (appStore.currentOrg as any)?.slug || '')
const crossOrg = computed(() =>
  !!store.inspection && String(store.inspection.manifestOrgId || '') !== String(appStore.currentOrg?.id || ''))

const variantItems = [
  { title: 'data', value: 'data' },
  { title: 'full', value: 'full' },
]

const runHeaders = [
  { title: 'Started', key: 'startedAt' },
  { title: 'Date', key: 'date' },
  { title: 'Status', key: 'status' },
  { title: 'Variant', key: 'variant' },
  { title: 'Documents', key: 'documentCount', align: 'end' as const },
  { title: 'Size', key: 'bytes', align: 'end' as const },
  { title: 'Off-site', key: 'destinations', sortable: false },
  { title: '', key: 'actions', sortable: false },
]

const restoreHeaders = [
  { title: 'Started', key: 'startedAt' },
  { title: 'Mode', key: 'mode' },
  { title: 'Status', key: 'status' },
  { title: 'By', key: 'actorEmail' },
  { title: 'Bundle', key: 'bundleDate' },
  { title: 'Inserted', key: 'documentsInserted', align: 'end' as const },
  { title: 'Deleted', key: 'documentsDeleted', align: 'end' as const },
]

const reached = (run: any) =>
  (run.destinations || []).filter((d: any) => d.status === 'reached').map((d: any) => d.name)

const statusColor = (s: string) =>
  s === 'completed' ? 'success' : s === 'rolled_back' ? 'warning' : s === 'failed' ? 'error' : 'info'

function humanBytes(n?: number): string {
  if (!n) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

function formatDateTime(v: string): string {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}

/**
 * Poll the `BackgroundTask` a create dispatched (FR-13.29).
 *
 * ⚠ The request returns a task id, never the bundle: at year-10 volumes the build outlives
 * the ingress proxy timeout, which is the lesson the Files app's OCR sidecar already paid for.
 */
async function create() {
  creating.value = true
  taskProgress.value = 0
  taskMessage.value = ''
  const started = await store.createArchive(variant.value)
  if (!started?.taskId) { creating.value = false; return }

  const poll = async () => {
    try {
      const t = await store.taskStatus(started.taskId)
      taskProgress.value = t.progress || 0
      taskMessage.value = (t.logs || []).slice(-1)[0] || ''
      if (t.status === 'completed' || t.status === 'failed') {
        creating.value = false
        if (t.status === 'failed') store.error = t.error || 'The backup failed'
        await store.listArchives()
        return
      }
    } catch {
      creating.value = false
      return
    }
    setTimeout(poll, 1500)
  }
  setTimeout(poll, 1000)
}

async function verify(run: any) {
  const res = await store.verifyArchive(run._id)
  if (res) {
    taskMessage.value = res.ok
      ? `${run.filename}: ok (${res.documentCount} documents)`
      : `${run.filename}: ${res.problems.join('; ')}`
  }
}

function pickRun(run: any) {
  source.value = { type: 'run', runId: run._id }
  sourceLabel.value = run.filename
  store.inspection = null
}

async function onUpload(f: any) {
  const file = Array.isArray(f) ? f[0] : f
  if (!file) return
  const res = await store.uploadBundle(file)
  if (res?.path) {
    source.value = { type: 'upload', path: res.path }
    sourceLabel.value = res.filename
    store.inspection = null
  }
}

async function inspect() {
  if (source.value) await store.inspect(source.value)
}

async function apply() {
  if (!source.value) return
  await store.restoreArchive({
    source: source.value,
    mode: mode.value,
    remap: remap.value,
    confirmSlug: confirmSlug.value,
    restoreFiles: restoreFiles.value,
  })
  confirmSlug.value = ''
}

onMounted(async () => {
  await store.checkAccess()
  await store.listArchives()
  await store.listRestores()
})
</script>
