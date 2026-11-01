<template>
  <div>
    <!-- Filter bar, built from the registry's `params` (FR-6.9) -->
    <v-card v-if="meta.params.length" variant="outlined" class="mb-4">
      <v-card-text>
        <v-row dense align="center">
          <template v-for="p in meta.params" :key="p.key">
            <!-- period: preset picker, with a from/to pair revealed for `custom` -->
            <template v-if="p.type === 'period'">
              <v-col cols="12" md="3">
                <v-select
                  :model-value="periodOf(p.key).preset"
                  :items="periodPresetItems"
                  item-title="title"
                  item-value="value"
                  :label="$t(p.labelKey)"
                  hide-details
                  density="compact"
                  @update:model-value="setPeriodField(p.key, 'preset', $event)"
                />
              </v-col>
              <template v-if="periodOf(p.key).preset === 'custom'">
                <v-col cols="12" md="2">
                  <DateField
                    :model-value="periodOf(p.key).from"
                    :label="$t('invoicing.dateFrom')"
                    hide-details
                    density="compact"
                    @update:model-value="setPeriodField(p.key, 'from', $event)"
                  />
                </v-col>
                <v-col cols="12" md="2">
                  <DateField
                    :model-value="periodOf(p.key).to"
                    :label="$t('invoicing.dateTo')"
                    hide-details
                    density="compact"
                    @update:model-value="setPeriodField(p.key, 'to', $event)"
                  />
                </v-col>
              </template>
            </template>

            <v-col v-else cols="12" md="3">
              <ReportParamField v-model="values[p.key]" :def="p" :siblings="values" />
            </v-col>
          </template>

          <v-col cols="12" sm="auto">
            <v-btn
              color="primary"
              prepend-icon="mdi-play"
              :loading="loading"
              :disabled="missingRequired.length > 0"
              @click="run"
            >
              {{ $t('reports.runner.run') }}
            </v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- A report with a required entity param (the two ledgers) has nothing to show until it
         is chosen — say which one, instead of auto-running into a 422. -->
    <v-alert v-if="missingRequired.length" type="info" variant="tonal" density="compact" class="mb-3">
      {{ $t('reports.runner.chooseRequired', { params: missingRequired.map(p => $t(p.labelKey)).join(', ') }) }}
    </v-alert>

    <!-- FR-6.15: an explicit "narrow it down", never a silent truncation -->
    <v-alert v-if="result?.meta?.truncated" type="info" variant="tonal" density="compact" class="mb-3">
      {{ $t('reports.runner.truncated', { cap: result.meta.cap }) }}
    </v-alert>

    <!-- FR-8.7 „Обобщение" — the reconciliation block. Generic: any report whose meta
         carries a `summary` array gets it, keyed off the same per-currency shape. -->
    <v-row v-if="summary.length" dense class="mb-3">
      <v-col v-for="s in summary" :key="s.currency" cols="12" :md="summary.length > 1 ? 6 : 12">
        <v-card variant="tonal" color="primary">
          <v-card-text class="d-flex flex-wrap ga-6 align-center py-3">
            <div>
              <div class="text-caption text-medium-emphasis">{{ $t('reports.summary.operations') }}</div>
              <div class="text-h6">{{ s.count }}</div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">{{ $t('reports.summary.systemSales') }}</div>
              <div class="text-h6">{{ money(s.total, s.currency) }}</div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">{{ $t('reports.summary.expectedCash') }}</div>
              <div class="text-h6">{{ money(s.cash, s.currency) }}</div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">{{ $t('reports.summary.cardPayments') }}</div>
              <div class="text-h6">{{ money(s.card, s.currency) }}</div>
            </div>
            <div v-if="s.other">
              <div class="text-caption text-medium-emphasis">{{ $t('reports.summary.otherPayments') }}</div>
              <div class="text-h6">{{ money(s.other, s.currency) }}</div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Rows imported as a whole-day aggregate carry no time of day; say so rather than
         leaving an unexplained blank column. -->
    <v-alert
      v-if="result?.meta?.rowsWithoutTime"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-3"
    >
      {{ $t('reports.runner.noTimeFootnote', { n: result.meta.rowsWithoutTime }) }}
    </v-alert>

    <v-card>
      <v-card-text>
        <div class="d-flex align-center mb-2">
          <span class="text-body-2 text-medium-emphasis">{{ rows.length }} {{ $t('common.results') }}</span>
          <v-spacer />
          <v-btn
            v-if="exportFormats.length"
            color="primary"
            variant="flat"
            prepend-icon="mdi-download"
            :disabled="!rows.length"
            :loading="exportLoading"
            @click="exportDialog = true"
          >
            {{ $t('common.export') }}
          </v-btn>
          <!-- FR-7.9 / FR-8.9: column settings act on the run that is already on screen —
               hiding or reordering never refetches. Same composable (and storage key shape)
               as every ListScaffold grid; the runner is not built on ListScaffold, so it
               wires it up itself. -->
          <v-btn
            icon="mdi-cog"
            size="x-small"
            variant="text"
            class="ml-1"
            :color="colsCustomized ? 'primary' : undefined"
            :title="$t('grid.columns')"
            :aria-label="$t('grid.columns')"
            @click="colDialogOpen = true"
          />
        </div>

        <GridColumnPickerDialog
          v-model="colDialogOpen"
          :entries="colEntries"
          @toggle="toggleCol"
          @reorder="reorderCols"
          @reset="resetCols"
        />

        <v-data-table :headers="effectiveHeaders" :items="rows" :loading="loading" density="compact" :items-per-page="25" hover>
          <template v-for="col in visibleColumns" :key="col.key" #[`item.${col.key}`]="{ item }">
            <entity-link
              v-if="col.key === firstColumnKey && drilldownHref(item)"
              :label="String(item[col.key] ?? '')"
              :href="drilldownHref(item)"
            />
            <span v-else>{{ formatCell(item[col.key], col.type) }}</span>
          </template>

          <template v-if="result?.totals" #body.append>
            <tr class="font-weight-bold totals-row">
              <td v-for="(col, i) in visibleColumns" :key="col.key" :class="col.align === 'end' ? 'text-end' : ''">
                <template v-if="i === 0">{{ $t('common.total') }}</template>
                <template v-else-if="result.totals[col.key] !== undefined">
                  {{ formatCell(result.totals[col.key], col.type) }}
                </template>
              </td>
            </tr>
          </template>

          <template #no-data>
            <EmptyState
              icon="mdi-file-search-outline"
              :title="$t('list.noMatches')"
              :description="$t('list.adjustFilters')"
            />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>

    <!-- Format picker only — the column cog above already decides WHICH columns go in, and
         the export follows it. What the dialog owes the user is the other half: what the two
         formats are for, and what is actually about to land in the file. -->
    <v-dialog v-model="exportDialog" max-width="560">
      <v-card>
        <v-card-title class="d-flex align-center pt-4">
          <v-icon class="mr-3">mdi-download</v-icon>
          <div class="d-flex flex-column">
            <span>{{ $t('common.export') }}</span>
            <span class="text-caption text-medium-emphasis">{{ $t(meta.labelKey) }}</span>
          </div>
        </v-card-title>

        <v-card-text>
          <div class="text-body-2 font-weight-medium mb-2">{{ $t('common.format') }}</div>

          <!-- Cards rather than bare radios: the choice is between two different documents,
               and the difference is worth a sentence each. role=radio keeps it announced as
               the single choice it is. -->
          <v-row dense role="radiogroup" :aria-label="$t('common.format')">
            <v-col v-for="f in exportFormats" :key="f" cols="12" sm="6">
              <v-card
                :variant="exportFormat === f ? 'tonal' : 'outlined'"
                :color="exportFormat === f ? 'primary' : undefined"
                class="pa-3 h-100 format-card"
                role="radio"
                :aria-checked="exportFormat === f"
                tabindex="0"
                @click="exportFormat = f"
                @keydown.enter.prevent="exportFormat = f"
                @keydown.space.prevent="exportFormat = f"
              >
                <div class="d-flex align-center mb-1">
                  <v-icon size="small" class="mr-2">
                    {{ f === 'xlsx' ? 'mdi-file-excel-outline' : 'mdi-file-pdf-box' }}
                  </v-icon>
                  <span class="text-body-2 font-weight-medium">
                    {{ f === 'xlsx' ? 'Excel (.xlsx)' : 'PDF' }}
                  </span>
                  <v-spacer />
                  <v-icon v-if="exportFormat === f" size="small">mdi-check-circle</v-icon>
                </div>
                <div class="text-caption text-medium-emphasis">
                  {{ f === 'xlsx' ? $t('reports.exportDialog.xlsxHint') : $t('reports.exportDialog.pdfHint') }}
                </div>
              </v-card>
            </v-col>
          </v-row>

          <v-divider class="my-3" />

          <!-- What is about to be in the file. The column line matters because the cog can
               hide columns; the row line because a capped TABLE is not a capped FILE. -->
          <div class="d-flex align-center text-caption text-medium-emphasis mb-1">
            <v-icon size="x-small" class="mr-2">mdi-table-column</v-icon>
            {{ $t('reports.exportDialog.columnsNote', { n: visibleColumns.length, total: columns.length }) }}
          </div>
          <div class="d-flex align-center text-caption text-medium-emphasis">
            <v-icon size="x-small" class="mr-2">mdi-table-row</v-icon>
            <span v-if="exportRowCap && result?.meta?.truncated">
              {{ $t('reports.exportDialog.moreRowsNote', { cap: result.meta.cap, max: exportRowCap }) }}
            </span>
            <span v-else>{{ $t('reports.exportDialog.rowsNote', { n: rows.length }) }}</span>
          </div>
        </v-card-text>

        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn variant="text" :disabled="exportLoading" @click="exportDialog = false">
            {{ $t('common.cancel') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-download"
            :loading="exportLoading"
            @click="doExport"
          >
            {{ $t('common.export') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useListQueryState, type QueryParamDef } from 'ui-shared/composables/useListQueryState'
import { useGridColumns } from 'ui-shared/composables/useGridColumns'
import { decodeBlobError } from 'ui-shared/composables/useInvoicingExport'
import GridColumnPickerDialog from 'ui-shared/components/GridColumnPickerDialog.vue'
import DateField from 'ui-shared/components/DateField.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import EmptyState from 'ui-shared/components/EmptyState.vue'
import ReportParamField from './ReportParamField.vue'
import { appHref } from 'ui-shared/nav/navigate'
import { useAppStore } from '../store/app.store'
import { PERIOD_PRESETS, type ReportMeta, type ReportRunResult, type ColumnType, type PeriodValue } from '../types/report'

/**
 * FR-6.9 — the generic report runner. It knows nothing about any individual report: the
 * filter bar is built from `params`, the grid from the run response's `columns`, and the
 * export offer from `outputs`. FR-07/FR-08 land as registry entries and render here without
 * a line of code in this file.
 *
 * Its parent mounts it only once `meta` is known, so the URL binding below can be declared
 * in setup, where `useListQueryState` needs to live.
 */

const props = defineProps<{ meta: ReportMeta }>()

const { t, te } = useI18n()

/** A document status in the user's words; an unknown one as it came. */
function statusLabel(value: string): string {
  return te(`invoicing.status.${value}`) ? t(`invoicing.status.${value}`) : value
}
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const loading = ref(false)
const result = ref<ReportRunResult | null>(null)

/** Flat param values; a `period` param's value is a `PeriodValue` object. */
const values = ref<Record<string, any>>({})

const exportDialog = ref(false)
const exportLoading = ref(false)
const exportFormat = ref<'xlsx' | 'pdf'>('xlsx')

const columns = computed(() => result.value?.columns || [])
const rows = computed(() => result.value?.rows || [])
const exportFormats = computed(() =>
  props.meta.outputs.filter((o): o is 'xlsx' | 'pdf' => o === 'xlsx' || o === 'pdf'),
)

const headers = computed(() =>
  columns.value.map(c => ({
    title: t(c.labelKey),
    key: c.key,
    align: (c.align || (c.type && c.type !== 'text' && c.type !== 'date' ? 'end' : 'start')) as 'start' | 'end' | 'center',
    sortable: true,
  })),
)

// ── Per-user column visibility + order (FR-7.9 / FR-8.9) ──────────────────────
// Keyed per REPORT, not per route: the runner serves every registry entry from one
// route, so a shared key would let one report's hidden columns follow the user into
// another whose column set is unrelated.
const colDialogOpen = ref(false)
const {
  effectiveHeaders,
  entries: colEntries,
  toggle: toggleCol,
  reorder: reorderCols,
  reset: resetCols,
  customized: colsCustomized,
} = useGridColumns({ headers, gridId: () => `reports:${props.meta.id}` })

/**
 * The registry column defs behind `effectiveHeaders`, in the user's order — the cell
 * renderers, the totals row and the export all follow the visible set, so what is on
 * paper is what is on screen.
 */
const visibleColumns = computed(() => {
  const byKey = new Map(columns.value.map(c => [c.key, c]))
  return effectiveHeaders.value
    .map((h: any) => byKey.get(h?.key))
    .filter((c): c is (typeof columns.value)[number] => !!c)
})

/** Drill-down anchors on the first VISIBLE column, so hiding one never hides the link. */
const firstColumnKey = computed(() => visibleColumns.value[0]?.key)

const periodPresetItems = computed(() =>
  PERIOD_PRESETS.map(p => ({ value: p, title: t(`reports.periods.${p}`) })),
)

/**
 * Required params with no value yet. A period always resolves (it has a preset), so in
 * practice this is the contact/product a ledger cannot be run without.
 */
const missingRequired = computed(() =>
  props.meta.params.filter(p => p.required && p.type !== 'period' && !values.value[p.key]),
)

/** Row cap the chosen format's export runs under — bigger than the table's (FR-6.15). */
const exportRowCap = computed(() => result.value?.meta?.exportCaps?.[exportFormat.value])

/** Per-currency reconciliation lines, when the handler produced any (FR-8.7). */
const summary = computed<any[]>(() => (result.value?.meta as any)?.summary || [])

/**
 * The non-default filters this run used, localized, for the exported PDF's header block —
 * so a report someone shares says what it is a report OF.
 *
 * Entity params carry ids, which mean nothing on paper; the picker's chosen label is not
 * available here, so they are reported by presence only where a raw id would be noise.
 */
const activeFilterMeta = computed(() => {
  const out: { label: string; value: string }[] = []
  for (const p of props.meta.params) {
    const v = values.value[p.key]
    if (v === undefined || v === null || v === '' || p.type === 'period') continue
    if (Array.isArray(v)) {
      if (!v.length) continue
      const labels = v.map(val => {
        const opt = (p.options || []).find(o => o.value === val)
        return opt ? t(opt.labelKey) : String(val)
      })
      out.push({ label: t(p.labelKey), value: labels.join(', ') })
    } else if (p.type === 'select') {
      const opt = (p.options || []).find(o => o.value === v)
      out.push({ label: t(p.labelKey), value: opt ? t(opt.labelKey) : String(v) })
    } else if (p.type === 'bool') {
      if (v === true) out.push({ label: t(p.labelKey), value: t('common.yes') })
    } else if (p.type === 'text' || p.type === 'date') {
      out.push({ label: t(p.labelKey), value: String(v) })
    }
    // Entity ids are deliberately omitted — "Warehouse: 6a8d…bbcd" helps nobody.
  }
  return out
})

function money(value: number, currency: string): string {
  const tag = NUMBER_LOCALE[appStore.locale] || 'en-US'
  try {
    return new Intl.NumberFormat(tag, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value || 0)
  } catch {
    return `${(value || 0).toFixed(2)} ${currency}`
  }
}

// ── period params ──
// Presets resolve to dates SERVER-side — it never trusts the client's arithmetic — so the
// UI carries the preset plus, for `custom`, the explicit bounds.
function periodOf(key: string): PeriodValue {
  const v = values.value[key]
  return (v && typeof v === 'object' ? v : {}) as PeriodValue
}
function setPeriodField(key: string, field: keyof PeriodValue, value: any) {
  values.value[key] = { ...periodOf(key), [field]: value || undefined }
}

// ── URL sync (FR-05 / FR-6.9: a configured report is a shareable link) ──
// Declared in setup, before the first run. A `period` param spans three scalar keys, since
// useListQueryState's codecs are scalar.
;(() => {
  const defs: QueryParamDef[] = []
  for (const p of props.meta.params) {
    if (p.type === 'period') {
      const dflt = (p.default || {}) as PeriodValue
      values.value[p.key] = { preset: dflt.preset || 'this_month', from: dflt.from, to: dflt.to }
      defs.push(
        { key: `${p.key}Preset`, ref: periodField(p.key, 'preset'), default: dflt.preset || 'this_month' },
        { key: `${p.key}From`, ref: periodField(p.key, 'from'), codec: 'date' },
        { key: `${p.key}To`, ref: periodField(p.key, 'to'), codec: 'date' },
      )
    } else {
      if (p.default !== undefined) values.value[p.key] = p.default
      defs.push({
        key: p.key,
        ref: scalarField(p.key),
        // multiselect round-trips as a comma-joined list, which is also the form the
        // server's validateParams accepts.
        codec: p.type === 'bool' ? 'bool' : p.type === 'multiselect' ? 'csv' : 'string',
        default: p.default,
      })
    }
  }
  // Hydration happens inside useListQueryState, synchronously — so the mount-time run below
  // already uses whatever the shared link carried.
  if (defs.length) useListQueryState(defs)
})()

function scalarField(key: string) {
  return computed({
    get: () => values.value[key],
    set: (v: any) => { values.value[key] = v },
  })
}
function periodField(key: string, field: keyof PeriodValue) {
  return computed({
    get: () => periodOf(key)[field],
    set: (v: any) => { values.value[key] = { ...periodOf(key), [field]: v } },
  })
}

const NUMBER_LOCALE: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }

function formatCell(value: any, type: ColumnType | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const tag = NUMBER_LOCALE[appStore.locale] || 'en-US'
  switch (type) {
    case 'money':
      return new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0)
    case 'quantity':
      return new Intl.NumberFormat(tag, { maximumFractionDigits: 3 }).format(Number(value) || 0)
    case 'percent':
      return `${new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(Number(value) || 0)}%`
    case 'int':
      return String(Math.round(Number(value) || 0))
    case 'date':
      return String(value).split('T')[0]
    case 'status':
      return statusLabel(String(value))
    default:
      return String(value)
  }
}

/**
 * FR-6.10 — drill-down. The registry's `drilldown` is a server-side function, so the row
 * carries the id and the runner builds the href here. Cross-app links MUST be hrefs, never
 * route names: each domain UI is a separate SPA and Vue Router cannot cross them.
 */
function drilldownHref(row: Record<string, any>): string | undefined {
  // A report whose registry entry has a rule gets it resolved per row by the server (`_href`):
  // a cash sale opens on its own page and a bill on the bill form, which the fallback below
  // cannot tell apart. Null means the rule names no page for this row.
  if ('_href' in row) return row._href ? appHref(String(row._href).split('/')[1], row._href) : undefined
  // Most specific id wins: a sales-history POS row and a warehouse-operations document row
  // both also carry a productId, and the source document is the more useful target.
  if (row.posId) return appHref('pos', `/invoicing/pos/orders/${row.posId}`)
  if (row.invoiceId) return appHref('invoicing', `/invoicing/invoices/${row.invoiceId}/edit`)
  if (row.productId) return appHref('inventory', `/inventory/products/${row.productId}/edit`)
  if (row.contactId && row.contactId !== 'unknown') return appHref('invoicing', `/invoicing/contacts/${row.contactId}/edit`)
  return undefined
}

async function run() {
  loading.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/reports/${props.meta.id}/run`, {
      params: values.value,
      locale: appStore.locale,
    })
    result.value = data
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
    result.value = null
  } finally {
    loading.value = false
  }
}

async function doExport() {
  exportLoading.value = true
  try {
    // Headers are localized here: the registry names columns by i18n key, and the message
    // catalogue that resolves them lives in the UI.
    // …and only the columns the user actually has on screen, in their order.
    const labels: Record<string, string> = {}
    for (const c of visibleColumns.value) labels[c.key] = t(c.labelKey)
    // …and so are the statuses, the values the user reads on screen in their own words.
    const valueLabels: Record<string, Record<string, string>> = {}
    for (const c of visibleColumns.value.filter(col => col.type === 'status')) {
      const seen = new Set((result.value?.rows || []).map(r => r[c.key]).filter(v => typeof v === 'string'))
      valueLabels[c.key] = Object.fromEntries([...seen].map(v => [v, statusLabel(v)]))
    }

    const res = await httpClient.post(
      `${appStore.orgUrl()}/reports/${props.meta.id}/export`,
      {
        format: exportFormat.value,
        params: values.value,
        columns: visibleColumns.value.map(c => c.key),
        labels,
        valueLabels,
        title: t(props.meta.labelKey),
        totalsLabel: t('common.total'),
        // The PDF's header block is localized here for the same reason the column headers
        // are: the message catalogue lives in the UI, not in the renderer.
        labels_meta: {
          period: t('reports.params.period'),
          generated: t('reports.pdf.generated'),
          rows: t('reports.pdf.rows'),
          noRows: t('list.noMatches'),
          mixedCurrency: t('reports.pdf.mixedCurrency'),
        },
        summaryLabels: {
          operations: t('reports.summary.operations'),
          systemSales: t('reports.summary.systemSales'),
          expectedCash: t('reports.summary.expectedCash'),
          cardPayments: t('reports.summary.cardPayments'),
          otherPayments: t('reports.summary.otherPayments'),
        },
        meta: activeFilterMeta.value,
        locale: appStore.locale,
      },
      { responseType: 'blob' },
    )

    const blob = new Blob([res.data], { type: res.headers['content-type'] })
    const dispo = res.headers['content-disposition'] as string | undefined
    const filename = dispo?.match(/filename="([^"]+)"/)?.[1] || `${props.meta.id}.${exportFormat.value}`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    link.click()
    URL.revokeObjectURL(link.href)
    showSuccess(t('common.downloadStarted'))
    exportDialog.value = false
  } catch (e: any) {
    // Server errors arrive as a Blob of JSON under responseType:'blob' — decode in place.
    await decodeBlobError(e).catch(() => {})
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    exportLoading.value = false
  }
}

watch(exportFormats, (formats) => {
  if (formats.length && !formats.includes(exportFormat.value)) exportFormat.value = formats[0]
}, { immediate: true })

// Each ReportParamField loads its own options, so the runner just runs — unless a required
// entity param is still empty, in which case running would only produce a 422.
onMounted(() => {
  if (!missingRequired.value.length) run()
})
</script>

<style scoped>
.totals-row {
  border-top: 2px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant), 0.06);
}

/* The whole card is the hit target, so it has to look like one. */
.format-card {
  cursor: pointer;
}
.format-card:hover {
  border-color: rgb(var(--v-theme-primary));
}
.format-card:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
</style>
