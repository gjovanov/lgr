/**
 * FR-32.22 (#797): printing the document — the Print dialog's state, the user's last print settings, and the print
 * itself with its companion documents. What starts a print (the buttons, the Print dialog's answer, „Издай и
 * печатай") is `useDocumentForm`'s.
 */
import { ref } from 'vue'
import { useInvoicingExport, type CompanionDoc } from 'ui-shared/composables/useInvoicingExport'
import { readPrintSettings, writePrintSettings, type PrintSettings } from '../../print-settings'
import type { PrintChoice } from '../types'
import type { FormState } from './state'

export function useFormPrint(s: FormState) {
  const { t, route, appStore, showSuccess, showError, invoiceNumber, printNote } = s

  // ── export ──
  const showExportDialog = ref(false)
  const { loading: exportLoading, exportOne } = useInvoicingExport(() => appStore.orgUrl())

  /** FR-22.20: where a print starts — the user's last print settings (`../print-settings`). */
  const lastPrint = ref<PrintSettings>(readPrintSettings())

  async function onExportSingle(o: PrintChoice) {
    const id = route.params.id as string
    if (!id) return
    const base = invoiceNumber.value || id
    // The document itself, then one file per ticked companion. Sequential so the browser
    // treats them as user-initiated downloads rather than a popup burst.
    const jobs: Array<{ name: string; doc?: CompanionDoc }> = [{ name: base }]
    for (const c of o.companions || []) {
      jobs.push({ name: `${base}-${c}`, doc: c as CompanionDoc })
    }
    try {
      for (const job of jobs) {
        // The note belongs to the document itself; companion forms have their own layout.
        await exportOne(id, job.name, o.format, o.mode, o.columns, appStore.locale, job.doc, job.doc ? undefined : printNote.value)
      }
      showExportDialog.value = false
      showSuccess(t('export.success'))
      // What the user printed with is where the next print starts.
      const settings: PrintSettings = { format: o.format, mode: o.mode, columns: o.columns?.length ? [...o.columns] : lastPrint.value.columns }
      lastPrint.value = settings
      writePrintSettings(settings)
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    }
  }

  return { showExportDialog, exportLoading, lastPrint, onExportSingle }
}

export type FormPrint = ReturnType<typeof useFormPrint>
