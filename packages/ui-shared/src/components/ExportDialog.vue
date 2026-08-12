<template>
  <v-dialog v-model="show" max-width="640">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">{{ icon || 'mdi-download' }}</v-icon>
        <span>{{ title || ($t ? $t('common.export') : 'Export') }}</span>
      </v-card-title>
      <v-card-text>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-radio-group v-model="format" :label="$t ? $t('common.format') : 'Format'" density="compact" inline hide-details>
              <v-radio label="Excel (.xlsx)" value="xlsx" />
              <v-radio label="PDF" value="pdf" />
            </v-radio-group>
          </v-col>
          <v-col cols="12" md="6">
            <v-radio-group v-model="mode" :label="$t ? $t('common.mode') : 'Mode'" density="compact" inline hide-details>
              <v-radio :label="$t ? $t('export.compact') : 'Compact'" value="compact" />
              <v-radio :label="$t ? $t('export.detailed') : 'Detailed'" value="detailed" />
            </v-radio-group>
          </v-col>
        </v-row>

        <div class="text-caption text-medium-emphasis mt-2 mb-2">
          <span v-if="mode === 'compact'">{{ $t ? $t('export.compactHint') : 'One row per document, summary columns.' }}</span>
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

        <div class="d-flex align-center mb-1">
          <strong>{{ $t ? $t('export.columns') : 'Columns' }}</strong>
          <v-spacer />
          <v-btn size="x-small" variant="text" @click="selectAll">
            {{ $t ? $t('common.selectAll') : 'Select all' }}
          </v-btn>
          <v-btn size="x-small" variant="text" @click="selectNone">
            {{ $t ? $t('common.selectNone') : 'Clear' }}
          </v-btn>
        </div>

        <v-row dense>
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
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="show = false" :disabled="loading">{{ $t ? $t('common.cancel') : 'Cancel' }}</v-btn>
        <v-btn color="primary" :loading="loading" :disabled="!selectedColumns.length" @click="onConfirm">
          {{ $t ? $t('common.download') : 'Download' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  filterColumns,
  defaultSelection,
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
  defaultFormat?: 'xlsx' | 'pdf'
  loading?: boolean
  /** Override the default "Export" title — invoice form views pass "Print" so the dialog
   * matches the action they expose. */
  title?: string
  /** Override the default mdi-download icon — invoice form views pass mdi-printer. */
  icon?: string
  /** Companion documents to offer. Omit (or pass an empty array) to hide the section. */
  companionDocs?: CompanionDocOption[]
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  confirm: [opts: { format: 'xlsx' | 'pdf'; mode: ExportMode; columns: string[]; companions: string[] }]
}>()

const { t, te } = useI18n()

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const format = ref<'xlsx' | 'pdf'>(props.defaultFormat || 'xlsx')
const mode = ref<ExportMode>(props.defaultMode || 'compact')
const selectedColumns = ref<string[]>([])
const selectedSet = computed(() => new Set(selectedColumns.value))
const selectedCompanions = ref<string[]>([])
const companionSet = computed(() => new Set(selectedCompanions.value))

const docType = computed<DocType>(() => props.docType || 'invoice')
const availableColumns = computed<ExportColumn[]>(() => filterColumns(mode.value, docType.value))

// Reset columns when the dialog opens or mode/docType changes so stale selections
// from a previous export don't bleed in.
function resetSelection() {
  selectedColumns.value = defaultSelection(mode.value, docType.value)
}

watch(() => props.modelValue, (open) => {
  if (open) {
    format.value = props.defaultFormat || 'xlsx'
    mode.value = props.defaultMode || 'compact'
    resetSelection()
    // Companion documents are opt-in on every print — never carried over from the last one.
    selectedCompanions.value = []
  }
})
watch(mode, resetSelection)
watch(docType, resetSelection)

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
  })
}
</script>
