import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { appHref } from 'ui-shared/nav/navigate'
import { linkDispatches, preselectedDispatches, type OverlappingDispatch, type QuantityDifference } from '../document-issue'
import type { useDocumentForm } from './useDocumentForm'

/**
 * A sales invoice and the stock notes that delivered its goods (FR-22.61 / FR-22.62, #725): the sales twin of
 * `useBillReceipts`.
 *
 * The server makes the link (`/invoicing/sales/from-dispatch`, `/:id/link-dispatches`) and keeps it
 * (`services/biz/dispatch-invoice.service.ts`): the invoice then moves no stock. This side shows it, the notes as
 * links into inventory, and offers „Свържи с експедиция" on a draft invoice.
 *
 * Unlike a bill, an invoice keeps the lines the person typed where they already say what the notes delivered: its
 * prices are their work, and a note carries none. Only where they differ do the notes' lines take their place, and
 * the person is told first, with the differences by name.
 */

export interface LinkedDispatch {
  id: string
  number: string
  date: string
  status: string
  held: boolean
  lines: Array<{ productId: string; quantity: number }>
}

type DocForm = ReturnType<typeof useDocumentForm>

export function useInvoiceDispatches(doc: DocForm) {
  const { t, locale } = useI18n()
  const router = useRouter()
  const { showSuccess, showError } = useSnackbar()
  const enabled = !!doc.config.linkStockNote

  const linkedDispatches = computed<LinkedDispatch[]>(() => (enabled && doc.invoiceData.value?.dispatches) || [])
  const dispatchHref = (id: string) => appHref('inventory', `/inventory/movements/${id}`)

  /** The lines the person typed. */
  const filledLines = computed(() => doc.form.lines.filter((l: any) => l.productId || String(l.description || '').trim()).length)
  /**
   * Offered on an invoice that has a customer, while it is still a draft and nothing has moved its goods: not one
   * issued for a cash sale, and not one written against an order, whose lines release that order's reservations as
   * they dispatch (the server refuses it: `invoice_on_order`).
   */
  const onOrder = computed(() => !!doc.invoiceData.value?.orderId || !!doc.invoiceData.value?.internalOrderId
    || doc.form.lines.some((l: any) => Object.values(l.orderRef || {}).some(Boolean)))
  const canLink = computed(() =>
    enabled
    && !!doc.form.contactId
    && !doc.invoiceData.value?.stockSource?.marker
    && !onOrder.value
    && (!doc.isEdit.value || doc.invoiceStatus.value === 'draft'),
  )

  const dialogOpen = ref(false)
  const loading = ref(false)
  const linking = ref(false)
  const invoiceable = ref<OverlappingDispatch[]>([])
  const selected = ref<string[]>([])
  /** What the server found different, once a link was refused for it: the next press replaces the lines. */
  const differs = ref<QuantityDifference[]>([])

  async function load() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${doc.orgUrl()}/invoicing/sales/invoiceable-dispatches`, { params: { contactId: doc.form.contactId } })
      invoiceable.value = data.dispatches || []
    } catch (e: any) {
      showError(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      loading.value = false
    }
  }

  async function openLink() {
    if (!canLink.value) return
    selected.value = []
    differs.value = []
    dialogOpen.value = true
    await load()
    selected.value = preselectedDispatches(invoiceable.value)
  }

  function onSelect(ids: string[]) {
    selected.value = ids
    // Another choice of notes is another comparison.
    differs.value = []
  }

  /**
   * Link the chosen notes. A form that holds lines is saved first and linked as it stands, so the server can keep
   * what was typed; an empty new one is made from the notes outright, with what was typed about it so far.
   */
  async function link() {
    if (!selected.value.length || linking.value) return
    linking.value = true
    try {
      let linesWritten = true
      if (doc.isEdit.value || filledLines.value > 0) {
        const id = await doc.saveIfNeeded()
        // Not saved: the form says why, and the dialog would cover it.
        if (!id) {
          dialogOpen.value = false
          return
        }
        const result = await linkDispatches(httpClient, doc.orgUrl(), id, {
          movementIds: selected.value,
          contactId: doc.form.contactId,
          ...(differs.value.length ? { replaceLines: true } : {}),
        })
        if (!result.linked) {
          differs.value = result.differs
          // Its lines stand in the list now, and the warning with them.
          dialogOpen.value = true
          if (!invoiceable.value.length) await load()
          return
        }
        linesWritten = result.linesWritten
      } else {
        const { data } = await httpClient.post(`${doc.orgUrl()}/invoicing/sales/from-dispatch`, {
          movementIds: selected.value,
          contactId: doc.form.contactId,
          locale: locale.value,
          // The invoice this form was typing keeps none of its lines, so it may not change its money either.
          ...(doc.form.currency ? { currency: doc.form.currency } : {}),
          ...(doc.form.issueDate ? { issueDate: doc.form.issueDate } : {}),
          ...(doc.form.dueDate ? { dueDate: doc.form.dueDate } : {}),
          ...(doc.form.notes ? { notes: doc.form.notes } : {}),
          ...(doc.form.paymentMethod ? { paymentMethod: doc.form.paymentMethod } : {}),
        })
        doc.markSaved()
        // The invoice this form was typing, now saved: the form stays mounted for it (FR-22.16).
        doc.adoptCreated(String(data.invoice.id))
        await router.replace({ name: `${doc.config.listRouteName}.edit`, params: { id: data.invoice.id } })
      }
      dialogOpen.value = false
      await doc.loadDocument()
      showSuccess(t(linesWritten ? 'invoicing.linkNote.linkedCheck' : 'invoicing.linkNote.linked'))
    } catch (e: any) {
      showError(stockRefusalMessage(e, t))
    } finally {
      linking.value = false
    }
  }

  /** The contact ledger's tick boxes: these notes, linked as the picker links them. */
  async function linkNotes(ids: string[]) {
    if (!canLink.value || !ids.length) return
    selected.value = [...new Set(ids)]
    differs.value = []
    await link()
  }

  return {
    enabled,
    linkedDispatches,
    dispatchHref,
    canLink,
    filledLines,
    dialogOpen,
    loading,
    linking,
    invoiceable,
    selected,
    differs,
    openLink,
    onSelect,
    link,
    linkNotes,
  }
}
