<template>
  <!-- `scrollable`: the options scroll between the title and the buttons, which stay in view. With the columns
       open the dialog is taller than a laptop screen, and its Download used to be below the fold. -->
  <v-dialog v-model="show" max-width="640" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">{{ icon || 'mdi-download' }}</v-icon>
        <span>{{ title || ($t ? $t('common.export') : 'Export') }}</span>
      </v-card-title>
      <v-card-text>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-radio-group v-model="format" :label="$t ? $t('common.format') : 'Format'" density="compact" inline hide-details data-testid="export-format">
              <!-- PDF first: it is the default (#146). -->
              <v-radio label="PDF" value="pdf" />
              <v-radio label="Excel (.xlsx)" value="xlsx" />
            </v-radio-group>
          </v-col>
          <!-- Modes are meaningless for the per-product pivot — hidden while aggregating. -->
          <v-col v-if="!aggregated" cols="12" md="6">
            <v-radio-group v-model="mode" :label="$t ? $t('common.mode') : 'Mode'" density="compact" inline hide-details>
              <v-radio :label="$t ? $t('export.compact') : 'Compact'" value="compact" />
              <v-radio :label="$t ? $t('export.detailed') : 'Detailed'" value="detailed" />
            </v-radio-group>
          </v-col>
        </v-row>

        <v-checkbox
          v-if="showAggregate"
          v-model="aggregated"
          :label="$t ? $t('export.aggregated') : 'Aggregate by product'"
          density="compact"
          hide-details
          class="mt-1"
        />

        <div class="text-caption text-medium-emphasis mt-2 mb-2">
          <span v-if="aggregated">{{ $t ? $t('export.aggregatedHint') : 'One row per product across the period; document headers are omitted.' }}</span>
          <span v-else-if="mode === 'compact'">{{ $t ? $t('export.compactHint') : 'One row per document, summary columns.' }}</span>
          <span v-else>{{ $t ? $t('export.detailedHint') : 'Includes line items (one row per line).' }}</span>
        </div>

        <!-- Companion documents: each ticked box downloads an extra file alongside the
             document itself, in the same format. Sits above the column picker because it
             decides *which documents* print, while the columns only shape one of them. -->
        <template v-if="companionDocs?.length">
          <v-divider class="my-2" />
          <div class="mb-1">
            <strong>{{ $t ? $t('export.companionDocs') : 'Additional documents' }}</strong>
          </div>
          <div class="text-caption text-medium-emphasis mb-1">
            {{ $t ? $t('export.companionDocsHint') : 'Each selected document is downloaded as a separate file.' }}
          </div>
          <v-row dense>
            <v-col v-for="cd in companionDocs" :key="cd.key" cols="12" sm="6">
              <v-checkbox
                :model-value="companionSet.has(cd.key)"
                :label="companionLabel(cd)"
                density="compact"
                hide-details
                @update:model-value="toggleCompanion(cd.key, $event)"
              />
            </v-col>
          </v-row>
        </template>

        <v-divider class="my-2" />

        <!-- The columns shape one printed form and are rarely changed, so a document's print dialog
             (`collapsibleColumns`) keeps them folded: the header says how many are chosen, and the whole
             header opens them. A list export shows them as it always did. Where the dialog is a phone's
             width, Select all / Clear take the line under the header instead of squeezing it. -->
        <div class="d-flex align-center mb-1" :class="{ 'flex-wrap': collapsibleColumns }">
          <button
            v-if="collapsibleColumns"
            type="button"
            class="export-columns-toggle d-flex align-center ga-1 flex-grow-1 text-start text-no-wrap"
            :aria-expanded="columnsOpen ? 'true' : 'false'"
            :aria-controls="columnsId"
            :title="$t ? $t(columnsOpen ? 'common.collapse' : 'common.expand') : undefined"
            data-testid="export-columns-toggle"
            @click="columnsOpen = !columnsOpen"
          >
            <v-icon size="small">{{ columnsOpen ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
            <strong>{{ $t ? $t('export.columns') : 'Columns' }}</strong>
            <span class="text-caption text-medium-emphasis ml-1" data-testid="export-columns-count">
              {{ $t ? $t('common.itemsSelected', { n: selectedColumns.length }) : `${selectedColumns.length} selected` }}
            </span>
          </button>
          <template v-else>
            <strong>{{ $t ? $t('export.columns') : 'Columns' }}</strong>
            <v-spacer />
          </template>
          <div v-if="columnsOpen" class="d-flex ml-auto">
            <v-btn size="x-small" variant="text" @click="selectAll">
              {{ $t ? $t('common.selectAll') : 'Select all' }}
            </v-btn>
            <v-btn size="x-small" variant="text" @click="selectNone">
              {{ $t ? $t('common.selectNone') : 'Clear' }}
            </v-btn>
          </div>
        </div>

        <v-expand-transition>
          <v-row v-show="columnsOpen" :id="columnsId" dense data-testid="export-columns">
            <v-col v-for="col in availableColumns" :key="col.key" cols="12" sm="6">
              <v-checkbox
                :model-value="selectedSet.has(col.key)"
                :label="labelFor(col)"
                density="compact"
                hide-details
                @update:model-value="toggle(col.key, $event)"
              />
            </v-col>
          </v-row>
        </v-expand-transition>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn data-testid="export-cancel" @click="show = false" :disabled="loading">{{ $t ? $t('common.cancel') : 'Cancel' }}</v-btn>
        <v-btn color="primary" :loading="loading" :disabled="!selectedColumns.length" data-testid="export-confirm" @click="onConfirm">
          {{ confirmLabel || ($t ? $t('common.download') : 'Download') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  filterColumns,
  defaultSelection,
  CASH_AGG_COLUMNS,
  type ExportColumn,
  type ExportMode,
  type DocType,
} from '../composables/useExportColumns'

/** An extra document offered alongside the main one (declaration of conformity, handover
 * protocol). `i18n` is tried first and `label` is the fallback when the key is untranslated. */
export interface CompanionDocOption {
  key: string
  i18n: string
  label: string
}

const props = defineProps<{
  modelValue: boolean
  docType?: DocType
  defaultMode?: ExportMode
  /** #146: PDF unless a caller asks for Excel — printing a document is the common case, and a
   * missing prop used to mean xlsx, so the Print dialog of every document form opened on Excel. */
  defaultFormat?: 'xlsx' | 'pdf'
  loading?: boolean
  /** Override the default "Export" title — invoice form views pass "Print" so the dialog
   * matches the action they expose. */
  title?: string
  /** Override the default mdi-download icon — invoice form views pass mdi-printer. */
  icon?: string
  /** Companion documents to offer. Omit (or pass an empty array) to hide the section. */
  companionDocs?: CompanionDocOption[]
  /** FR-03: offer the "aggregate by product" pivot (cash-register exports only). */
  showAggregate?: boolean
  /** Initial state of the aggregate checkbox when the dialog opens. */
  defaultAggregate?: boolean
  /**
   * The columns to open with instead of the mode's defaults — the user's last print (FR-22.20).
   * Keys the mode does not offer are ignored; none left means the defaults.
   */
  initialColumns?: string[]
  /**
   * Fold the column picker away, closed every time the dialog opens: its header then counts the columns
   * chosen and opens them. A document's Print dialog asks for it; a list export does not.
   */
  collapsibleColumns?: boolean
  /** What the confirming button says instead of "Download": the action it finishes („Издай и печатай"). */
  confirmLabel?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  confirm: [opts: { format: 'xlsx' | 'pdf'; mode: ExportMode; columns: string[]; companions: string[]; aggregated: boolean }]
}>()

const { t, te } = useI18n()

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const DEFAULT_FORMAT = 'pdf' as const
const format = ref<'xlsx' | 'pdf'>(props.defaultFormat || DEFAULT_FORMAT)
const mode = ref<ExportMode>(props.defaultMode || 'compact')
const selectedColumns = ref<string[]>([])
const selectedSet = computed(() => new Set(selectedColumns.value))
const selectedCompanions = ref<string[]>([])
const companionSet = computed(() => new Set(selectedCompanions.value))

const aggregated = ref(false)

/** The column picker shows; with `collapsibleColumns` it starts folded on every open. */
const columnsOpen = ref(!props.collapsibleColumns)
const columnsId = `export-columns-${useId()}`

const docType = computed<DocType>(() => props.docType || 'invoice')
const availableColumns = computed<ExportColumn[]>(() =>
  aggregated.value ? CASH_AGG_COLUMNS : filterColumns(mode.value, docType.value),
)

// Reset columns when the dialog opens or mode/docType/aggregate changes so stale
// selections from a previous export don't bleed in.
function resetSelection() {
  selectedColumns.value = aggregated.value
    ? CASH_AGG_COLUMNS.filter(c => c.defaultOn).map(c => c.key)
    : defaultSelection(mode.value, docType.value)
}

watch(() => props.modelValue, (open) => {
  if (open) {
    format.value = props.defaultFormat || DEFAULT_FORMAT
    mode.value = props.defaultMode || 'compact'
    aggregated.value = props.showAggregate ? (props.defaultAggregate ?? false) : false
    columnsOpen.value = !props.collapsibleColumns
    resetSelection()
    // Companion documents are opt-in on every print — never carried over from the last one.
    selectedCompanions.value = []
    if (props.initialColumns?.length) {
      const wanted = new Set(props.initialColumns)
      // After the mode watcher below has reset the selection for the mode just set.
      nextTick(() => {
        const cols = availableColumns.value.filter(c => wanted.has(c.key)).map(c => c.key)
        if (cols.length) selectedColumns.value = cols
      })
    }
  }
})
watch(mode, resetSelection)
watch(docType, resetSelection)
watch(aggregated, resetSelection)

function toggle(key: string, checked: boolean | null) {
  const next = new Set(selectedColumns.value)
  if (checked) next.add(key)
  else next.delete(key)
  // Preserve the column order defined by the catalog.
  selectedColumns.value = availableColumns.value.filter(c => next.has(c.key)).map(c => c.key)
}

function selectAll() {
  selectedColumns.value = availableColumns.value.map(c => c.key)
}
function selectNone() {
  selectedColumns.value = []
}

function toggleCompanion(key: string, checked: boolean | null) {
  const next = new Set(selectedCompanions.value)
  if (checked) next.add(key)
  else next.delete(key)
  // Preserve the order the caller declared them in.
  selectedCompanions.value = (props.companionDocs || []).filter(c => next.has(c.key)).map(c => c.key)
}

function labelFor(col: ExportColumn): string {
  // `te(key)` reports true only when the key resolves to a translated string — otherwise fall back.
  return te(col.i18n) ? t(col.i18n) : col.label
}

function companionLabel(cd: CompanionDocOption): string {
  return te(cd.i18n) ? t(cd.i18n) : cd.label
}

function onConfirm() {
  emit('confirm', {
    format: format.value,
    mode: mode.value,
    columns: [...selectedColumns.value],
    companions: [...selectedCompanions.value],
    aggregated: aggregated.value,
  })
}
</script>

<style scoped>
/* The folded column picker's header: a button that reads as the heading it replaces. */
.export-columns-toggle {
  background: none;
  border: 0;
  padding: 2px 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 4px;
}
.export-columns-toggle:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
</style>
