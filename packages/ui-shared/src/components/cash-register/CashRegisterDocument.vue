<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <v-btn icon="mdi-arrow-left" variant="text" :to="backRoute" :aria-label="$t('cashRegister.detail.back')" />
      <h1 class="text-h5" data-testid="journal-document-title">{{ doc?.row.number || '' }}</h1>
      <template v-if="doc">
        <v-chip size="small" label :color="doc.row.kind === 'storno' ? 'error' : 'success'">{{ $t(`cashRegister.kind.${doc.row.kind}`) }}</v-chip>
        <v-chip size="small" label :color="statusColor(doc.row.status)" data-testid="journal-document-status">{{ $t(`cashRegister.status.${doc.row.status}`) }}</v-chip>
        <v-chip size="small" variant="tonal">{{ $t(`cashRegister.origin.${doc.row.origin}`) }}</v-chip>
      </template>
      <v-spacer />
      <v-btn v-if="doc && documentLink" variant="outlined" prepend-icon="mdi-file-document-outline" :href="typeof documentLink === 'string' ? documentLink : undefined" :to="typeof documentLink === 'string' ? undefined : documentLink">
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
          </v-row>
        </v-card-text>
      </v-card>

      <!-- The storno chain, both ways. -->
      <v-card v-if="doc.related.length" class="mb-4">
        <v-card-title class="text-subtitle-1">{{ $t('cashRegister.detail.related') }}</v-card-title>
        <v-card-text>
          <div v-for="r in doc.related" :key="r.id" class="d-flex align-center ga-2 mb-1" data-testid="journal-related">
            <span class="text-caption text-medium-emphasis">{{ r.kind === 'storno' ? $t('cashRegister.detail.stornoedBy') : $t('cashRegister.detail.stornoOf') }}</span>
            <router-link :to="relatedRoute(r)" class="text-decoration-none">{{ r.number }}</router-link>
            <span>{{ fmtCurrency(r.kind === 'storno' ? -r.total : r.total, r.currency) }}</span>
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
                <span>{{ p.method }}</span>
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
import { canStornoJournalRow } from '../../cash-register/storno'

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
  documentRoute?: (row: any) => RouteLocationRaw | string | null
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

const documentLink = computed(() => (doc.value && props.documentRoute ? props.documentRoute(doc.value.row) : null))
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
  return ({ completed: 'success', stornoed: 'warning', voided: 'grey-darken-1' } as Record<string, string>)[s] || 'grey'
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
