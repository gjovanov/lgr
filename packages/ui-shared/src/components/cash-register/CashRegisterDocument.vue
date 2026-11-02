<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <v-btn icon="mdi-arrow-left" variant="text" :to="backRoute" :aria-label="$t('cashRegister.detail.back')" />
      <h1 class="text-h5" data-testid="journal-document-title">{{ doc?.row.number || '' }}</h1>
      <template v-if="doc">
        <v-chip size="small" label :color="kindColor(doc.row.kind)">{{ $t(`cashRegister.kind.${doc.row.kind}`) }}</v-chip>
        <v-chip size="small" label :color="statusColor(doc.row.status)" data-testid="journal-document-status">{{ $t(`cashRegister.status.${doc.row.status}`) }}</v-chip>
        <v-chip size="small" variant="tonal">{{ $t(`cashRegister.origin.${doc.row.origin}`) }}</v-chip>
      </template>
      <v-spacer />
      <!-- What the app around it offers on the document (the invoicing app: Печат). -->
      <slot v-if="doc" name="actions" :row="doc.row" />
      <v-btn v-if="doc && documentLink" variant="outlined" prepend-icon="mdi-file-document-outline" :to="documentLink">
        {{ $t('cashRegister.detail.openDocument') }}
      </v-btn>
      <!-- #145: STORNO from the document itself, as in the journal. -->
      <v-btn
        v-if="doc && canStorno"
        color="error"
        variant="tonal"
        prepend-icon="mdi-undo-variant"
        data-testid="storno-button"
        @click="stornoOpen = true"
      >
        {{ $t('pos.storno.button') }}
      </v-btn>
    </div>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />
    <v-alert v-if="notFound" type="warning" variant="tonal">{{ $t('cashRegister.detail.notFound') }}</v-alert>

    <template v-if="doc">
      <!-- FR-23: nothing could prove whether this receipt or storno printed. Someone looks at the device and says. -->
      <v-alert v-if="doc.row.fiscal.inDoubt" type="warning" variant="tonal" class="mb-4" data-testid="receipt-in-doubt">
        {{ $t(`cashRegister.receipt.${settleWords.inDoubt}`) }}
        <div v-if="canSettle" class="mt-2 d-flex flex-wrap ga-2">
          <v-btn size="small" variant="outlined" data-testid="receipt-settle-printed" @click="settling = 'printed'">{{ $t('cashRegister.receipt.settlePrinted') }}</v-btn>
          <v-btn size="small" variant="outlined" data-testid="receipt-settle-not-printed" @click="settling = 'notPrinted'">{{ $t('cashRegister.receipt.settleNotPrinted') }}</v-btn>
        </div>
        <div v-else class="mt-2 text-caption">{{ $t('cashRegister.receipt.settleWho') }}</div>
      </v-alert>

      <v-dialog :model-value="!!settling" max-width="480" @update:model-value="settling = null">
        <v-card>
          <v-card-title>{{ doc.row.number }}</v-card-title>
          <v-card-text>
            {{ settling ? $t(`cashRegister.receipt.${settleWords.confirm}.${settling}`) : '' }}
            <!-- A storno cites it, and only the slip knows it. -->
            <v-text-field
              v-if="settling === 'printed' && takesNumber"
              v-model="settleNumber"
              :label="$t('cashRegister.receipt.receiptNumber')"
              :hint="doc.row.kind === 'payment' ? $t('cashRegister.receipt.receiptNumberHint') : undefined"
              :persistent-hint="doc.row.kind === 'payment'"
              :hide-details="doc.row.kind !== 'payment'"
              inputmode="numeric"
              class="mt-3"
              data-testid="receipt-settle-number"
            />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" :disabled="settlingNow" @click="settling = null">{{ $t('common.cancel') }}</v-btn>
            <v-btn color="primary" variant="flat" :loading="settlingNow" :disabled="settling === 'printed' && settleNumberBad" data-testid="receipt-settle-confirm" @click="settle">{{ $t('common.confirm') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-card class="mb-4">
        <v-card-text>
          <v-row dense>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.date') }}</div><div>{{ fmtDate(doc.row) }}</div></v-col>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.customer') }}</div><div>{{ doc.row.contactName || '—' }}</div></v-col>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.session') }}</div><div>{{ doc.session?.number || doc.row.sessionNumber || '—' }}</div></v-col>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.cashier') }}</div><div>{{ doc.row.cashierName || '—' }}</div></v-col>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.warehouse') }}</div><div>{{ doc.row.warehouseName || '—' }}</div></v-col>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.fiscal') }}</div><div data-testid="journal-document-unp">{{ doc.row.fiscal.unp || '—' }}</div></v-col>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.device') }}</div><div>{{ doc.row.fiscal.deviceNumber || '—' }}<span v-if="doc.row.fiscal.receiptNumber"> · {{ doc.row.fiscal.receiptNumber }}</span></div></v-col>
            <v-col cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.stock') }}</div><div :class="{ 'text-error': doc.row.stock === 'error' }">{{ $t(`cashRegister.stock.${doc.row.stock}`) }}</div></v-col>
            <v-col v-if="doc.row.fiscal.state && doc.row.fiscal.state !== 'none'" cols="12" sm="6" md="3">
              <div class="text-caption text-medium-emphasis">{{ $t('cashRegister.filters.fiscalState') }}</div>
              <div>{{ $t(`cashRegister.fiscalState.${doc.row.fiscal.state}`) }}</div>
            </v-col>
            <v-col v-if="doc.row.reference" cols="12" sm="6" md="3"><div class="text-caption text-medium-emphasis">{{ $t('cashRegister.columns.reference') }}</div><div>{{ doc.row.reference }}</div></v-col>
            <!-- FR-23: the invoice a payment's receipt took money for, or the credit note a refund's storno gave it back on. -->
            <v-col v-for="inv in doc.row.kind === 'payment' || doc.row.kind === 'refund' ? doc.row.invoices : []" :key="inv.id" cols="12" sm="6" md="3">
              <div class="text-caption text-medium-emphasis">{{ doc.row.kind === 'refund' ? $t('cashRegister.receipt.refundOf') : $t('cashRegister.receipt.paidInvoice') }}</div>
              <router-link v-if="invoiceRoute" :to="invoiceRoute(inv)" class="text-decoration-none" data-testid="journal-paid-invoice">{{ inv.number }}</router-link>
              <span v-else data-testid="journal-paid-invoice">{{ inv.number }}</span>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- The storno chain, both ways. -->
      <v-card v-if="doc.related.length" class="mb-4">
        <v-card-title class="text-subtitle-1">{{ $t('cashRegister.detail.related') }}</v-card-title>
        <v-card-text>
          <div v-for="r in doc.related" :key="r.id" class="d-flex align-center ga-2 mb-1" data-testid="journal-related">
            <span class="text-caption text-medium-emphasis">{{ givesBack(r.kind) ? $t('cashRegister.detail.stornoedBy') : $t('cashRegister.detail.stornoOf') }}</span>
            <router-link :to="relatedRoute(r)" class="text-decoration-none">{{ r.number }}</router-link>
            <span>{{ fmtCurrency(givesBack(r.kind) ? -r.total : r.total, r.currency) }}</span>
            <v-chip v-if="r.status === 'inDoubt'" size="x-small" label color="warning" data-testid="journal-related-in-doubt">{{ $t('cashRegister.status.inDoubt') }}</v-chip>
          </div>
        </v-card-text>
      </v-card>

      <v-card class="mb-4">
        <v-card-title class="text-subtitle-1">{{ $t('cashRegister.detail.lines') }}</v-card-title>
        <v-card-text>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end">{{ $t('pos.quantity') }}</th>
                <th class="text-end">{{ $t('invoicing.unitPrice') }}</th>
                <th class="text-end">%</th>
                <th class="text-end">{{ $t('cashRegister.columns.vat') }}</th>
                <th class="text-end">{{ $t('cashRegister.columns.total') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in doc.lines" :key="i" data-testid="journal-line">
                <td>
                  {{ l.description }}
                  <v-chip v-if="l.unmatched" size="x-small" color="warning" variant="tonal" class="ml-1" :title="$t('cashRegister.detail.unmatched')">!</v-chip>
                </td>
                <td class="text-end">{{ l.quantity }} {{ l.unit || '' }}</td>
                <td class="text-end">{{ fmtCurrency(l.unitPrice, doc.row.currency, 4) }}</td>
                <td class="text-end">{{ l.taxRate }}</td>
                <td class="text-end">{{ fmtCurrency(l.taxAmount, doc.row.currency) }}</td>
                <td class="text-end">{{ fmtCurrency(l.lineTotal, doc.row.currency) }}</td>
              </tr>
            </tbody>
          </v-table>
          <div class="d-flex flex-column align-end mt-3">
            <div>{{ $t('cashRegister.columns.subtotal') }}: {{ fmtCurrency(doc.row.subtotal, doc.row.currency) }}</div>
            <div>{{ $t('cashRegister.columns.vat') }}: {{ fmtCurrency(doc.row.taxTotal, doc.row.currency) }}</div>
            <div class="text-h6" data-testid="journal-document-total">{{ $t('cashRegister.columns.total') }}: {{ fmtCurrency(doc.row.total, doc.row.currency) }}</div>
          </div>
        </v-card-text>
      </v-card>

      <v-row>
        <v-col cols="12" md="6">
          <v-card class="mb-4">
            <v-card-title class="text-subtitle-1">{{ $t('cashRegister.detail.payments') }}</v-card-title>
            <v-card-text>
              <div v-for="(p, i) in doc.row.payments" :key="i" class="d-flex justify-space-between">
                <span>{{ $t(paymentMethodKey(p.method)) }}</span>
                <span>
                  {{ fmtCurrency(p.amount, doc.row.currency) }}
                  <span v-if="p.tendered !== undefined" class="text-caption text-medium-emphasis">
                    ({{ $t('cashRegister.detail.tendered') }} {{ fmtCurrency(p.tendered, doc.row.currency) }},
                    {{ $t('cashRegister.detail.change') }} {{ fmtCurrency(p.tendered - p.amount, doc.row.currency) }})
                  </span>
                </span>
              </div>
              <div v-if="!doc.row.payments.length" class="text-medium-emphasis">—</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="6">
          <v-card class="mb-4">
            <v-card-title class="text-subtitle-1">{{ $t('cashRegister.detail.movements') }}</v-card-title>
            <v-card-text>
              <div v-for="m in doc.movements" :key="m.id" data-testid="journal-movement">{{ m.number }} · {{ m.type }} · {{ m.status }}</div>
              <div v-if="!doc.movements.length" class="text-medium-emphasis">—</div>
              <div v-if="doc.session?.journalEntryId" class="text-caption text-medium-emphasis mt-2">
                {{ $t('cashRegister.detail.journalEntry') }}: {{ doc.session.journalEntryId }}
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-card v-if="doc.notes" class="mb-4">
        <v-card-title class="text-subtitle-1">{{ $t('cashRegister.detail.notes') }}</v-card-title>
        <v-card-text style="white-space: pre-line">{{ doc.notes }}</v-card-text>
      </v-card>
    </template>

    <StornoDialog
      v-model="stornoOpen"
      :sale="stornoTarget"
      :org-url="orgUrl"
      :user-id="userId"
      :locale="locale"
      @done="onStornoDone"
      @held="load"
    />
  </v-container>
</template>

<script setup lang="ts">
/**
 * FR-21.13 — one cash-register sale or storno in full (`GET /cash-register/documents/:id`), from
 * whichever store holds it: its lines (an imported free-text line included, which counts and moves
 * nothing), its payments with what was tendered, its storno chain both ways, its stock and session.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RouteLocationRaw } from 'vue-router'
import StornoDialog from './StornoDialog.vue'
import { httpClient } from '../../composables/useHttpClient'
import { useCurrency } from '../../composables/useCurrency'
import { useSnackbar } from '../../composables/useSnackbar'
import { paymentMethodKey } from '../../composables/usePaymentMethods'
import { STORNO_ROLES, canStornoJournalRow } from '../../cash-register/storno'
import { givesBack, kindColor } from '../../cash-register/journal-kind'
import { receiptRefusalMessage } from '../../cash-register/receipt-refusal'

const props = defineProps<{
  orgUrl: string
  id: string
  locale?: string
  role?: string
  userId?: string
  backRoute: RouteLocationRaw
  /** Where a row of the storno chain opens. */
  relatedRoute: (row: any) => RouteLocationRaw
  /** The full document page for a row (print, email), or null where there is none. */
  documentRoute?: (row: any) => RouteLocationRaw | null
  /** Where the invoice a payment's receipt paid opens. A reader with no such page gets its number alone. */
  invoiceRoute?: (inv: { id: string; number: string }) => RouteLocationRaw
}>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()
const { showSuccess, showSnackbar } = useSnackbar()

const doc = ref<any | null>(null)
const loading = ref(false)
const notFound = ref(false)

async function load() {
  loading.value = true
  notFound.value = false
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/cash-register/documents/${props.id}`)
    doc.value = data
  } catch (e: any) {
    doc.value = null
    notFound.value = e?.response?.status === 404
  } finally {
    loading.value = false
  }
}

watch(() => [props.orgUrl, props.id], () => { if (props.id) void load() }, { immediate: true })

// FR-23: a payment's receipt has no form of its own: it names the invoice it paid, on this page. A refund's storno, the credit note.
const documentLink = computed(() => (doc.value && props.documentRoute && doc.value.row.kind !== 'payment' && doc.value.row.kind !== 'refund' ? props.documentRoute(doc.value.row) : null))
const canStorno = computed(() => canStornoJournalRow(doc.value?.row, props.role))

const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[props.locale || 'en'] || 'en-US')
function fmtCurrency(amount: number, currency?: string, digits?: number) {
  return formatCurrency(amount, currency || 'EUR', localeCode.value, digits)
}

const pad = (n: number) => String(n).padStart(2, '0')
function fmtDate(row: any): string {
  const d = new Date(row.date)
  if (Number.isNaN(d.getTime())) return ''
  if (!row.hasTime) return `${row.date.slice(0, 10)} (${t('cashRegister.noTime')})`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusColor(s: string) {
  return ({ completed: 'success', stornoed: 'warning', voided: 'grey-darken-1', inDoubt: 'warning' } as Record<string, string>)[s] || 'grey'
}

// ── FR-23: a receipt in doubt ──
// It decides what happened to money, so the same people as a storno, and asked twice.
const settleWords = computed(() => (({
  storno: { inDoubt: 'stornoInDoubt', confirm: 'settleConfirmStorno', done: 'stornoSettled' },
  refund: { inDoubt: 'refundInDoubt', confirm: 'settleConfirmRefund', done: 'refundSettled' },
  sale: { inDoubt: 'saleInDoubt', confirm: 'settleConfirmSale', done: 'saleSettled' },
} as Record<string, { inDoubt: string; confirm: string; done: string }>)[doc.value?.row.kind] ?? { inDoubt: 'inDoubt', confirm: 'settleConfirm', done: 'settled' }))
const settleNumber = ref('')
const canSettle = computed(() => !!props.role && (STORNO_ROLES as readonly string[]).includes(props.role))
const settling = ref<'printed' | 'notPrinted' | null>(null)
/** A storno cites the number: a sale must bring it, and a fiscal receipt may (R2's refund cites it). */
const takesNumber = computed(() => doc.value?.row.kind === 'sale' || (doc.value?.row.kind === 'payment' && !!doc.value?.row.fiscal?.isFiscal))
const settleNumberBad = computed(() => {
  if (!takesNumber.value) return false
  const typed = settleNumber.value.trim()
  return !/^\d+$/.test(typed) && (doc.value?.row.kind === 'sale' || typed !== '')
})
const settlingNow = ref(false)
async function settle() {
  settlingNow.value = true
  try {
    const printed = settling.value === 'printed'
    await httpClient.post(`${props.orgUrl}/cash-register/documents/${props.id}/settle`, {
      printed, ...(printed && takesNumber.value && settleNumber.value.trim() ? { receiptNumber: settleNumber.value.trim() } : {}),
    })
    showSuccess(t(`cashRegister.receipt.${settleWords.value.done}`))
  } catch (e: any) {
    showSnackbar(receiptRefusalMessage(t, e, t('common.operationFailed')), 'error', 12000)
  } finally {
    settlingNow.value = false
    settling.value = null
    void load()
  }
}

// ── #145: STORNO ────────────────────────────────────────────────────────────────────────────
const stornoOpen = ref(false)
const stornoTarget = computed(() => {
  const r = doc.value?.row
  return r
    ? { id: r.id, number: r.number, total: r.total, currency: r.currency, unp: r.fiscal?.unp, sessionId: r.sessionId, origin: r.origin, warehouseId: r.warehouseId }
    : null
})

function onStornoDone(result: { transaction: any; stockError?: string }) {
  if (result.stockError) showSnackbar(t('pos.stockNotMoved', { reason: result.stockError }), 'warning', 10000)
  else showSuccess(t('pos.storno.done', { number: result.transaction?.transactionNumber || '' }))
  void load()
}
</script>
