<template>
  <v-dialog v-model="open" max-width="620" persistent>
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon>mdi-cash-register</v-icon>
        {{ $t('pos.close.title') }}
      </v-card-title>

      <v-card-text>
        <!-- Result states (FR-9.10). Rendered instead of the form once we have an outcome. -->
        <template v-if="result">
          <v-alert
            :type="result.kind === 'error' ? 'error' : result.kind === 'skipped' ? 'info' : 'success'"
            variant="tonal"
            class="mb-2"
          >
            <div class="font-weight-medium">{{ result.title }}</div>
            <div v-if="result.detail" class="text-body-2 mt-1">{{ result.detail }}</div>
          </v-alert>
          <!-- The session's own figures, printed after the Z-report; the session is closed either way. -->
          <v-alert v-if="result.reportError" type="warning" variant="tonal" density="compact" class="mb-2" data-testid="session-report-error">
            {{ $t('pos.sessionReport.notPrinted', { error: result.reportError }) }}
          </v-alert>
          <SessionReportCard v-if="result.report" :report="result.report" />
        </template>

        <template v-else>
          <div v-if="loadingPreview" class="d-flex justify-center py-6">
            <v-progress-circular indeterminate color="primary" />
          </div>

          <template v-else>
            <!-- A Z-report zeroes the DEVICE's day, not just this session. -->
            <v-alert
              v-if="preview && preview.openSessionsOnWarehouse > 0"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-3"
            >
              {{ $t('pos.close.otherSessionsOpen', { n: preview.openSessionsOnWarehouse }) }}
            </v-alert>

            <!-- FR-23: a session does not close over a receipt nobody finished. The close finishes
                 what it can prove, so this warns and does not forbid. -->
            <v-alert
              v-if="unfinishedReceipts"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-3"
              data-testid="close-receipts-unfinished"
            >
              {{ $t('cashRegister.receipt.unfinished', { numbers: unfinishedReceipts }) }}
            </v-alert>

            <v-alert
              v-if="preview && !preview.fiscalDevice"
              type="info"
              variant="tonal"
              density="compact"
              class="mb-3"
            >
              {{ $t('pos.close.noFiscalDevice') }}
            </v-alert>

            <v-table density="compact" class="mb-3">
              <thead>
                <tr>
                  <th />
                  <th class="text-end">{{ $t('pos.close.expected') }}</th>
                  <th class="text-end" style="width: 180px">{{ $t('pos.close.counted') }}</th>
                  <th class="text-end">{{ $t('pos.close.difference') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in visibleMethods" :key="m">
                  <td>
                    <v-icon size="small" class="mr-2">{{ METHOD_ICON[m] }}</v-icon>
                    {{ $t(`pos.close.method.${m}`) }}
                  </td>
                  <td class="text-end">{{ fmt(expected[m]) }}</td>
                  <td class="text-end">
                    <v-text-field
                      v-model.number="counted[m]"
                      type="number"
                      density="compact"
                      hide-details
                      variant="outlined"
                      class="text-end"
                    />
                  </td>
                  <td class="text-end" :class="diffClass(m)">{{ fmt(difference(m)) }}</td>
                </tr>
                <!-- What couriers owe: expected, and never counted. It is not at the till. -->
                <tr v-if="expected.cashOnDelivery" data-testid="close-cash-on-delivery">
                  <td>
                    <v-icon size="small" class="mr-2">mdi-truck-delivery-outline</v-icon>
                    {{ $t('pos.close.method.cashOnDelivery') }}
                  </td>
                  <td class="text-end">{{ fmt(expected.cashOnDelivery) }}</td>
                  <td colspan="2" class="text-end text-medium-emphasis">{{ $t('pos.close.notCounted') }}</td>
                </tr>
              </tbody>
            </v-table>

            <v-textarea
              v-model="notes"
              :label="$t('pos.close.notes')"
              rows="2"
              auto-grow
              density="compact"
              hide-details
            />

            <!-- Only a manager may bypass a device that exists; the server enforces it too. -->
            <v-checkbox
              v-if="preview?.fiscalDevice && canSkipFiscal"
              v-model="closeWithoutFiscal"
              :label="$t('pos.close.closeWithoutFiscal')"
              density="compact"
              hide-details
              class="mt-2"
            />
          </template>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <template v-if="result">
          <v-btn v-if="result.report" variant="outlined" prepend-icon="mdi-printer" :loading="reprinting" @click="reprint">
            {{ $t('pos.sessionReport.print') }}
          </v-btn>
          <v-btn variant="text" @click="finish">{{ $t('common.close') }}</v-btn>
          <v-btn v-if="result.kind === 'error'" color="primary" variant="flat" :loading="submitting" @click="submit">
            {{ $t('pos.close.retry') }}
          </v-btn>
        </template>
        <template v-else>
          <v-btn variant="text" :disabled="submitting" @click="open = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="submitting" :disabled="loadingPreview" @click="submit">
            {{ $t('pos.close.confirm') }}
          </v-btn>
        </template>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { createIdempotentAction } from 'ui-shared/composables/idempotency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { receiptRefusalMessage } from 'ui-shared/cash-register/receipt-refusal'
import { useAppStore } from '../../store/app.store'
import SessionReportCard, { type SessionReportData } from './SessionReportCard.vue'

/**
 * FR-9.9/9.10 (#18) — the end-of-day close, modeled on the legacy PlusMinus screen: one row
 * per payment method showing НАЛИЧНОСТ (expected) / ДЕЙСТВ. НАЛИЧНОСТ (counted) / РАЗЛИКА.
 *
 * It replaces a dialog that asked for a single number and closed the session unconditionally
 * without ever talking to the fiscal device.
 *
 * The three outcomes are visually distinct on purpose: on a fiscal error the session is
 * still OPEN, and the operator must see that rather than assume the day is done.
 */

const props = defineProps<{
  modelValue: boolean
  sessionId: string
  orgUrl: string
  currency?: string
  /** Only admin/manager may bypass a configured device. */
  canSkipFiscal?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  closed: []
}>()

const METHOD_ICON: Record<string, string> = {
  cash: 'mdi-cash',
  card: 'mdi-credit-card-outline',
  other: 'mdi-ticket-percent-outline',
}

const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()
const appStore = useAppStore()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const loadingPreview = ref(false)
const submitting = ref(false)
const preview = ref<any>(null)
const expected = ref<Record<string, number>>({ cash: 0, card: 0, other: 0 })
const counted = ref<Record<string, number>>({ cash: 0, card: 0, other: 0 })
const notes = ref('')
const closeWithoutFiscal = ref(false)
const result = ref<{
  kind: 'success' | 'skipped' | 'error'
  title: string
  detail?: string
  /** The session's own figures, which the close printed after the Z-report — or why it did not. */
  report?: SessionReportData
  reportError?: string
} | null>(null)

/** „Other" is noise unless this register actually took some — hide it when it is 0. */
const visibleMethods = computed(() =>
  ['cash', 'card', 'other'].filter(m => m !== 'other' || expected.value.other > 0 || counted.value.other > 0),
)

function fmt(v: number | undefined) {
  const cur = props.currency || appStore.currentOrg?.baseCurrency || 'EUR'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(v || 0)
  } catch {
    return (v || 0).toFixed(2)
  }
}

function difference(method: string): number {
  return Math.round(((Number(counted.value[method]) || 0) - (expected.value[method] || 0)) * 100) / 100
}
function diffClass(method: string): string {
  const d = difference(method)
  if (d === 0) return 'text-medium-emphasis'
  return d > 0 ? 'text-success' : 'text-error'
}

const unfinishedReceipts = computed(() => (preview.value?.unfinishedReceipts ?? []).map((r: any) => r.number ?? r.invoice).join(', '))

async function loadPreview() {
  loadingPreview.value = true
  result.value = null
  closeWithoutFiscal.value = false
  notes.value = ''
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/trade/pos/session/${props.sessionId}/close-preview`)
    preview.value = data
    expected.value = { cash: 0, card: 0, other: 0, ...(data.expected || {}) }
    // Prefill the counted column with what is expected: the common case is "it matches",
    // and the operator only edits what differs.
    counted.value = { ...expected.value }
  } catch {
    preview.value = null
  } finally {
    loadingPreview.value = false
  }
}

// #155: one Idempotency-Key per close attempt (see ui-shared/composables/idempotency).
const attempt = createIdempotentAction()

async function submit() {
  submitting.value = true
  result.value = null
  try {
    const body = {
      counted: {
        cash: Number(counted.value.cash) || 0,
        card: Number(counted.value.card) || 0,
        other: Number(counted.value.other) || 0,
      },
      notes: notes.value || undefined,
      closeWithoutFiscal: closeWithoutFiscal.value || undefined,
    }
    const { data } = await httpClient.post(`${props.orgUrl}/trade/pos/session/${props.sessionId}/close`, body, { headers: attempt.headers(body) })
    attempt.settle()

    if (data.fiscalStatus === 'closed') {
      result.value = {
        kind: 'success',
        title: t('pos.close.fiscalClosed'),
        // Tremol reports no number; showing the literal "unknown" would be worse than nothing.
        detail: data.zReportNumber ? t('pos.close.zReportNumber', { n: data.zReportNumber }) : undefined,
        report: data.report,
        reportError: data.reportError,
      }
    } else {
      result.value = { kind: 'skipped', title: t('pos.close.fiscalSkipped'), report: data.report, reportError: data.reportError }
    }
  } catch (e: any) {
    // An unanswered attempt keeps its key: closing again returns that close, never a second Z-report.
    attempt.settle(e)
    // The session is still open — the server reverted it. Say so plainly.
    const refused = e?.response?.data
    result.value = refused?.code === 'receipt_open'
      // Not a failure: a sale is printing on the device, and closing again after it works.
      ? { kind: 'error', title: t('pos.close.receiptOpenTitle'), detail: t('pos.close.receiptOpen') }
      : refused?.code === 'receipts_unfinished'
        // FR-23: nothing failed and no Z printed. It says which receipts stand in the way.
        ? { kind: 'error', title: t('pos.close.receiptOpenTitle'), detail: receiptRefusalMessage(t, e, refused.message) }
        : { kind: 'error', title: t('pos.close.fiscalFailed'), detail: refused?.message || t('common.operationFailed') }
  } finally {
    submitting.value = false
  }
}

/** Print the session's report again on the warehouse's device. */
const reprinting = ref(false)
async function reprint() {
  reprinting.value = true
  try {
    await httpClient.post(`${props.orgUrl}/trade/pos/session/${props.sessionId}/report/print`)
    if (result.value) result.value = { ...result.value, reportError: undefined }
    showSuccess(t('pos.sessionReport.printed'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    reprinting.value = false
  }
}

function finish() {
  const wasClosed = result.value?.kind !== 'error'
  open.value = false
  if (wasClosed) emit('closed')
}

watch(open, (isOpen) => {
  if (isOpen) loadPreview()
})
</script>
