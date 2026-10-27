<template>
  <v-dialog v-model="show" max-width="1200" scrollable :persistent="busy">
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon icon="mdi-file-upload-outline" />
        <span>{{ $t(mode === 'single' ? 'docImport.titleSingle' : 'docImport.titleBatch') }}</span>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" :disabled="busy" @click="show = false" />
      </v-card-title>
      <v-divider />

      <v-card-text style="min-height: 420px">
        <v-stepper v-model="step" :items="stepLabels" flat hide-actions>
          <!-- ── Step 1: source ── -->
          <template #item.1>
            <v-row dense>
              <v-col v-if="needsWarehouse" cols="12" md="4">
                <v-select
                  v-model="warehouseId"
                  :items="warehouses"
                  item-title="name"
                  item-value="_id"
                  :label="$t('docImport.warehouse')"
                  :hint="$t(target === 'cash_sale' ? 'docImport.warehouseHintSale' : 'docImport.warehouseHint')"
                  persistent-hint
                  density="comfortable"
                  variant="outlined"
                />
              </v-col>
              <v-col v-if="target === 'bill'" cols="12" md="4">
                <v-autocomplete
                  v-model="orderId"
                  :items="orderOptions"
                  item-title="label"
                  item-value="_id"
                  :label="$t('docImport.order')"
                  :hint="$t('docImport.orderHint')"
                  persistent-hint
                  clearable
                  no-filter
                  density="comfortable"
                  variant="outlined"
                  :loading="loadingOrders"
                  @update:search="onOrderSearch"
                />
              </v-col>
              <v-col cols="12" :md="needsWarehouse ? 4 : 8">
                <v-file-input
                  v-model="files"
                  :label="$t(mode === 'single' ? 'docImport.selectFile' : 'docImport.selectFiles')"
                  :accept="acceptedTypes"
                  :multiple="mode === 'batch'"
                  chips
                  show-size
                  prepend-icon="mdi-file-document-outline"
                  density="comfortable"
                  variant="outlined"
                  :hint="$t('docImport.fileHint')"
                  persistent-hint
                />
              </v-col>
            </v-row>

            <v-alert v-if="tooManyFiles" type="warning" variant="tonal" density="compact" class="mt-2">
              {{ $t('docImport.tooManyFiles', { max: MAX_IMPORT_FILES }) }}
            </v-alert>

            <div class="d-flex align-center ga-3 mt-3 flex-wrap">
              <v-btn
                color="primary"
                :loading="extracting"
                :disabled="!canExtract"
                prepend-icon="mdi-text-recognition"
                @click="doExtract(false)"
              >
                {{ $t('docImport.extract') }}
              </v-btn>
              <v-btn
                v-if="extracted.length"
                variant="text"
                size="small"
                :loading="extracting"
                prepend-icon="mdi-image-filter-center-focus"
                :title="$t('docImport.forceOcrHint')"
                @click="doExtract(true)"
              >
                {{ $t('docImport.forceOcr') }}
              </v-btn>
              <span v-if="extracted.length" class="text-caption text-medium-emphasis">
                {{ $t('docImport.extractedN', { n: extractedOk.length }) }}
              </span>
            </div>

            <v-expansion-panels v-if="extracted.length" class="mt-4" multiple>
              <v-expansion-panel v-for="e in extracted" :key="e.fileId">
                <v-expansion-panel-title>
                  <v-icon
                    :icon="e.error ? 'mdi-alert-circle' : 'mdi-file-check'"
                    :color="e.error ? 'error' : 'success'"
                    class="mr-2"
                    size="small"
                  />
                  {{ e.filename }}
                  <v-chip v-if="e.method" size="x-small" class="ml-2" :color="e.method === 'native' ? 'info' : 'warning'">
                    {{ e.method }}
                  </v-chip>
                  <span v-if="e.error" class="text-error text-caption ml-2">{{ e.error }}</span>
                  <span v-else class="text-caption text-medium-emphasis ml-2">
                    {{ e.chars }} {{ $t('docImport.chars') }}
                  </span>
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <v-textarea v-model="e.text" :rows="10" variant="outlined" density="compact" hide-details class="text-mono" />
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </template>

          <!-- ── Step 2: review ── -->
          <template #item.2>
            <div v-if="analyzing" class="py-8 text-center">
              <v-progress-linear :model-value="progress" color="primary" height="8" rounded class="mb-3" />
              <p class="text-body-2 text-medium-emphasis">{{ statusText || $t('docImport.analyzing') }}</p>
            </div>

            <!-- single-document field diff -->
            <template v-else-if="mode === 'single'">
              <v-alert v-if="!singleDoc" type="info" variant="tonal" density="compact">
                {{ $t('docImport.nothingAnalyzed') }}
              </v-alert>
              <template v-else>
                <DocWarnings :doc="singleDoc" />

                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ $t('docImport.fieldsToApply') }}</span>
                  <v-spacer />
                  <v-btn variant="text" size="x-small" @click="setAllFields(true)">{{ $t('docImport.selectAll') }}</v-btn>
                  <v-btn variant="text" size="x-small" @click="setAllFields(false)">{{ $t('docImport.selectNone') }}</v-btn>
                </div>

                <v-table density="compact" class="mb-4">
                  <thead>
                    <tr>
                      <th style="width: 48px" />
                      <th>{{ $t('docImport.field') }}</th>
                      <th>{{ $t('docImport.current') }}</th>
                      <th>{{ $t('docImport.imported') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in diffRows" :key="row.key">
                      <td><v-checkbox-btn v-model="fieldChecked[row.key]" density="compact" /></td>
                      <td class="text-body-2">{{ row.label }}</td>
                      <td class="text-body-2 text-medium-emphasis">{{ row.current || '—' }}</td>
                      <td class="text-body-2" :class="row.changed ? 'font-weight-medium' : 'text-medium-emphasis'">
                        {{ row.imported || '—' }}
                      </td>
                    </tr>
                    <tr v-if="!diffRows.length">
                      <td colspan="4" class="text-center text-medium-emphasis py-4">{{ $t('docImport.noFields') }}</td>
                    </tr>
                  </tbody>
                </v-table>

                <div class="d-flex align-center ga-4 mb-2 flex-wrap">
                  <span class="text-subtitle-2">
                    {{ $t('docImport.lines') }}
                    <span class="text-caption text-medium-emphasis ml-1">
                      {{ $t('docImport.matchedN', { n: matchedCount(singleDoc), total: lineCount(singleDoc) }) }}
                    </span>
                  </span>
                  <v-radio-group v-model="lineMode" inline density="compact" hide-details>
                    <v-radio :label="$t('docImport.linesReplace')" value="replace" />
                    <v-radio :label="$t('docImport.linesAppend')" value="append" />
                    <v-radio :label="$t('docImport.linesKeep')" value="keep" />
                  </v-radio-group>
                </div>

                <LineReview v-if="lineMode !== 'keep'" :doc="singleDoc" @pick="openPicker" />

                <v-alert
                  v-if="singleDoc.diagnostics.contactSuggestion && !singleDoc.mapped?.contactId"
                  type="info"
                  variant="tonal"
                  density="compact"
                  class="mt-3"
                >
                  {{ $t('docImport.contactNotFound', { name: singleDoc.diagnostics.contactSuggestion.name }) }}
                </v-alert>
              </template>
            </template>

            <!-- batch review -->
            <template v-else>
              <div class="d-flex align-center mb-3 flex-wrap ga-2">
                <span class="text-body-2">{{ $t('docImport.reviewIntro', { n: analyzed.length }) }}</span>
                <v-spacer />
                <!-- Movements are booked and confirmed in one step, so "issue now" has no
                     meaning there; what matters instead is whether to create the products
                     an unmatched line needs. -->
                <v-checkbox
                  v-if="target === 'movement'"
                  v-model="createMissingProducts"
                  :label="$t('docImport.createMissingProducts')"
                  :messages="unmatchedTotal ? $t('docImport.unmatchedN', { n: unmatchedTotal }) : ''"
                  density="compact"
                  hide-details="auto"
                />
                <v-checkbox
                  v-else
                  v-model="convertNow"
                  :label="$t('docImport.convertNow')"
                  density="compact"
                  hide-details
                />
                <v-checkbox
                  v-model="adjustStock"
                  :label="$t('docImport.adjustStock')"
                  :disabled="target !== 'movement' && !convertNow"
                  density="compact"
                  hide-details
                />
              </div>

              <v-data-table
                v-model="selectedIds"
                :headers="batchHeaders"
                :items="batchRows"
                item-value="fileId"
                show-select
                :items-per-page="50"
                density="compact"
                show-expand
                :expanded="expanded"
                @update:expanded="expanded = $event"
              >
                <template #[`item.status`]="{ item }">
                  <v-chip v-if="item.doc.error" size="x-small" color="error" variant="tonal">{{ item.doc.error }}</v-chip>
                  <template v-else>
                    <v-chip v-if="item.doc.duplicate" size="x-small" color="warning" variant="tonal" prepend-icon="mdi-content-duplicate">
                      {{ $t('docImport.duplicate') }}
                    </v-chip>
                    <v-chip
                      v-else-if="item.doc.validation?.status === 'needs_review' || item.doc.diagnostics.warnings.length"
                      size="x-small"
                      color="warning"
                      variant="tonal"
                      prepend-icon="mdi-alert"
                    >
                      {{ $t('docImport.needsReview') }}
                    </v-chip>
                    <v-chip v-else size="x-small" color="success" variant="tonal" prepend-icon="mdi-check">
                      {{ $t('docImport.ready') }}
                    </v-chip>
                  </template>
                </template>
                <template #[`item.direction`]="{ item }">
                  <v-chip v-if="item.doc.direction" size="x-small" :color="item.doc.direction === 'outgoing' ? 'success' : 'info'" variant="tonal">
                    {{ $t(item.doc.direction === 'outgoing' ? 'docImport.sales' : 'docImport.purchase') }}
                  </v-chip>
                </template>
                <template #[`item.total`]="{ item }">
                  {{ item.total != null ? item.total.toFixed(2) : '' }} {{ item.currency }}
                </template>
                <template #[`item.matched`]="{ item }">
                  <span :class="item.unmatched ? 'text-warning' : ''">{{ item.matched }} / {{ item.lineCount }}</span>
                </template>
                <template #expanded-row="{ columns, item }">
                  <tr>
                    <td :colspan="columns.length" class="pa-3">
                      <DocWarnings :doc="item.doc" />
                      <LineReview :doc="item.doc" @pick="openPicker" />
                    </td>
                  </tr>
                </template>
              </v-data-table>
            </template>
          </template>

          <!-- ── Step 3: result ── -->
          <template #item.3>
            <div v-if="committing" class="py-8 text-center">
              <v-progress-linear :model-value="progress" color="primary" height="8" rounded class="mb-3" />
              <p class="text-body-2 text-medium-emphasis">{{ statusText || $t('docImport.committing') }}</p>
            </div>
            <template v-else>
              <v-alert
                :type="failedResults.length ? 'warning' : 'success'"
                variant="tonal"
                density="compact"
                class="mb-3"
              >
                {{ $t('docImport.committedN', { n: okResults.length }) }}
                <template v-if="failedResults.length">
                  — {{ $t('docImport.failedN', { n: failedResults.length }) }}
                </template>
              </v-alert>
              <v-table density="compact">
                <thead>
                  <tr>
                    <th>{{ $t('docImport.file') }}</th>
                    <th>{{ $t('docImport.number') }}</th>
                    <th>{{ $t('docImport.result') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in committed" :key="i">
                    <td class="text-body-2">{{ filenameFor(r.fileId) }}</td>
                    <td class="text-body-2">{{ r.issuedNumber || r.number || '—' }}</td>
                    <td class="text-body-2">
                      <span v-if="r.ok && !r.error" class="text-success">{{ $t('docImport.ok') }}</span>
                      <span v-else class="text-error">{{ r.error }}</span>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </template>
          </template>
        </v-stepper>

        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</v-alert>
      </v-card-text>

      <v-divider />
      <v-card-actions>
        <v-btn v-if="step > 1 && step < 3" variant="text" prepend-icon="mdi-arrow-left" :disabled="busy" @click="step--">
          {{ $t('common.back') }}
        </v-btn>
        <v-spacer />
        <v-btn :disabled="busy" @click="show = false">{{ $t(step === 3 ? 'common.close' : 'common.cancel') }}</v-btn>
        <v-btn
          v-if="step === 1"
          color="primary"
          :disabled="!extractedOk.length || busy"
          :loading="analyzing"
          append-icon="mdi-arrow-right"
          @click="doAnalyze"
        >
          {{ $t('docImport.analyzeBtn', { n: extractedOk.length }) }}
        </v-btn>
        <v-btn
          v-else-if="step === 2 && mode === 'single'"
          color="primary"
          :disabled="!singleDoc || !!singleDoc.error || busy"
          prepend-icon="mdi-check"
          @click="applySingle"
        >
          {{ $t('docImport.apply') }}
        </v-btn>
        <v-btn
          v-else-if="step === 2"
          color="primary"
          :disabled="!selectedIds.length || busy"
          :loading="committing"
          prepend-icon="mdi-check"
          @click="doCommit"
        >
          {{ $t('docImport.commitN', { n: selectedIds.length }) }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <ProductPickerDialog v-model="pickerOpen" :org-url="orgUrl" @select="onProductPicked" />
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../composables/useHttpClient'
import { useDocImport, MAX_IMPORT_FILES, type AnalyzedDoc, type ImportTarget } from '../composables/useDocImport'
import ProductPickerDialog from './ProductPickerDialog.vue'
import DocWarnings from './doc-import/DocImportWarnings.vue'
import LineReview from './doc-import/DocImportLines.vue'

const props = withDefaults(defineProps<{
  modelValue: boolean
  orgUrl: string
  target: ImportTarget
  /** 'batch' → many files into new documents; 'single' → one file onto the open form. */
  mode?: 'batch' | 'single'
  /** Pre-selected context. `warehouseId` seeds the picker; `orderId` enables ORDO matching. */
  context?: { warehouseId?: string; orderId?: string; contactId?: string }
  /** Single mode: the open form's current state, so the diff can show what changes. */
  currentForm?: Record<string, any>
  /**
   * Per-field i18n key overrides, so the diff names a field the way the OPEN FORM does.
   * A bill labels its notes textarea "Reason" while a sales invoice calls the same field
   * "Notes" — the diff has to agree with whatever the user is looking at.
   */
  fieldLabels?: Record<string, string>
}>(), {
  mode: 'batch',
  context: () => ({}),
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** Single mode — the accepted subset, for the form to merge. Nothing was persisted. */
  'apply': [payload: { fields: Record<string, any>; lines: any[]; lineMode: 'replace' | 'append' | 'keep'; doc: AnalyzedDoc }]
  /** Batch mode — what was created. */
  'committed': [results: any[]]
}>()

const { t } = useI18n()

const show = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const {
  extracting, analyzing, committing, busy, progress, statusText, error,
  extracted, extractedOk, analyzed, committed,
  reset, extract, analyze, commit,
} = useDocImport(() => props.orgUrl)

const step = ref(1)
const files = ref<File[]>([])
const warehouseId = ref('')
const orderId = ref<string | null>(null)
const warehouses = ref<any[]>([])
const orderOptions = ref<any[]>([])
const loadingOrders = ref(false)
const selectedIds = ref<string[]>([])
const expanded = ref<string[]>([])
const convertNow = ref(false)
const adjustStock = ref(true)
const createMissingProducts = ref(true)
const lineMode = ref<'replace' | 'append' | 'keep'>('replace')
const fieldChecked = reactive<Record<string, boolean>>({})
const pickerOpen = ref(false)
const pickerLine = ref<{ doc: AnalyzedDoc; index: number } | null>(null)

const stepLabels = computed(() => [
  t('docImport.step1'),
  t('docImport.step2'),
  t('docImport.step3'),
])

/**
 * Movements and bills receive stock into a warehouse, and a cash sale (a till day) dispatches it
 * from one: its lines take their warehouse from here, and without one the day cannot book (#324).
 * A sales invoice takes the form's warehouse when it is issued.
 */
const needsWarehouse = computed(() => props.target === 'bill' || props.target === 'movement' || props.target === 'cash_sale')
const acceptedTypes = computed(() =>
  props.target === 'cash_sale' || props.target === 'movement'
    ? 'application/pdf,.xlsx'
    : 'application/pdf',
)
const fileList = computed<File[]>(() => (Array.isArray(files.value) ? files.value : files.value ? [files.value as any] : []))
const tooManyFiles = computed(() => fileList.value.length > MAX_IMPORT_FILES)
const canExtract = computed(() =>
  fileList.value.length > 0 && !tooManyFiles.value && (!needsWarehouse.value || !!warehouseId.value),
)

const singleDoc = computed<AnalyzedDoc | null>(() => analyzed.value[0] || null)

// ── batch table ──
const batchHeaders = computed(() => [
  { title: t('docImport.file'), key: 'filename' },
  { title: t('docImport.number'), key: 'reference' },
  { title: t('docImport.direction'), key: 'direction', sortable: false },
  { title: t('docImport.counterparty'), key: 'contactName' },
  { title: t('docImport.date'), key: 'issueDate' },
  { title: t('docImport.total'), key: 'total', align: 'end' as const },
  { title: t('docImport.matchedLines'), key: 'matched', sortable: false },
  { title: t('common.status'), key: 'status', sortable: false },
])

const lineCount = (d: AnalyzedDoc) => d.diagnostics?.perLine?.length || 0
const matchedCount = (d: AnalyzedDoc) => (d.diagnostics?.perLine || []).filter(p => p.matched).length

const batchRows = computed(() => analyzed.value.map(doc => ({
  fileId: doc.fileId,
  filename: doc.filename,
  reference: doc.mapped?.reference || '',
  contactName: doc.mapped?.contactName || '',
  issueDate: doc.mapped?.issueDate || '',
  total: doc.mapped?.total,
  currency: doc.mapped?.currency || '',
  lineCount: lineCount(doc),
  matched: matchedCount(doc),
  unmatched: lineCount(doc) - matchedCount(doc) > 0,
  doc,
})))

/** Lines across the selected documents that found no product — what the toggle would create. */
const unmatchedTotal = computed(() =>
  analyzed.value
    .filter(d => selectedIds.value.includes(d.fileId))
    .reduce((s, d) => s + lineCount(d) - matchedCount(d), 0),
)

const okResults = computed(() => committed.value.filter(r => r.ok && !r.error))
const failedResults = computed(() => committed.value.filter(r => !r.ok || r.error))
const filenameFor = (fileId?: string) => extracted.value.find(e => e.fileId === fileId)?.filename || '—'

// ── single-mode field diff ──
interface DiffRow { key: string; label: string; current: string; imported: string; changed: boolean }

/**
 * Which mapped field lands on which form field. `reference` is the odd one out: the bill
 * form calls it "Supplier Invoice #" and binds `supplierInvoiceNumber`.
 */
const FIELD_DEFS: Array<{ key: string; formKey: string; labelKey: string; targets?: ImportTarget[] }> = [
  { key: 'contactName', formKey: 'contactId', labelKey: 'docImport.fieldContact' },
  { key: 'reference', formKey: 'supplierInvoiceNumber', labelKey: 'invoicing.supplierInvoiceNumber', targets: ['bill'] },
  { key: 'issueDate', formKey: 'issueDate', labelKey: 'invoicing.issueDate' },
  { key: 'dueDate', formKey: 'dueDate', labelKey: 'invoicing.dueDate' },
  { key: 'currency', formKey: 'currency', labelKey: 'common.currency' },
  { key: 'exchangeRate', formKey: 'exchangeRate', labelKey: 'invoicing.exchangeRate' },
  { key: 'paymentMethod', formKey: 'paymentMethod', labelKey: 'invoicing.paymentMethod' },
  { key: 'notes', formKey: 'notes', labelKey: 'invoicing.notes' },
  { key: 'terms', formKey: 'terms', labelKey: 'invoicing.terms' },
  { key: 'preparedBy', formKey: 'preparedBy', labelKey: 'invoicing.preparedBy' },
  { key: 'placeOfTransaction', formKey: 'placeOfTransaction', labelKey: 'invoicing.placeOfTransaction' },
]

const activeFieldDefs = computed(() => FIELD_DEFS.filter(f => !f.targets || f.targets.includes(props.target)))

function displayValue(v: any): string {
  if (v == null || v === '') return ''
  if (typeof v === 'object') return ''
  return String(v)
}

const diffRows = computed<DiffRow[]>(() => {
  const doc = singleDoc.value
  if (!doc?.mapped) return []
  const cur = props.currentForm || {}
  const rows: DiffRow[] = []
  for (const def of activeFieldDefs.value) {
    const importedRaw = def.key === 'contactName' ? doc.mapped.contactName : doc.mapped[def.key]
    const imported = displayValue(importedRaw)
    if (!imported) continue
    const current = def.formKey === 'contactId'
      ? displayValue((cur as any).contactName ?? (cur.contactId ? '…' : ''))
      : displayValue(cur[def.formKey])
    rows.push({
      key: def.key,
      label: t(props.fieldLabels?.[def.key] || def.labelKey),
      current,
      imported,
      changed: current !== imported,
    })
  }
  return rows
})

function setAllFields(value: boolean) {
  for (const row of diffRows.value) fieldChecked[row.key] = value
}

// ── actions ──
async function doExtract(forceOcr: boolean) {
  try {
    await extract(fileList.value, { forceOcr })
  } catch { /* surfaced via `error` */ }
}

async function doAnalyze() {
  step.value = 2
  try {
    const docs = await analyze(
      props.target,
      // A spreadsheet is analyzed from its parse, never its text (`analyze.ts#analyzeOne`): without
      // `parsed` a till day or a delivery export fell through to the PDF path (#324).
      extractedOk.value.map(e => ({ fileId: e.fileId, filename: e.filename, text: e.text, ...(e.parsed ? { parsed: e.parsed } : {}) })),
      {
        ...(warehouseId.value ? { warehouseId: warehouseId.value } : {}),
        ...(orderId.value ? { orderId: orderId.value } : {}),
        ...(props.context?.contactId ? { contactId: props.context.contactId } : {}),
      },
      // The single-document flow must not invent a counterparty behind the user's back.
      { createMissingContact: props.mode === 'batch' },
    )
    // Preselect everything that can be committed; duplicates and errors stay unchecked.
    selectedIds.value = docs.filter(d => !d.error && !d.duplicate).map(d => d.fileId)
    setAllFields(true)
  } catch {
    step.value = 1
  }
}

async function doCommit() {
  step.value = 3
  const chosen = analyzed.value.filter(d => selectedIds.value.includes(d.fileId) && d.mapped)
  try {
    const results = await commit(
      props.target,
      chosen.map(d => ({
        fileId: d.fileId,
        mapped: d.mapped,
        // A correction books two movements from one document.
        ...(d.extraMovements?.length ? { extraMovements: d.extraMovements } : {}),
        options: {
          convert: convertNow.value,
          adjustStock: adjustStock.value,
          createMissingProducts: createMissingProducts.value,
          // Duplicates are unchecked by default; ticking one is an explicit "yes, again".
          allowDuplicate: !!d.duplicate,
        },
      })),
    )
    emit('committed', results)
  } catch {
    step.value = 2
  }
}

function applySingle() {
  const doc = singleDoc.value
  if (!doc?.mapped) return
  const fields: Record<string, any> = {}
  for (const def of activeFieldDefs.value) {
    if (!fieldChecked[def.key]) continue
    if (def.key === 'contactName') {
      if (doc.mapped.contactId) fields.contactId = doc.mapped.contactId
      continue
    }
    const v = doc.mapped[def.key]
    if (v != null && v !== '') fields[def.formKey] = v
  }
  emit('apply', { fields, lines: doc.mapped.lines || [], lineMode: lineMode.value, doc })
  show.value = false
}

// ── unmatched-line fixing ──
function openPicker(payload: { doc: AnalyzedDoc; index: number }) {
  pickerLine.value = payload
  pickerOpen.value = true
}

function onProductPicked(product: any) {
  const ctx = pickerLine.value
  if (!ctx) return
  const { doc, index } = ctx
  const line = doc.mapped?.lines?.[index]
  const diag = doc.diagnostics?.perLine?.[index]
  if (line) {
    line.productId = product._id
    line.description = product.name
    // The document's price is the historical fact — only the product identity is corrected.
    if (!line.warehouseId && warehouseId.value) line.warehouseId = warehouseId.value
  }
  if (diag) {
    diag.matched = true
    diag.productId = product._id
    diag.matchedBy = null
  }
  pickerOpen.value = false
  pickerLine.value = null
}

// ── context loading ──
async function loadWarehouses() {
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/warehouse/warehouse`, { params: { size: 1000 } })
    warehouses.value = data.warehouses || data.data || []
    const preset = props.context?.warehouseId
    const def = warehouses.value.find((w: any) => w._id === preset)
      || warehouses.value.find((w: any) => w.isDefault)
      || warehouses.value[0]
    if (def) warehouseId.value = def._id
  } catch { /* the picker just stays empty */ }
}

let orderSearchTimer: ReturnType<typeof setTimeout> | null = null
async function fetchOrders(search?: string) {
  loadingOrders.value = true
  try {
    const params: Record<string, any> = { status: 'sent,partially_received,received', size: 20 }
    if (search) params.search = search
    const { data } = await httpClient.get(`${props.orgUrl}/invoicing/orders`, { params })
    const items = (data.orders || []).map((o: any) => ({
      _id: o._id,
      label: `${o.orderNumber} — ${(o.supplierNames || []).join(', ')}`,
    }))
    const current = orderOptions.value.find((o) => o._id === orderId.value)
    if (current && !items.some((o: any) => o._id === current._id)) items.push(current)
    orderOptions.value = items
  } catch { /* ignore */ } finally {
    loadingOrders.value = false
  }
}

function onOrderSearch(text: string) {
  if (orderSearchTimer) clearTimeout(orderSearchTimer)
  orderSearchTimer = setTimeout(() => fetchOrders(text || undefined), 300)
}

// A dialog reopened must never show the previous run's results.
watch(() => props.modelValue, (open) => {
  if (!open) return
  step.value = 1
  files.value = []
  selectedIds.value = []
  expanded.value = []
  convertNow.value = false
  adjustStock.value = true
  lineMode.value = 'replace'
  orderId.value = props.context?.orderId || null
  reset()
  if (needsWarehouse.value) loadWarehouses()
  if (props.target === 'bill') fetchOrders()
})
</script>

<style scoped>
.text-mono :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
