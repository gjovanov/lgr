import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from './useHttpClient'
import { useSearchDebounce } from './useSearchDebounce'

/** A stock movement as a ledger row names it. */
export interface ContactLedgerMovement {
  id: string
  number: string
  /** receipt, dispatch, transfer, adjustment, return… */
  type: string
  /** The source document it was booked from, when it names one. */
  reference?: string
}

export interface ContactLedgerEntry {
  date: string
  /** Empty on a stock movement's own row: it has no document. */
  documentNumber: string
  /** The document's id; on a stock movement's own row, the movement's. */
  documentId: string
  /** A document's type, or `stock_movement`: a movement of the contact's that no document carries. */
  documentType: string
  /** On a `stock_movement` row: what the movement is. */
  movementType?: string
  /** The stock movements behind the row: those that moved a document line's goods, or the movement itself. */
  movements?: ContactLedgerMovement[]
  productId?: string
  productName?: string
  quantity: number
  /** On a `stock_movement` row: its unit cost, which a role without the cost figures is not sent. */
  unitPrice?: number
  taxRate?: number
  warehouseId?: string
  warehouseName?: string
  lineTotal?: number
}

/** The type the ledger lists a stock movement no document carries under (the server's `STOCK_MOVEMENT_TYPE`). */
export const STOCK_MOVEMENT_TYPE = 'stock_movement'

/** A row that is a stock movement itself, not a document's line. */
export function isMovementRow(entry: Pick<ContactLedgerEntry, 'documentType'> | null | undefined): boolean {
  return entry?.documentType === STOCK_MOVEMENT_TYPE
}

export function useContactLedger(contactId: Ref<string>, orgUrl: Ref<string>) {
  const { t } = useI18n()

  const loading = ref(false)
  const entries = ref<ContactLedgerEntry[]>([])
  const total = ref(0)
  const page = ref(0)
  const pageSize = ref(25)
  const dateFrom = ref('')
  const dateTo = ref('')
  const docTypes = ref<string[]>([])
  // #526: typed searches, sent once typing pauses (like the Products search). Bind the field to the first ref, watch
  // the second.
  const { search: productSearch, debouncedSearch: productQuery } = useSearchDebounce()
  const { search: documentNumber, debouncedSearch: numberQuery } = useSearchDebounce()
  const summary = ref({ totalSales: 0, totalPurchases: 0, balance: 0 })

  // The documents, and the stock movements no document carries (a row each, when asked for or when nothing is).
  // A quote (a proforma, an offer) is listed, and counts in no total (`contact-ledger.service.ts`).
  const DOC_TYPES = ['invoice', 'cash_sale', 'proforma', 'offer', 'credit_note', 'debit_note', STOCK_MOVEMENT_TYPE] as const
  const docTypeOptions = DOC_TYPES.map((v) => ({ title: t(`invoicing.docType.${v}`), value: v }))

  // A date and a number are read whole: where the table is narrow (the dialog), the product's name wraps, not they.
  const WHOLE = { cellProps: { class: 'text-no-wrap' } }
  const headers = [
    { title: t('common.date'), key: 'date', sortable: false, ...WHOLE },
    { title: t('invoicing.invoiceNumber'), key: 'documentNumber', sortable: false, ...WHOLE },
    { title: t('common.type'), key: 'documentType', sortable: false },
    { title: t('invoicing.stockMovement'), key: 'movements', sortable: false },
    { title: t('warehouse.product'), key: 'productName', sortable: false },
    { title: t('invoicing.qty'), key: 'quantity', sortable: false, align: 'end' as const },
    { title: t('invoicing.unitPrice'), key: 'unitPrice', sortable: false, align: 'end' as const },
    { title: t('invoicing.taxRate'), key: 'taxRate', sortable: false, align: 'end' as const },
    { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: false },
    { title: t('common.total'), key: 'lineTotal', sortable: false, align: 'end' as const },
  ]

  function docTypeColor(type: string) {
    return ({ invoice: 'primary', cash_sale: 'success', proforma: 'info', offer: 'secondary', credit_note: 'warning', debit_note: 'error' }[type] || 'grey')
  }

  function docTypeLabel(type: string) {
    return (DOC_TYPES as readonly string[]).includes(type) ? t(`invoicing.docType.${type}`) : type
  }

  /** A movement's kind in the user's words, as the Stock Movement Documents list says it; an unknown one as it came. */
  function movementTypeLabel(type: string | undefined) {
    return type ? t(`warehouse.movementTypes.${type}`, type) : ''
  }

  /** The colours of the Stock Movement Documents list. */
  function movementTypeColor(type: string | undefined) {
    return ({ receipt: 'success', dispatch: 'error', transfer: 'info', adjustment: 'warning' }[type || ''] || 'grey')
  }

  /** A row's Type chip: the document's type, or, on a stock movement's own row, what the movement is. */
  function typeLabel(entry: ContactLedgerEntry) {
    return isMovementRow(entry) ? movementTypeLabel(entry.movementType) || docTypeLabel(entry.documentType) : docTypeLabel(entry.documentType)
  }

  function typeColor(entry: ContactLedgerEntry) {
    return isMovementRow(entry) ? movementTypeColor(entry.movementType) : docTypeColor(entry.documentType)
  }

  async function fetchLedger() {
    if (!contactId.value || !orgUrl.value) return
    loading.value = true
    try {
      const params: Record<string, any> = { page: page.value, size: pageSize.value }
      if (dateFrom.value) params.dateFrom = dateFrom.value
      if (dateTo.value) params.dateTo = dateTo.value
      if (docTypes.value.length) params.documentTypes = docTypes.value.join(',')
      if (productQuery.value.trim()) params.productSearch = productQuery.value.trim()
      if (numberQuery.value.trim()) params.documentNumber = numberQuery.value.trim()

      const { data } = await httpClient.get(`${orgUrl.value}/invoicing/contact-ledger/${contactId.value}`, { params })
      entries.value = data.entries || []
      total.value = data.total || 0
      summary.value = data.summary || { totalSales: 0, totalPurchases: 0, balance: 0 }
    } catch { /* */ } finally {
      loading.value = false
    }
  }

  function onUpdateOptions(opts: any) {
    page.value = (opts.page || 1) - 1
    pageSize.value = opts.itemsPerPage || 25
    fetchLedger()
  }

  function resetFilters() {
    dateFrom.value = ''
    dateTo.value = ''
    docTypes.value = []
    productSearch.value = ''
    documentNumber.value = ''
    productQuery.value = ''
    numberQuery.value = ''
    page.value = 0
    fetchLedger()
  }

  return {
    loading, entries, total, page, pageSize, dateFrom, dateTo, docTypes, summary,
    productSearch, productQuery, documentNumber, numberQuery,
    docTypeOptions, headers, docTypeColor, docTypeLabel, movementTypeLabel, typeLabel, typeColor,
    fetchLedger, onUpdateOptions, resetFilters,
  }
}
