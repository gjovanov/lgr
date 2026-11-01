import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { appHref } from 'ui-shared/nav/navigate'
import { preselectedReceipts } from '../receipt-overlap'
import type { useDocumentForm } from './useDocumentForm'

/**
 * A supplier bill and the goods receipts it pays for (FR-22.31 / FR-22.32, #168).
 *
 * The server makes the link (`/invoicing/bills/from-receipt`, `/:id/link-receipts`) and keeps it
 * (`services/biz/receipt-bill.service.ts`): the bill then moves no stock. This side shows it — the
 * receipts as links into inventory, and each line's price against the cost it was received at
 * (D-2: the bill keeps the supplier's prices; a difference is shown, never applied) — and offers
 * „Свържи с доставка" on a draft bill. A bill with typed lines takes the delivery's lines instead,
 * and the user is told first (FR-22.32a).
 */

export interface LinkedReceipt {
  id: string
  number: string
  date: string
  status: string
  held: boolean
  lines: Array<{ productId: string; quantity: number; unitCost: number }>
}

export interface BillableReceipt {
  id: string
  number: string
  date: string
  lineCount: number
  total: number
  /** It names no supplier, and takes the bill's (FR-22.31a). */
  noSupplier?: boolean
  /** Its notes, when it names no supplier: all there is to tell whose goods they were. */
  notes?: string
}

/** Per article: what the receipts received, and at what average cost. */
export function receivedByProduct(receipts: LinkedReceipt[]): Map<string, { quantity: number; cost: number }> {
  const acc = new Map<string, { quantity: number; value: number }>()
  for (const r of receipts) {
    for (const l of r.lines || []) {
      if (!(Number(l.quantity) > 0)) continue
      const cur = acc.get(l.productId) || { quantity: 0, value: 0 }
      cur.quantity += Number(l.quantity)
      cur.value += Number(l.quantity) * Number(l.unitCost)
      acc.set(l.productId, cur)
    }
  }
  return new Map([...acc].map(([id, v]) => [id, { quantity: v.quantity, cost: v.quantity ? v.value / v.quantity : 0 }]))
}

type DocForm = ReturnType<typeof useDocumentForm>

export function useBillReceipts(doc: DocForm) {
  const { t } = useI18n()
  const router = useRouter()
  const { showSuccess, showError } = useSnackbar()
  const enabled = !!doc.config.linkDelivery

  const linkedReceipts = computed<LinkedReceipt[]>(() => (enabled && doc.invoiceData.value?.receipts) || [])
  const received = computed(() => receivedByProduct(linkedReceipts.value))
  const receiptHref = (id: string) => appHref('inventory', `/inventory/movements/${id}`)

  /** The cost a line's article was received at, when it differs from the line's price. */
  function receiptCostOf(line: { productId?: string; unitPrice?: number }): { cost: number; diff: number } | null {
    if (!line?.productId) return null
    const r = received.value.get(String(line.productId))
    if (!r) return null
    const diff = +(Number(line.unitPrice || 0) - r.cost).toFixed(4)
    return Math.abs(diff) < 0.00005 ? null : { cost: r.cost, diff }
  }

  // ── „Свържи с доставка" (FR-22.32) ──
  /** The lines the user typed: linking replaces them, and says so first (FR-22.32a). */
  const filledLines = computed(() => doc.form.lines.filter((l: any) => l.productId || String(l.description || '').trim()).length)
  /**
   * Offered on a bill that has a supplier, while it is still a draft. A bill linked to receipts
   * moves no stock at all, so a line typed before linking could never be received: the receipts'
   * lines become the bill's.
   */
  const canLinkDelivery = computed(() =>
    enabled
    && !!doc.form.contactId
    && !linkedReceipts.value.length
    && (!doc.isEdit.value || doc.invoiceStatus.value === 'draft'),
  )

  const dialogOpen = ref(false)
  const loading = ref(false)
  const linking = ref(false)
  const billable = ref<BillableReceipt[]>([])
  const selected = ref<string[]>([])

  async function openLinkDelivery() {
    if (!canLinkDelivery.value) return
    selected.value = []
    dialogOpen.value = true
    loading.value = true
    try {
      const { data } = await httpClient.get(`${doc.orgUrl()}/invoicing/bills/billable-receipts`, { params: { contactId: doc.form.contactId } })
      billable.value = data.receipts || []
      selected.value = preselectedReceipts(billable.value)
    } catch (e: any) {
      showError(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      loading.value = false
    }
  }

  async function linkDelivery() {
    if (!selected.value.length) return
    linking.value = true
    try {
      if (doc.isEdit.value) {
        // What the form holds and the bill does not would go with the reload below: the supplier's
        // number, the dates, the notes. Replacing lines keeps what the bill says about itself.
        const id = await doc.saveIfNeeded()
        // Not saved: the form says why, and the dialog would cover it.
        if (!id) {
          dialogOpen.value = false
          return
        }
        await httpClient.post(`${doc.orgUrl()}/invoicing/bills/${id}/link-receipts`, {
          movementIds: selected.value,
          contactId: doc.form.contactId,
          ...(filledLines.value ? { replaceLines: true } : {}),
        })
      } else {
        // A bill not saved yet: the server makes it from the receipts, with what was typed so far.
        const { data } = await httpClient.post(`${doc.orgUrl()}/invoicing/bills/from-receipt`, {
          movementIds: selected.value,
          contactId: doc.form.contactId,
          ...(doc.form.supplierInvoiceNumber ? { reference: doc.form.supplierInvoiceNumber } : {}),
          ...(doc.form.issueDate ? { issueDate: doc.form.issueDate } : {}),
          ...(doc.form.dueDate ? { dueDate: doc.form.dueDate } : {}),
          ...(doc.form.notes ? { notes: doc.form.notes } : {}),
          ...(doc.form.paymentMethod ? { paymentMethod: doc.form.paymentMethod } : {}),
        })
        doc.markSaved()
        // The bill this form was typing, now saved: the form stays mounted for it (FR-22.16).
        doc.adoptCreated(String(data.invoice.id))
        await router.replace({ name: `${doc.config.listRouteName}.edit`, params: { id: data.invoice.id } })
      }
      dialogOpen.value = false
      await doc.loadDocument()
      showSuccess(t('invoicing.linkDelivery.linked'))
    } catch (e: any) {
      showError(stockRefusalMessage(e, t))
    } finally {
      linking.value = false
    }
  }

  // ── FR-22.31c: the two ways out of the question „Запази и получи" can end in ──
  async function onOverlapLinked() {
    await doc.loadDocument()
    showSuccess(t('invoicing.receiptOverlap.linked'))
  }

  async function onOverlapReceived() {
    await doc.loadDocument()
    showSuccess(t('invoicing.invoiceReceived'))
  }

  return {
    enabled,
    linkedReceipts,
    receiptHref,
    receiptCostOf,
    canLinkDelivery,
    filledLines,
    dialogOpen,
    loading,
    linking,
    billable,
    selected,
    openLinkDelivery,
    linkDelivery,
    onOverlapLinked,
    onOverlapReceived,
  }
}
