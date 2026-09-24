import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFiscalBridge } from 'ui-shared/composables/useFiscalBridge'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

/**
 * Say what the server found when it first spoke to a freshly connected device (Eltrade sends
 * this right after the bridge registers). The three failure shapes each have a concrete fix,
 * and catching them at connect time beats discovering them on the first customer's receipt:
 *  - silence: the ECR is not in „1. Регистрация“ mode, or the wrong port was picked;
 *  - another serial number: the device record in LGR names a different device, so every
 *    УНП would carry the wrong prefix;
 *  - device errors: no paper, clock not set, fiscal memory problems.
 */
export function useFiscalBridgeAlerts() {
  const { t } = useI18n()
  const bridge = useFiscalBridge()
  const { showSnackbar } = useSnackbar()

  watch(() => bridge.deviceInfo.value, (info) => {
    if (!info) return
    if (!info.responding) {
      showSnackbar(t('pos.bridge.notResponding'), 'error', 20000)
    } else if (info.serialMismatch) {
      showSnackbar(t('pos.bridge.serialMismatch', { device: info.serialNumber, configured: info.deviceNumber }), 'error', 20000)
    } else if (info.errors.length) {
      showSnackbar(t('pos.bridge.deviceErrors', { errors: info.errors.join(', ') }), 'error', 12000)
    } else {
      showSnackbar(t('pos.bridge.identified', {
        model: info.model || '',
        serial: info.serialNumber || info.deviceNumber,
        mode: t(info.fiscalized === false ? 'pos.bridge.notFiscalized' : 'pos.bridge.fiscalized'),
      }), 'success', 6000)
    }
  })
}
