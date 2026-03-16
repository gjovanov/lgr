import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from './useHttpClient'

export interface ContactLedgerEntry {
  date: string
  documentNumber: string
  documentId: string
  documentType: string
  productId?: string
  productName?: string
  quantity: number
  unitPrice: number
  taxRate: number
  warehouseId?: string
  warehouseName?: string
  lineTotal: number
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
  const summary = ref({ totalSales: 0, totalPurchases: 0, balance: 0 })

  const docTypeOptions = [
    { title: 'Invoice', value: 'invoice' },
    { title: 'Cash Sale', value: 'cash_sale' },
    { title: 'Proforma', value: 'proforma' },
    { title: 'Credit Note', value: 'credit_note' },
    { title: 'Debit Note', value: 'debit_note' },
  ]

  const headers = [
    { title: t('common.date'), key: 'date', sortable: false },
    { title: t('invoicing.invoiceNumber'), key: 'documentNumber', sortable: false },
    { title: t('common.type'), key: 'documentType', sortable: false },
    { title: t('warehouse.product'), key: 'productName', sortable: false },
    { title: t('invoicing.qty'), key: 'quantity', sortable: false, align: 'end' as const },
    { title: t('invoicing.unitPrice'), key: 'unitPrice', sortable: false, align: 'end' as const },
    { title: t('invoicing.taxRate'), key: 'taxRate', sortable: false, align: 'end' as const },
    { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: false },
    { title: t('common.total'), key: 'lineTotal', sortable: false, align: 'end' as const },
  ]

  function docTypeColor(type: string) {
    return ({ invoice: 'primary', cash_sale: 'success', proforma: 'info', credit_note: 'warning', debit_note: 'error' }[type] || 'grey')
  }

  function docTypeLabel(type: string) {
    return ({ invoice: 'Invoice', cash_sale: 'Cash Sale', proforma: 'Proforma', credit_note: 'Credit Note', debit_note: 'Debit Note' }[type] || type)
  }

  async function fetchLedger() {
    if (!contactId.value || !orgUrl.value) return
    loading.value = true
    try {
      const params: Record<string, any> = { page: page.value, size: pageSize.value }
      if (dateFrom.value) params.dateFrom = dateFrom.value
      if (dateTo.value) params.dateTo = dateTo.value
      if (docTypes.value.length) params.documentTypes = docTypes.value.join(',')

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
    page.value = 0
    fetchLedger()
  }

  return {
    loading, entries, total, page, pageSize, dateFrom, dateTo, docTypes, summary,
    docTypeOptions, headers, docTypeColor, docTypeLabel,
    fetchLedger, onUpdateOptions, resetFilters,
  }
}
