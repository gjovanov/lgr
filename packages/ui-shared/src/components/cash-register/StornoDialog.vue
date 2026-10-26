<template>
  <v-dialog :model-value="modelValue" max-width="480" persistent @update:model-value="emit('update:modelValue', $event)">
    <v-card v-if="sale" data-testid="storno-dialog">
      <v-card-title class="text-h6">{{ $t('pos.storno.title', { number: sale.number }) }}</v-card-title>
      <v-card-text>
        <div class="d-flex justify-space-between mb-1">
          <span>{{ $t('common.total') }}</span>
          <span class="font-weight-bold">{{ fmtCurrency(sale.total) }}</span>
        </div>
        <div v-if="sale.unp" class="d-flex justify-space-between mb-3 text-caption">
          <span>{{ $t('pos.storno.unp') }}</span>
          <span>{{ sale.unp }}</span>
        </div>

        <!-- A back-office sale has no receipt and no drawer: its storno prints nothing (FR-21 §3.5). -->
        <div v-if="!needsSession" class="text-caption text-medium-emphasis mb-3" data-testid="storno-no-receipt">
          {{ $t('pos.storno.noReceipt') }}
        </div>
        <v-progress-linear v-else-if="loadingSession" indeterminate class="mb-3" />
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
          :disabled="(needsSession && !targetSession) || !reason"
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
 * #145 / FR-21 — STORNO a sale from the cash-register journal, in the POS app or in invoicing: the
 * goods go back to the warehouse, and for a till sale the refund leaves the register and the fiscal
 * device prints the storno receipt (Н-18). All of that is the server's
 * `POST /cash-register/documents/:id/storno`; this picks the session (a till sale's) and the reason.
 * A back-office sale needs no session: it has no receipt to reverse.
 *
 * ⚠ A storno whose fiscal receipt fails to print reverses NOTHING (the server answers 503
 * `fiscal_error`) — the message is shown as is, so the operator knows to fix the printer and retry.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../../composables/useHttpClient'
import { createIdempotentAction } from '../../composables/idempotency'
import { useCurrency } from '../../composables/useCurrency'

export interface StornoTarget {
  id: string
  number: string
  total: number
  currency?: string
  unp?: string
  sessionId?: string
  /** `pos` (the till) or `backoffice`: only a till sale goes back through a session. */
  origin?: string
  /** The warehouse it was sold from, when the row names it. */
  warehouseId?: string
}

const props = defineProps<{
  modelValue: boolean
  sale: StornoTarget | null
  orgUrl: string
  userId?: string
  locale?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  done: [result: { transaction: any; receiptError?: string; stockError?: string }]
}>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()

const reason = ref<string>('customer_return')
const targetSession = ref<any | null>(null)
const loadingSession = ref(false)
const submitting = ref(false)
const error = ref('')

const reasons = computed(() => ['operator_error', 'customer_return', 'price_reduction', 'tax_base_reduction']
  .map(value => ({ value, title: t(`pos.storno.reasons.${value}`) })))

function fmtCurrency(amount: number) {
  const code = ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[props.locale || 'en'] || 'en-US'
  return formatCurrency(amount, props.sale?.currency || 'EUR', code)
}

/** A back-office sale is reversed without one. */
const needsSession = computed(() => props.sale?.origin !== 'backoffice')

/** An open session in the sale's warehouse — this user's own first, else anyone's. */
async function findTargetSession() {
  targetSession.value = null
  error.value = ''
  if (!needsSession.value || (!props.sale?.sessionId && !props.sale?.warehouseId)) return
  loadingSession.value = true
  try {
    const base = `${props.orgUrl}/trade/pos`
    const [orig, { data: open }] = await Promise.all([
      props.sale?.warehouseId ? Promise.resolve(null) : httpClient.get(`${base}/session/${props.sale!.sessionId}`).then(r => r.data),
      httpClient.get(`${base}/session`, { params: { status: 'open', size: 50 } }),
    ])
    const warehouseId = String(props.sale?.warehouseId || orig?.session?.warehouseId || '')
    const candidates = (open?.sessions || []).filter((s: any) => String(s.warehouseId) === warehouseId)
    targetSession.value = candidates.find((s: any) => String(s.cashierId) === String(props.userId)) || candidates[0] || null
  } catch (e: any) {
    error.value = e?.response?.data?.message || t('common.operationFailed')
  } finally {
    loadingSession.value = false
  }
}

watch(() => [props.modelValue, props.sale?.id], ([open]) => {
  if (open) {
    reason.value = 'customer_return'
    void findTargetSession()
  }
}, { immediate: true })

// #155: one Idempotency-Key per storno attempt (see ui-shared/composables/idempotency).
const attempt = createIdempotentAction()

async function submit() {
  if (!props.sale || (needsSession.value && !targetSession.value)) return
  submitting.value = true
  error.value = ''
  try {
    const sessionId = needsSession.value ? String(targetSession.value.id || targetSession.value._id) : undefined
    const body = { reason: reason.value, ...(sessionId ? { sessionId } : {}) }
    const { data } = await httpClient.post(`${props.orgUrl}/cash-register/documents/${props.sale.id}/storno`, body, { headers: attempt.headers(body) })
    attempt.settle()
    emit('done', data)
    emit('update:modelValue', false)
  } catch (e: any) {
    // An unanswered attempt keeps its key: confirming again returns that storno, never a second.
    attempt.settle(e)
    // 503 fiscal_error: nothing was reversed. 409: someone else is already reversing it.
    error.value = e?.response?.data?.message || t('common.operationFailed')
  } finally {
    submitting.value = false
  }
}
</script>
