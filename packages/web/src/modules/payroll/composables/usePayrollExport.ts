import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { decodeBlobError, triggerBlobDownload } from 'ui-shared/composables/useInvoicingExport'
import { filenameFromDisposition } from 'ui-shared/composables/useSessionDownload'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'
import { payrollExportPath, type ExportFormat, type PayrollList } from './payroll-export'

/**
 * #830: a payroll list's Export. It sends the list's filters and order as they are on the screen, and the screen's
 * words for the file (`labels`: the title, the column headings, the header block of a PDF). The file is fetched as
 * this tab's session (`downloadAsSession`'s rule: never a plain link to the API), and one the export cap cut says so.
 */
export function usePayrollExport(
  list: PayrollList,
  opts: {
    filters: { readonly value: Record<string, unknown> }
    pagination: { readonly value: { sortBy?: string; sortOrder?: 'asc' | 'desc' } }
    labels: () => Record<string, unknown>
  },
) {
  const { t, locale } = useI18n()
  const appStore = useAppStore()
  const { showError, showSuccess } = useSnackbar()
  const exporting = ref(false)

  /** The header block's words, shared by every list (the report exports' own). */
  const meta = () => ({
    period: t('payroll.period'),
    generated: t('reports.pdf.generated'),
    rows: t('reports.pdf.rows'),
    noRows: t('list.noMatches'),
  })

  async function exportList(format: ExportFormat) {
    exporting.value = true
    try {
      const path = payrollExportPath(appStore.orgUrl(), list, {
        filters: opts.filters.value,
        sortBy: opts.pagination.value.sortBy,
        sortOrder: opts.pagination.value.sortOrder,
        format,
        locale: String(locale.value),
        labels: { meta: meta(), totals: t('common.total'), ...opts.labels() },
      })
      const res = await httpClient.get(path, { responseType: 'blob' }).catch(decodeBlobError)
      triggerBlobDownload(res.data, filenameFromDisposition(res.headers['content-disposition']) || `${list}.${format}`)
      const cut = res.headers['x-truncated']
      if (cut) showSuccess(t('payroll.exportTruncated', { n: cut }))
    } catch (e: any) {
      showError(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      exporting.value = false
    }
  }

  return { exporting, exportList }
}
