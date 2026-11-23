import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { downloadAsSession } from 'ui-shared/composables/useSessionDownload'
import { useAppStore } from '../store/app.store'

/**
 * „Печат" of a customer order: its sheet as a PDF, in the user's language, from the order's form
 * and from its row in the list (`GET /invoicing/internal-orders/:id/export`).
 *
 * It downloads through the tab's session, never a link: a link carries only the cookie, which
 * names the org this browser entered last, in any tab (`useSessionDownload`).
 *
 * It prints the order as it is STORED. A form that holds an unsaved edit saves it first.
 */
export function useCustomerOrderPrint() {
  const { t } = useI18n()
  const appStore = useAppStore()
  const { showSuccess, showError } = useSnackbar()
  /** The order being printed, or '': its own button shows busy, and a second click does not start a second file. */
  const printingId = ref('')

  async function printOrder(order: { _id: string; number?: string }) {
    if (printingId.value) return
    printingId.value = order._id
    try {
      await downloadAsSession(
        `${appStore.orgUrl()}/invoicing/internal-orders/${order._id}/export?locale=${encodeURIComponent(appStore.locale)}`,
        `${order.number || order._id}.pdf`,
      )
      showSuccess(t('export.success'))
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    } finally {
      printingId.value = ''
    }
  }

  return { printingId, printOrder }
}
