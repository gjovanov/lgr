import { ref } from 'vue'
import { httpClient } from './useHttpClient'

export type ExportFormat = 'xlsx' | 'pdf'
export type ExportMode = 'compact' | 'detailed'
export type DocType = 'invoice' | 'proforma' | 'credit_note' | 'debit_note' | 'cash_sale' | 'bill'
/** Extra documents printable alongside an outgoing document, each rendered as its own file. */
export type CompanionDoc = 'certificate' | 'ppprotocol'
/** What `exportOne` can render instead of the document itself: a companion, or a bill's „Стокова разписка". */
export type PrintDoc = CompanionDoc | 'stock_receipt'

const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

export function triggerBlobDownload(blob: Blob, filename: string) {
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

/**
 * Under responseType:'blob' server errors arrive as a Blob of JSON, so callers reading
 * e.response.data.message see undefined. Decode in place, then rethrow.
 */
export async function decodeBlobError(e: any): Promise<never> {
  const data = e?.response?.data
  if (data instanceof Blob) {
    try {
      e.response.data = JSON.parse(await data.text())
    } catch {
      // not JSON — leave the original blob in place
    }
  }
  throw e
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
    } catch (e: any) {
      await decodeBlobError(e)
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
    /** A companion document (or a bill's stock receipt) to render instead of the document itself. */
    doc?: PrintDoc,
    /**
     * Free text for this print only, printed under the number block. Not stored on the
     * document — it travels with the request and is forgotten afterwards.
     */
    note?: string,
  ): Promise<void> {
    loading.value = true
    try {
      const params = new URLSearchParams({ format, mode })
      if (columns?.length) params.set('columns', columns.join(','))
      if (locale) params.set('locale', locale)
      if (doc) params.set('doc', doc)
      if (note?.trim()) params.set('note', note.trim())
      const { data } = await httpClient.get(
        `${orgUrl()}/invoicing/export/${invoiceId}?${params.toString()}`,
        { responseType: 'blob' },
      )
      const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[format] })
      triggerBlobDownload(blob, `${invoiceNumber}.${format}`)
    } catch (e: any) {
      await decodeBlobError(e)
    } finally {
      loading.value = false
    }
  }

  return { loading, exportList, exportOne }
}
