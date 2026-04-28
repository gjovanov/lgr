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

export interface ExportListOpts {
  columns?: string[]
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  locale?: string
}

export function useInvoicingExport(orgUrl: () => string) {
  const loading = ref(false)

  async function exportList(
    docType: DocType,
    format: ExportFormat,
    mode: ExportMode,
    extraFilters: Record<string, any> = {},
    opts: ExportListOpts = {},
  ): Promise<void> {
    loading.value = true
    try {
      const body: Record<string, any> = { docType, format, mode, ...extraFilters }
      if (opts.columns?.length) body.columns = opts.columns
      if (opts.sortBy) body.sortBy = opts.sortBy
      if (opts.sortOrder) body.sortOrder = opts.sortOrder
      if (opts.locale) body.locale = opts.locale
      const { data } = await httpClient.post(
        `${orgUrl()}/invoicing/export/list`,
        body,
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
    columns?: string[],
    locale?: string,
  ): Promise<void> {
    loading.value = true
    try {
      const params = new URLSearchParams({ format, mode })
      if (columns?.length) params.set('columns', columns.join(','))
      if (locale) params.set('locale', locale)
      const { data } = await httpClient.get(
        `${orgUrl()}/invoicing/export/${invoiceId}?${params.toString()}`,
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
