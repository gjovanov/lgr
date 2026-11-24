import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { downloadAsSession } from 'ui-shared/composables/useSessionDownload'
import { useAppStore } from '../store/app.store'

/**
 * „Печат" on a stock movement: the movement as a document (`GET /warehouse/movement/:id/export`), in
 * the language the person works in. It goes with the goods, and on a transfer to the people at the
 * other site, so it carries no price.
 *
 * ⚠ Downloaded as this tab's session, never through a plain link: a link carries only the cookie,
 * which names the org this browser entered last, in any tab (`useSessionDownload`).
 */
export function useMovementPrint() {
  const { t } = useI18n()
  const appStore = useAppStore()
  const { showError } = useSnackbar()
  /** The movement being printed, so its own button shows it. */
  const printing = ref<string | null>(null)

  async function printMovement(item: { _id: string; number?: string }) {
    if (printing.value) return
    printing.value = item._id
    try {
      const locale = encodeURIComponent(appStore.locale || 'en')
      await downloadAsSession(`${appStore.orgUrl()}/warehouse/movement/${item._id}/export?locale=${locale}`, `${item.number || item._id}.pdf`)
    } catch (e: any) {
      showError(e?.response?.data?.message || t('export.failed'))
    } finally {
      printing.value = null
    }
  }

  return { printing, printMovement }
}
