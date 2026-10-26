import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { useAppStore } from '../store/app.store'
import { readPrintSettings } from './print-settings'

/**
 * FR-22.24 — „Печат" in a list row: the document in one click, with the user's last print settings
 * — the very file the document form's „Печат" produces. A draft prints marked ЧЕРНОВА, without its
 * DRF- number (FR-22.18).
 */
export function useRowPrint() {
  const { t } = useI18n()
  const appStore = useAppStore()
  const { showSuccess, showError } = useSnackbar()
  const { loading: printing, exportOne } = useInvoicingExport(() => appStore.orgUrl())

  async function printRow(item: { _id: string; number?: string; invoiceNumber?: string }) {
    const s = readPrintSettings()
    try {
      await exportOne(item._id, item.number || item.invoiceNumber || item._id, s.format, s.mode, s.columns, appStore.locale)
      showSuccess(t('export.success'))
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    }
  }

  return { printing, printRow }
}
