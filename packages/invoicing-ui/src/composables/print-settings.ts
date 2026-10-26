import { rememberedSetting } from 'ui-shared/composables/useUserDefaults'
import { defaultSelection, type ExportMode } from 'ui-shared/composables/useExportColumns'

/**
 * FR-22.20: where a print starts — the user's last print settings, per user and org
 * (`lgr:doc-print:<user>:<org>`): the document form's „Печат" and a list row's „Печат" alike. Until
 * the user prints otherwise it is what the print dialog starts with: a PDF of the detailed form with
 * its default columns. The companion documents are never carried over: each is a numbered document
 * of its own, printed only when asked for.
 */
export interface PrintSettings {
  format: 'pdf' | 'xlsx'
  mode: ExportMode
  columns: string[]
}

const store = rememberedSetting<PrintSettings>('doc-print')

export function readPrintSettings(): PrintSettings {
  const s = store.read()
  const mode: ExportMode = s?.mode === 'compact' ? 'compact' : 'detailed'
  const columns = Array.isArray(s?.columns) ? s!.columns.filter((c) => typeof c === 'string') : []
  return {
    format: s?.format === 'xlsx' ? 'xlsx' : 'pdf',
    mode,
    columns: columns.length ? columns : defaultSelection(mode, 'invoice'),
  }
}

export function writePrintSettings(settings: PrintSettings): void {
  store.write(settings)
}
