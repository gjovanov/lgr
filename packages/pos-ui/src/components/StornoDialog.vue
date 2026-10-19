<template>
  <v-dialog :model-value="modelValue" max-width="480" persistent @update:model-value="emit('update:modelValue', $event)">
    <v-card v-if="transaction" data-testid="storno-dialog">
      <v-card-title class="text-h6">{{ $t('pos.storno.title', { number: transaction.transactionNumber }) }}</v-card-title>
      <v-card-text>
        <div class="d-flex justify-space-between mb-1">
          <span>{{ $t('common.total') }}</span>
          <span class="font-weight-bold">{{ fmtCurrency(transaction.total) }}</span>
        </div>
        <div v-if="transaction.unpNumber" class="d-flex justify-space-between mb-3 text-caption">
          <span>{{ $t('pos.storno.unp') }}</span>
          <span>{{ transaction.unpNumber }}</span>
        </div>

        <v-progress-linear v-if="loadingSession" indeterminate class="mb-3" />
        <!-- The refund leaves the drawer of an OPEN session in the sale's own warehouse — the same
             till and fiscal device the sale went through (the server enforces this too). -->
        <v-alert v-else-if="!targetSession" type="warning" variant="tonal" density="compact" class="mb-3" data-testid="storno-no-session">
          {{ $t('pos.storno.noOpenSession') }}
        </v-alert>
        <div v-else class="text-caption text-medium-emphasis mb-3">
          {{ $t('pos.storno.fromSession', { session: targetSession.sessionNumber }) }}
        </div>

        <v-select
          v-model="reason"
          :items="reasons"
          item-title="title"
          item-value="value"
          :label="$t('pos.storno.reason')"
          hide-details
          data-testid="storno-reason"
        />
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3" data-testid="storno-error">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="submitting" @click="emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="error"
          variant="flat"
          :loading="submitting"
          :disabled="!targetSession || !reason"
          data-testid="storno-confirm"
          @click="submit"
        >
          {{ $t('pos.storno.confirm') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * #145 — STORNO a POS sale from the cash-sales journal: the goods go back to the warehouse, the
 * refund leaves the register, and the fiscal device prints the storno receipt (Н-18). All of
 * that is the server's `POST /session/:id/storno`; this picks the session and the reason.
 *
 * ⚠ A storno whose fiscal receipt fails to print reverses NOTHING (the server answers 503
 * `fiscal_error`) — the message is shown as is, so the operator knows to fix the printer and retry.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useAppStore } from '../store/app.store'

const props = defineProps<{ modelValue: boolean; transaction: any | null }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  done: [result: { transaction: any; receiptError?: string; stockError?: string }]
}>()

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()

const reason = ref<string>('customer_return')
const targetSession = ref<any | null>(null)
const loadingSession = ref(false)
const submitting = ref(false)
const error = ref('')

const reasons = computed(() => ['operator_error', 'customer_return', 'price_reduction', 'tax_base_reduction']
  .map(value => ({ value, title: t(`pos.storno.reasons.${value}`) })))

function fmtCurrency(amount: number) {
  const code = { en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'
  return formatCurrency(amount, appStore.currentOrg?.baseCurrency || 'EUR', code)
}

/** An open session in the sale's warehouse — this user's own first, else anyone's. */
async function findTargetSession() {
  targetSession.value = null
  error.value = ''
  if (!props.transaction) return
  loadingSession.value = true
  try {
    const base = `${appStore.orgUrl()}/trade/pos`
    const [{ data: orig }, { data: open }] = await Promise.all([
      httpClient.get(`${base}/session/${props.transaction.sessionId}`),
      httpClient.get(`${base}/session`, { params: { status: 'open', size: 50 } }),
    ])
    const warehouseId = String(orig?.session?.warehouseId || '')
    const candidates = (open?.sessions || []).filter((s: any) => String(s.warehouseId) === warehouseId)
    const me = appStore.user?.id
    targetSession.value = candidates.find((s: any) => String(s.cashierId) === String(me)) || candidates[0] || null
  } catch (e: any) {
    error.value = e?.response?.data?.message || t('common.operationFailed')
  } finally {
    loadingSession.value = false
  }
}

watch(() => [props.modelValue, props.transaction?.id || props.transaction?._id], ([open]) => {
  if (open) {
    reason.value = 'customer_return'
    void findTargetSession()
  }
}, { immediate: true })

async function submit() {
  if (!targetSession.value || !props.transaction) return
  submitting.value = true
  error.value = ''
  try {
    const sessionId = targetSession.value.id || targetSession.value._id
    const { data } = await httpClient.post(`${appStore.orgUrl()}/trade/pos/session/${sessionId}/storno`, {
      originalTransactionId: props.transaction.id || props.transaction._id,
      reason: reason.value,
    })
    emit('done', data)
    emit('update:modelValue', false)
  } catch (e: any) {
    // 503 fiscal_error: nothing was reversed. 409: someone else is already reversing it.
    error.value = e?.response?.data?.message || t('common.operationFailed')
  } finally {
    submitting.value = false
  }
}
</script>
