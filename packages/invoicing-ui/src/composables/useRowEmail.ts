import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAppStore } from '../store/app.store'

/**
 * FR-10 (#19) — "send by email" straight from a document LIST row.
 *
 * The detail page has the same action inside `DocumentForm`; this is the shortcut for the
 * common case, where someone works down a day's invoices and never opens one. Both go to the
 * same `POST /invoicing/export/:id/email`, so there is one server-side gate, not two.
 *
 * The recipient is prefilled from `contactEmail`, which the invoice LIST endpoint now
 * returns (it already had the contacts loaded for `contactName`) — opening the dialog costs
 * no extra request. A contact without an email still opens the dialog, just empty: typing an
 * address by hand is a legitimate case, and the dialog validates it.
 */

export interface EmailableRow {
  _id: string
  number?: string
  invoiceNumber?: string
  status?: string
  contactEmail?: string
}

export function useRowEmail() {
  const { t } = useI18n()
  const appStore = useAppStore()
  const { showError, showSuccess } = useSnackbar()

  const dialogOpen = ref(false)
  const loading = ref(false)
  const row = ref<EmailableRow | null>(null)

  const documentNumber = computed(() => row.value?.number || row.value?.invoiceNumber || '')
  const defaultTo = computed(() => row.value?.contactEmail || '')
  const defaultSubject = computed(() => {
    const org = (appStore.currentOrg as any)?.name || ''
    return [documentNumber.value, org].filter(Boolean).join(' — ')
  })

  /** A draft carries a DRF- number; the server refuses it too (422), so grey it out here. */
  function canEmail(item: EmailableRow): boolean {
    return item.status !== 'draft'
  }

  function open(item: EmailableRow) {
    if (!canEmail(item)) return
    row.value = item
    dialogOpen.value = true
  }

  async function send(payload: { to: string; subject?: string; message?: string }) {
    if (!row.value) return
    loading.value = true
    try {
      await httpClient.post(`${appStore.orgUrl()}/invoicing/export/${row.value._id}/email`, {
        ...payload,
        locale: appStore.locale,
      })
      dialogOpen.value = false
      showSuccess(t('invoicing.sendEmail.sentTo', { to: payload.to }))
    } catch (e: any) {
      // The server's message is the useful one — "not configured" and "the mail provider
      // rejected the message" are different problems with different fixes.
      showError(e?.response?.data?.message || t('common.operationFailed'))
    } finally {
      loading.value = false
    }
  }

  return { dialogOpen, loading, row, documentNumber, defaultTo, defaultSubject, canEmail, open, send }
}
