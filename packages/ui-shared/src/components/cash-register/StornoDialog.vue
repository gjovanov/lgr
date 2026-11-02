<template>
  <v-dialog :model-value="modelValue" max-width="480" persistent @update:model-value="emit('update:modelValue', $event)">
    <v-card v-if="sale" data-testid="storno-dialog">
      <v-card-title class="text-h6">{{ $t('pos.storno.title', { number: sale.number }) }}</v-card-title>
      <v-card-text>
        <div class="d-flex justify-space-between mb-1">
          <span>{{ $t('common.total') }}</span>
          <span class="font-weight-bold">{{ fmtCurrency(sale.total) }}</span>
        </div>
        <!-- R3: what earlier stornos took back, and what is left of the sale. -->
        <div v-if="returnedAny" class="d-flex justify-space-between mb-1" data-testid="storno-left">
          <span>{{ $t('pos.storno.left') }}</span>
          <span class="font-weight-bold">{{ fmtCurrency(cents(leftValue)) }}</span>
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

        <!-- R3: all of it is the default and the fast path. A part names its lines and how much of each. -->
        <template v-if="canPart">
          <v-btn-toggle v-model="mode" mandatory density="compact" color="primary" variant="outlined" divided class="mb-3">
            <v-btn value="whole" size="small" data-testid="storno-whole">{{ $t(returnedAny ? 'pos.storno.allLeft' : 'pos.storno.whole') }}</v-btn>
            <v-btn value="part" size="small" data-testid="storno-part">{{ $t('pos.storno.part') }}</v-btn>
          </v-btn-toggle>
          <template v-if="mode === 'part'">
            <v-table density="compact" class="mb-2" data-testid="storno-lines">
              <thead>
                <tr>
                  <th>{{ $t('common.description') }}</th>
                  <th class="text-end">{{ $t('pos.storno.leftQuantity') }}</th>
                  <th class="text-end" style="width: 112px">{{ $t('pos.storno.returnQuantity') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in lines" :key="l.lineId" :class="l.left <= 0 ? 'text-disabled' : ''" data-testid="storno-line">
                  <td>{{ l.description }}</td>
                  <td class="text-end text-no-wrap">{{ l.left }} {{ l.unit || '' }}</td>
                  <td class="text-end">
                    <v-text-field
                      v-if="l.left > 0"
                      v-model.number="l.take"
                      type="number"
                      min="0"
                      :max="l.left"
                      step="any"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :aria-label="l.description"
                      data-testid="storno-line-quantity"
                    />
                  </td>
                </tr>
              </tbody>
            </v-table>
            <div class="d-flex justify-space-between mb-3">
              <span>{{ $t('pos.storno.goesBack') }}</span>
              <span class="font-weight-bold" data-testid="storno-amount">{{ fmtCurrency(cents(goesBack)) }}</span>
            </div>
            <v-select
              v-model="method"
              :items="methods"
              item-title="title"
              item-value="value"
              :label="$t('pos.storno.refundBy')"
              hide-details
              class="mb-3"
              data-testid="storno-method"
            />
          </template>
        </template>

        <v-select
          v-model="reason"
          :items="reasons"
          item-title="title"
          item-value="value"
          :label="$t('pos.storno.reason')"
          hide-details
          data-testid="storno-reason"
        />
        <v-alert v-if="error" :type="inDoubt ? 'warning' : 'error'" variant="tonal" density="compact" class="mt-3" data-testid="storno-error">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="submitting" @click="emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="error"
          variant="flat"
          :loading="submitting"
          :disabled="(needsSession && !targetSession) || !reason || inDoubt || (mode === 'part' && !partOk)"
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
 * #145 / FR-21 — STORNO a sale from the cash-register journal: the goods go back to the warehouse,
 * and for a till sale the refund leaves the register and the fiscal
 * device prints the storno receipt (Н-18). All of that is the server's
 * `POST /cash-register/documents/:id/storno`; this picks the session (a till sale's) and the reason.
 * A back-office sale needs no session: it has no receipt to reverse.
 *
 * ⚠ A storno whose fiscal receipt is proved not to have printed reverses NOTHING (the server answers 503
 * `fiscal_error`) — the message is shown as is, so the operator knows to fix the printer and retry.
 * ⚠ One that may have printed is another answer (409 `storno_in_doubt`): nothing was reversed, and a
 * second press would print a second fiscal storno. It says so, in the org's language, and the button
 * goes: a person checks the device and settles it on the document's page.
 *
 * FR-23 R3 (#363): a customer brings back one of three articles. All of it stays the default and one press; "Part of
 * it" names the lines and how much of each, what goes back is read off the same function the server books it by
 * (`config/pos-totals#partOfLine`), and the refund goes by the method the operator picks, or as the sale was paid.
 * The journal and a sale's page both open this dialog, on the till's sale and on a back-office one.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { partOfLine } from 'config/pos-totals'
import { httpClient } from '../../composables/useHttpClient'
import { createIdempotentAction } from '../../composables/idempotency'
import { useCurrency } from '../../composables/useCurrency'
import { receiptRefusalMessage } from '../../cash-register/receipt-refusal'
import { canPickPart } from '../../cash-register/storno'
import { paymentMethodKey } from '../../composables/usePaymentMethods'

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
  /** Nothing was reversed, but the sale reads differently now: a storno of it is in doubt. */
  held: []
}>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()

const reason = ref<string>('customer_return')
const targetSession = ref<any | null>(null)
const loadingSession = ref(false)
const submitting = ref(false)
const error = ref('')
const inDoubt = ref(false)

// ── R3: which lines ─────────────────────────────────────────────────────────
interface StornoLine {
  lineId: string
  description: string
  unit?: string
  quantity: number
  returned: number
  left: number
  value: number
  taken: number
  take: number | string
}
const mode = ref<'whole' | 'part'>('whole')
const lines = ref<StornoLine[]>([])
const saleMethods = ref<string[]>([])
/** '' is as the sale was paid: the server knows what it still holds per method. */
const method = ref('')

const toMilli = (q: unknown) => Math.round((Number(q) || 0) * 1000)
const partOf = (l: StornoLine, q: unknown) => partOfLine(l.value, toMilli(l.quantity), toMilli(l.returned), l.taken, toMilli(q))
const cents = (c: number) => c / 100
const returnedAny = computed(() => lines.value.some(l => l.returned > 0))
const leftValue = computed(() => lines.value.reduce((s, l) => s + partOf(l, l.left), 0))
const canPart = computed(() => canPickPart(lines.value))
const picked = computed(() => lines.value.filter(l => (Number(l.take) || 0) > 0))
const goesBack = computed(() => picked.value.reduce((s, l) => s + partOf(l, l.take), 0))
const partOk = computed(() => picked.value.length > 0 && lines.value.every((l) => {
  const q = Number(l.take) || 0
  return q >= 0 && q <= l.left && Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6
}))
const methods = computed(() => [
  { value: '', title: t('pos.storno.asPaid') },
  ...[...new Set([...saleMethods.value, 'cash', 'card'])].map(value => ({ value, title: t(paymentMethodKey(value)) })),
])

/** What is left of the sale's lines. A page that does not load leaves all of it, which is what this always did. */
async function loadLines(id: string) {
  lines.value = []
  saleMethods.value = []
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/cash-register/documents/${id}`)
    if (props.sale?.id !== id) return
    lines.value = (data?.lines ?? []).filter((l: any) => l.lineId).map((l: any) => ({ ...l, take: 0 }))
    saleMethods.value = (data?.row?.payments ?? []).map((p: any) => p.method)
  } catch { /* all of it still goes back */ }
}

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
  inDoubt.value = false
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

// ⚠ On opening, or on another sale: not on the sale's row being read again, as it is once a storno
// in doubt comes back, which took the message off the screen and the button back with it.
watch(() => (props.modelValue ? props.sale?.id : null), (id) => {
  if (id) {
    reason.value = 'customer_return'
    mode.value = 'whole'
    method.value = ''
    void findTargetSession()
    void loadLines(id)
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
    const body = {
      reason: reason.value,
      ...(sessionId ? { sessionId } : {}),
      ...(mode.value === 'part'
        ? {
            lines: picked.value.map(l => ({ lineId: l.lineId, quantity: Number(l.take) })),
            // A part worth nothing has no money to send anywhere, and a row of nothing is refused.
            ...(method.value && goesBack.value > 0 ? { payments: [{ method: method.value, amount: cents(goesBack.value) }] } : {}),
          }
        : {}),
    }
    const { data } = await httpClient.post(`${props.orgUrl}/cash-register/documents/${props.sale.id}/storno`, body, { headers: attempt.headers(body) })
    attempt.settle()
    emit('done', data)
    emit('update:modelValue', false)
  } catch (e: any) {
    // An unanswered attempt keeps its key: confirming again returns that storno, never a second.
    attempt.settle(e)
    // 503 fiscal_error: nothing was reversed. 409: someone else is already reversing it, or it may have printed.
    error.value = receiptRefusalMessage(t, e, t('common.operationFailed'))
    if (e?.response?.data?.code === 'storno_in_doubt') {
      inDoubt.value = true
      emit('held')
    }
  } finally {
    submitting.value = false
  }
}
</script>
