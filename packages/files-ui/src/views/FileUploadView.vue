<template>
  <v-container>
    <div class="mb-4 d-flex align-center">
      <div>
        <h1 class="text-h5 mb-1">{{ $t('files.upload.title') }}</h1>
        <p class="text-body-2 text-grey mb-0">{{ $t('files.upload.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-file-document-multiple" @click="router.push({ name: 'files.documents' })">
        {{ $t('files.documents.title') }}
      </v-btn>
    </div>

    <v-card variant="outlined" class="mb-4">
      <v-card-text>
        <v-file-input
          v-model="files"
          :label="$t('files.upload.pick')"
          prepend-icon="mdi-paperclip"
          multiple
          chips
          counter
          show-size
          accept=".pdf,.xlsx"
          :disabled="uploading"
        />
        <div class="d-flex align-center">
          <span class="text-caption text-grey">{{ $t('files.upload.hint') }}</span>
          <v-spacer />
          <v-btn color="primary" :loading="uploading" :disabled="!files.length" prepend-icon="mdi-cloud-upload" @click="doUpload">
            {{ $t('files.upload.action') }}
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <v-card v-if="results.length" variant="outlined">
      <v-card-title class="text-subtitle-1">{{ $t('files.upload.results') }}</v-card-title>
      <v-data-table
        :headers="headers"
        :items="results"
        density="compact"
        :items-per-page="-1"
        hide-default-footer
      >
        <template #item.docType="{ item }"><v-chip size="x-small" label>{{ item.docType }}</v-chip></template>
        <template #item.docDate="{ item }">{{ item.docDate || $t('files.upload.inbox') }}</template>
        <template #item.outcome="{ item }">
          <v-chip size="x-small" :color="outcomeColor(item.outcome)" label>{{ item.outcome }}</v-chip>
        </template>
        <template #item.act="{ item }">
          <div class="d-flex ga-1 flex-wrap align-center">
            <template v-if="item.compare">
              <v-chip size="x-small" color="warning" label>{{ $t('files.compare.qty') }}: {{ item.compare.qtyMismatches }}</v-chip>
              <v-chip size="x-small" color="info" label>{{ $t('files.compare.price') }}: {{ item.compare.priceMismatches }}</v-chip>
              <v-chip size="x-small" color="error" label>{{ $t('files.compare.missing') }}: {{ item.compare.missingFromLgr }}</v-chip>
            </template>
            <template v-else>
              <v-chip v-if="item.status === 'committed'" size="x-small" color="success" label prepend-icon="mdi-check">{{ $t('invoicing.status.committed') || 'committed' }}</v-chip>
              <v-btn v-if="canOcr(item)" size="x-small" variant="tonal" :loading="item._ocr" prepend-icon="mdi-text-recognition" @click="ocr(item)">{{ $t('files.ocrAction') }}</v-btn>
              <v-btn v-if="canAnalyze(item)" size="x-small" variant="tonal" color="primary" :loading="item._busy" prepend-icon="mdi-magnify-scan" @click="analyze(item)">{{ $t('files.analyze') }}</v-btn>
              <v-btn v-if="canReconcile(item)" size="x-small" variant="tonal" color="deep-purple" :loading="item._busy" prepend-icon="mdi-sync-alert" @click="reconcile(item)">{{ $t('files.reconcile.action') }}</v-btn>
            </template>
          </div>
        </template>
      </v-data-table>
    </v-card>

    <!-- Analysis → Commit dialog -->
    <v-dialog v-model="analysisDialog" max-width="820">
      <v-card v-if="current">
        <v-card-title class="d-flex align-center">
          <span class="text-subtitle-1">{{ $t('files.analyze') }} — {{ current.name }}</span>
          <v-spacer />
          <v-chip size="small" label class="mr-1">{{ current._analysis?.target }}</v-chip>
          <v-chip size="small" label>{{ current._analysis?.docKind }}</v-chip>
        </v-card-title>
        <v-card-text>
          <v-alert v-if="current._analysis?.duplicate" type="warning" density="compact" variant="tonal" class="mb-2">
            {{ $t('files.reconcile.duplicate') }}
          </v-alert>
          <v-alert v-for="(w, i) in (current._analysis?.warnings || [])" :key="i" type="warning" density="compact" variant="tonal" class="mb-1">{{ w }}</v-alert>
          <v-alert v-if="current._analysis?.error" type="error" density="compact" variant="tonal" class="mb-2">{{ current._analysis.error }}</v-alert>

          <v-table density="compact" class="mt-2">
            <thead><tr>
              <th>#</th><th>{{ $t('files.reconcile.source') }}</th><th>{{ $t('files.reconcile.matched') }}</th><th class="text-right">{{ $t('files.reconcile.qty') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="(l, i) in analysisLines" :key="i">
                <td>{{ i + 1 }}</td>
                <td class="text-caption">{{ l.source }}</td>
                <td>
                  <v-icon v-if="l.matched" color="success" size="small">mdi-check</v-icon>
                  <v-icon v-else color="error" size="small">mdi-alert</v-icon>
                  <span class="text-caption ml-1">{{ l.product }}</span>
                </td>
                <td class="text-right">{{ l.qty }}</td>
              </tr>
            </tbody>
          </v-table>
          <p v-if="unmatchedCount" class="text-caption text-error mt-2">{{ $t('files.reconcile.unmatchedWarn', { n: unmatchedCount }) }}</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="analysisDialog = false">{{ $t('common.close') }}</v-btn>
          <v-btn color="primary" :loading="current._busy" prepend-icon="mdi-database-check" @click="commit(current)">{{ $t('files.commit') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Reconcile dialog (dry-run preview → execute) -->
    <v-dialog v-model="reconcileDialog" max-width="860">
      <v-card v-if="current">
        <v-card-title class="text-subtitle-1">{{ $t('files.reconcile.title') }} — {{ current.name }} (v{{ current._reconcile?.version }})</v-card-title>
        <v-card-text>
          <div class="d-flex ga-2 mb-3">
            <v-chip size="small" color="success" label>{{ $t('files.reconcile.creates') }}: {{ current._reconcile?.creates || 0 }}</v-chip>
            <v-chip size="small" color="info" label>{{ $t('files.reconcile.updates') }}: {{ current._reconcile?.updates || 0 }}</v-chip>
            <v-chip size="small" color="error" label>{{ $t('files.reconcile.deletes') }}: {{ current._reconcile?.deletes || 0 }}</v-chip>
          </div>
          <p v-if="!current._reconcile?.deltas?.length" class="text-body-2 text-grey">{{ $t('files.reconcile.noChange') }}</p>
          <v-table v-else density="compact">
            <thead><tr>
              <th>{{ $t('files.reconcile.change') }}</th><th>{{ $t('files.col.sku') }}</th><th>{{ $t('files.col.name') }}</th>
              <th class="text-right">{{ $t('files.reconcile.booked') }}</th><th class="text-right">{{ $t('files.reconcile.new') }}</th><th class="text-right">{{ $t('files.reconcile.delta') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="(d, i) in current._reconcile.deltas" :key="i">
                <td><v-chip size="x-small" :color="changeColor(d.change)" label>{{ d.change }}</v-chip></td>
                <td class="text-caption">{{ d.sku }}</td>
                <td class="text-caption">{{ d.name }}</td>
                <td class="text-right">{{ d.bookedNet }}</td>
                <td class="text-right">{{ d.newNet }}</td>
                <td class="text-right" :class="d.delta > 0 ? 'text-success' : 'text-error'">{{ d.delta > 0 ? '+' : '' }}{{ d.delta }}</td>
              </tr>
            </tbody>
          </v-table>
          <v-alert v-if="current._reconcile?.executed && !current._reconcile?.verified" type="error" density="compact" variant="tonal" class="mt-2">
            {{ $t('files.reconcile.unverified') }}: {{ (current._reconcile.warnings || []).join('; ') }}
          </v-alert>
          <v-alert v-else-if="current._reconcile?.executed" type="success" density="compact" variant="tonal" class="mt-2">
            {{ $t('files.reconcile.booked') }}: {{ (current._reconcile.bookedNow || []).join(', ') || '—' }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="reconcileDialog = false">{{ $t('common.close') }}</v-btn>
          <v-btn
            v-if="!current._reconcile?.executed && current._reconcile?.deltas?.length"
            color="deep-purple" :loading="current._busy" prepend-icon="mdi-database-sync"
            @click="reconcile(current, true)"
          >{{ $t('files.reconcile.execute') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const files = ref<File[]>([])
const uploading = ref(false)
const results = ref<any[]>([])
const current = ref<any>(null)
const analysisDialog = ref(false)
const reconcileDialog = ref(false)

const headers = [
  { title: t('files.col.name'), key: 'name' },
  { title: t('files.col.type'), key: 'docType' },
  { title: t('files.col.number'), key: 'docNumber' },
  { title: t('files.col.date'), key: 'docDate' },
  { title: t('files.col.version'), key: 'version' },
  { title: t('files.col.outcome'), key: 'outcome' },
  { title: '', key: 'act', sortable: false },
]

const PDF_TYPES = new Set(['invoice', 'goods_receipt', 'correction', 'transfer_note', 'issue_note', 'unknown'])
const MOVEMENT_TYPES = new Set(['goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations'])
const ANALYZABLE = new Set([...MOVEMENT_TYPES, 'invoice', 'cash_register'])

function canOcr(item: any) {
  return PDF_TYPES.has(item.docType) && item.status !== 'extracted' && item.status !== 'committed' && item.status !== 'analyzed'
}
function canAnalyze(item: any) {
  return ANALYZABLE.has(item.docType) && item.status !== 'committed'
}
// A re-uploaded movement doc (its prior version may already be booked) → reconcile the delta.
function canReconcile(item: any) {
  return MOVEMENT_TYPES.has(item.docType) && String(item.outcome || '').startsWith('overwrote')
}

const analysisLines = computed(() => {
  const a = current.value?._analysis
  if (!a?.mapped?.lines) return []
  const per = a.lines || []
  return a.mapped.lines.map((l: any, i: number) => ({
    source: l.sourceText || per[i]?.sourceText || l.productName,
    matched: per[i]?.matched ?? !!l.productId,
    product: l.productName || (per[i]?.candidateNew?.name ? `${t('files.reconcile.willCreate')}: ${per[i].candidateNew.name}` : '—'),
    qty: l.quantity,
  }))
})
const unmatchedCount = computed(() => analysisLines.value.filter((l: any) => !l.matched).length)

function outcomeColor(o: string) {
  if (o === 'created') return 'success'
  if (o === 'duplicate') return 'grey'
  return 'warning' // overwrote vN
}
function changeColor(c: string) {
  return c === 'create' ? 'success' : c === 'delete' ? 'error' : 'info'
}

async function ocr(item: any) {
  item._ocr = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/${item.docFileId}/ocr`)
    item.docType = data.docType
    item.docDate = data.docDate
    item.status = data.status
    showSuccess(t('files.ocrDone', { n: data.chars }))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { item._ocr = false }
}

async function analyze(item: any) {
  item._busy = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/${item.docFileId}/analyze`)
    item._analysis = data
    item.status = 'analyzed'
    current.value = item
    analysisDialog.value = true
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { item._busy = false }
}

async function commit(item: any) {
  item._busy = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/${item.docFileId}/commit`, {})
    item.status = 'committed'
    analysisDialog.value = false
    showSuccess(t('files.committed', { n: data.issuedNumber || data.number || data.id }))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { item._busy = false }
}

async function reconcile(item: any, execute = false) {
  item._busy = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/${item.docFileId}/reconcile${execute ? '?execute=true' : ''}`)
    item._reconcile = data
    current.value = item
    reconcileDialog.value = true
    if (execute) {
      if (data.verified === false) showError(t('files.reconcile.unverified'))
      else showSuccess(t('files.reconcile.done', { n: (data.bookedNow || []).length }))
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { item._busy = false }
}

async function doUpload() {
  if (!files.value.length) return
  uploading.value = true
  try {
    const fd = new FormData()
    for (const f of files.value) fd.append('files', f)
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/upload`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    results.value = data.results
    showSuccess(t('files.upload.done', { n: data.results.length }))
    files.value = []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    uploading.value = false
  }
}
</script>
