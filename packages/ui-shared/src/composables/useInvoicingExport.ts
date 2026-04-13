import { ref } from 'vue'
import { httpClient } from './useHttpClient'

export type ExportFormat = 'xlsx' | 'pdf'
export type ExportMode = 'compact' | 'detailed'
export type DocType = 'invoice' | 'proforma' | 'credit_note' | 'debit_note' | 'cash_sale' | 'bill'

const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function defaultFilename(docType: DocType, mode: ExportMode, format: ExportFormat): string {
  const date = new Date().toISOString().split('T')[0]
  return `${docType}-${mode}-${date}.${format}`
}

export function useInvoicingExport(orgUrl: () => string) {
  const loading = ref(false)

  async function exportList(
    docType: DocType,
    format: ExportFormat,
    mode: ExportMode,
    extraFilters: Record<string, any> = {},
  ): Promise<void> {
    loading.value = true
    try {
      const { data } = await httpClient.post(
        `${orgUrl()}/invoicing/export/list`,
        { docType, format, mode, ...extraFilters },
        { responseType: 'blob' },
      )
      const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[format] })
      triggerBlobDownload(blob, defaultFilename(docType, mode, format))
    } finally {
      loading.value = false
    }
  }

  async function exportOne(
    invoiceId: string,
    invoiceNumber: string,
    format: ExportFormat,
    mode: ExportMode = 'detailed',
  ): Promise<void> {
    loading.value = true
    try {
      const { data } = await httpClient.get(
        `${orgUrl()}/invoicing/export/${invoiceId}?format=${format}&mode=${mode}`,
        { responseType: 'blob' },
      )
      const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[format] })
      triggerBlobDownload(blob, `${invoiceNumber}.${format}`)
    } finally {
      loading.value = false
    }
  }

  return { loading, exportList, exportOne }
}
