<template>
  <ListScaffold
    :title="$t('cashRegister.title')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    item-value="id"
    grid-id="cash-register.journal"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-cash-register', title: $t('cashRegister.empty'), description: $t('cashRegister.emptyHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <slot name="actions" :filters="filters" :refresh="fetchItems" />
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="kind" :items="kindOptions" :label="$t('cashRegister.filters.kind')" clearable hide-details density="compact" data-testid="journal-kind" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="origin" :items="originOptions" :label="$t('cashRegister.filters.origin')" clearable hide-details density="compact" data-testid="journal-origin" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="status" :items="statusOptions" :label="$t('cashRegister.filters.status')" clearable hide-details density="compact" data-testid="journal-status" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="fiscalState" :items="fiscalStateOptions" :label="$t('cashRegister.filters.fiscalState')" clearable hide-details density="compact" data-testid="journal-fiscal-state" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="method" :items="methodOptions" :label="$t('cashRegister.filters.paymentMethod')" clearable hide-details density="compact" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="invoiced" :items="invoicedOptions" :label="$t('invoicing.cashSaleInvoice.filterInvoiced')" clearable hide-details density="compact" data-testid="journal-invoiced" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <DateField v-model="dateFrom" :label="$t('invoicing.dateFrom')" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <DateField v-model="dateTo" :label="$t('invoicing.dateTo')" />
        </v-col>
        <!-- From a session's „Касови продажби": that session's documents. Named by the rows' own
             session number, which a reader without `pos.*` can see too. -->
        <v-col v-if="session" cols="12" class="pt-0">
          <v-chip closable color="primary" variant="tonal" data-testid="journal-session-chip" @click:close="session = ''">
            {{ $t('cashRegister.filters.session', { number: items[0]?.sessionNumber || '…' }) }}
          </v-chip>
        </v-col>
      </FilterBar>
    </template>

    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="detailRoute(item)" />
    </template>
    <!-- The row's methods in the reader's language; `paymentLabel` is the same in words, for an API. -->
    <template #item.paymentLabel="{ item }">{{ paymentText(item) }}</template>
    <template #item.date="{ item }">
      <span :title="item.hasTime ? '' : $t('cashRegister.noTime')">{{ fmtDate(item) }}</span>
    </template>
    <template #item.kind="{ item }">
      <v-chip size="small" label :color="kindColor(item.kind)" data-testid="journal-kind-chip">
        {{ $t(`cashRegister.kind.${item.kind}`) }}
      </v-chip>
    </template>
    <template #item.origin="{ item }">
      <v-chip size="small" variant="tonal">{{ $t(`cashRegister.origin.${item.origin}`) }}</v-chip>
    </template>
    <template #item.total="{ item }">
      <span :class="{ 'text-error': item.kind === 'storno' }">{{ fmtCurrency(item.kind === 'storno' ? -item.total : item.total, item.currency) }}</span>
    </template>
    <template #item.subtotal="{ item }">{{ fmtCurrency(item.subtotal, item.currency) }}</template>
    <template #item.taxTotal="{ item }">{{ fmtCurrency(item.taxTotal, item.currency) }}</template>
    <template #item.fiscal="{ item }">
      <span v-if="item.fiscal.unp" class="text-caption" :title="item.fiscal.receiptNumber || ''">{{ item.fiscal.unp }}</span>
      <span v-else-if="item.fiscal.state && item.fiscal.state !== 'none'" class="text-caption">{{ $t(`cashRegister.fiscalState.${item.fiscal.state}`) }}</span>
      <span v-else class="text-medium-emphasis">—</span>
    </template>
    <template #item.device="{ item }">{{ item.fiscal.deviceNumber || '' }}</template>
    <template #item.status="{ item }">
      <v-chip size="small" label :color="statusColor(item.status)" data-testid="journal-status-chip">
        {{ $t(`cashRegister.status.${item.status}`) }}
      </v-chip>
    </template>
    <!-- #171: the invoices issued for a cash sale, read back from them. -->
    <template #item.invoices="{ item }">
      <div class="d-flex flex-wrap ga-1">
        <v-chip
          v-for="inv in item.invoices || []"
          :key="inv.id"
          size="x-small"
          variant="tonal"
          :color="item.invoicingState === 'full' ? 'primary' : 'warning'"
          :to="invoiceLink(inv)"
          :title="item.kind === 'payment' ? $t('cashRegister.receipt.paidInvoice') : item.invoicingState === 'partial' ? $t('invoicing.cashSaleInvoice.statePartial') : $t('invoicing.cashSaleInvoice.stateFull')"
        >
          {{ inv.number }}
        </v-chip>
      </div>
    </template>
    <template #item.stock="{ item }">
      <span :class="{ 'text-error': item.stock === 'error' }">{{ $t(`cashRegister.stock.${item.stock}`) }}</span>
    </template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-eye" size="small" variant="text" :to="detailRoute(item)" :title="$t('cashRegister.view')" :aria-label="$t('cashRegister.view')" />
      <!-- #145: STORNO straight from the journal, in either app. -->
      <v-btn
        v-if="canStorno(item)"
        size="small"
        variant="tonal"
        color="error"
        class="ml-1"
        prepend-icon="mdi-undo-variant"
        data-testid="storno-button"
        @click="openStorno(item)"
      >
        {{ $t('pos.storno.button') }}
      </v-btn>
      <slot name="row-actions" :item="item" :refresh="fetchItems" />
    </template>

    <StornoDialog
      v-model="stornoOpen"
      :sale="stornoTarget"
      :org-url="orgUrl"
      :user-id="userId"
      :locale="locale"
      @done="onStornoDone"
    />
  </ListScaffold>
</template>

<script setup lang="ts">
/**
 * FR-21.13 — „Касови продажби": the cash-register journal.
 *
 * Invoicing mounts it at `/invoicing/cash-sales`: the rows of `GET /cash-register/documents`, the
 * till's sales, the back office's and the imports'. The app adds its own buttons through the slots,
 * and says where a row opens (`detailRoute`). Column choices are kept under one grid id.
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RouteLocationRaw } from 'vue-router'
import ListScaffold from '../ListScaffold.vue'
import FilterBar from '../FilterBar.vue'
import DateField from '../DateField.vue'
import EntityLink from '../EntityLink.vue'
import StornoDialog from './StornoDialog.vue'
import { usePaginatedTable } from '../../composables/usePaginatedTable'
import { useSearchDebounce } from '../../composables/useSearchDebounce'
import { useListQueryState } from '../../composables/useListQueryState'
import { useCurrency } from '../../composables/useCurrency'
import { useSnackbar } from '../../composables/useSnackbar'
import { paymentMethodKey } from '../../composables/usePaymentMethods'
import { canStornoJournalRow } from '../../cash-register/storno'
import { kindColor } from '../../cash-register/journal-kind'

const props = defineProps<{
  orgUrl: string
  locale?: string
  role?: string
  userId?: string
  /** Where a row opens. */
  detailRoute: (row: any) => RouteLocationRaw
  /** Where an invoice issued for a sale opens (#171), or nothing where the reader has no such page. */
  invoiceLink: (inv: { id: string; number: string }) => RouteLocationRaw | undefined
}>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()
const { showSuccess, showSnackbar } = useSnackbar()

const KINDS = ['sale', 'storno', 'payment']
const ORIGINS = ['pos', 'backoffice', 'import']
const STATUSES = ['completed', 'stornoed', 'voided']
const FISCAL_STATES = ['printed', 'pending', 'failed', 'unknown', 'none']
const METHODS = ['cash', 'card', 'cash_on_delivery', 'bank_transfer', 'other']
const INVOICED = ['yes', 'no']

const { search, debouncedSearch } = useSearchDebounce()
const kind = ref<string | null>(null)
const origin = ref<string | null>(null)
const status = ref<string | null>(null)
const fiscalState = ref<string | null>(null)
const method = ref<string | null>(null)
// #171: invoiced or not — the link lives on the invoices, so the server resolves it.
const invoiced = ref<string | null>(null)
const dateFrom = ref<string | null>(null)
const dateTo = ref<string | null>(null)
/** One session's documents (a session id), from the sessions page; '' is every session. */
const session = ref('')

const kindOptions = computed(() => KINDS.map(value => ({ value, title: t(`cashRegister.kind.${value}`) })))
const originOptions = computed(() => ORIGINS.map(value => ({ value, title: t(`cashRegister.origin.${value}`) })))
const statusOptions = computed(() => STATUSES.map(value => ({ value, title: t(`cashRegister.status.${value}`) })))
// "None" reads as a word here; in a cell it is a dash.
const fiscalStateOptions = computed(() => FISCAL_STATES.map(value => ({
  value,
  title: value === 'none' ? t('cashRegister.fiscalState.noReceipt') : t(`cashRegister.fiscalState.${value}`),
})))
const invoicedOptions = computed(() => INVOICED.map(value => ({ value, title: t(`common.${value}`) })))
const methodOptions = computed(() => METHODS.map(value => ({ value, title: t(paymentMethodKey(value)) })))
function paymentText(row: { payments?: { method: string }[] }): string {
  return [...new Set((row.payments || []).map(p => p.method))].map(m => t(paymentMethodKey(m))).join(' + ')
}

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !!kind.value || !!origin.value || !!status.value || !!fiscalState.value || !!method.value
  || !!invoiced.value || !!dateFrom.value || !!dateTo.value || !!session.value)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (kind.value) f.kind = kind.value
  if (origin.value) f.origin = origin.value
  if (status.value) f.status = status.value
  if (fiscalState.value) f.fiscalState = fiscalState.value
  if (method.value) f.paymentMethod = method.value
  if (invoiced.value) f.invoiced = invoiced.value
  if (dateFrom.value) f.dateFrom = dateFrom.value
  if (dateTo.value) f.dateTo = dateTo.value
  if (session.value) f.sessionId = session.value
  return f
})

/**
 * FR-05: the filters live in the URL. A value this journal does not know — an old link's
 * `status=draft,completed,paid`, from the invoicing list it replaced — is dropped, which reads as
 * "all", rather than filtering to nothing.
 */
const known = (list: string[]) => (v: any) => (typeof v === 'string' && list.includes(v) ? v : undefined)
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'kind', ref: kind, sanitize: known(KINDS) },
  { key: 'origin', ref: origin, sanitize: known(ORIGINS) },
  { key: 'status', ref: status, sanitize: known(STATUSES) },
  { key: 'receipt', ref: fiscalState, sanitize: known(FISCAL_STATES) },
  { key: 'method', ref: method, sanitize: known(METHODS) },
  { key: 'invoiced', ref: invoiced, sanitize: known(INVOICED) },
  { key: 'from', ref: dateFrom, codec: 'date' },
  { key: 'to', ref: dateTo, codec: 'date' },
  // A session's id and nothing else: anything else is no session, which reads as every one.
  { key: 'session', ref: session, sanitize: (v: any) => (typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v) ? v : undefined) },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${props.orgUrl}/cash-register/documents`),
  entityKey: 'rows',
  filters,
  defaultSize: 25,
  defaultSortBy: 'date',
  defaultSortOrder: 'desc',
  urlSync: true,
})

const headers = computed(() => [
  { title: t('cashRegister.columns.number'), key: 'number', sortable: true },
  { title: t('cashRegister.columns.date'), key: 'date', sortable: true },
  { title: t('cashRegister.columns.kind'), key: 'kind', sortable: false },
  { title: t('cashRegister.columns.origin'), key: 'origin', sortable: false },
  { title: t('cashRegister.columns.customer'), key: 'contactName', sortable: false },
  { title: t('cashRegister.columns.payment'), key: 'paymentLabel', sortable: false },
  { title: t('cashRegister.columns.total'), key: 'total', sortable: true, align: 'end' as const },
  { title: t('cashRegister.columns.fiscal'), key: 'fiscal', sortable: false },
  { title: t('cashRegister.columns.status'), key: 'status', sortable: false },
  // #171: the invoices issued for a cash sale. On by default, as on the list it came from.
  { title: t('invoicing.cashSaleInvoice.column'), key: 'invoices', sortable: false },
  // Off by default (FR-21 §3.4); the column picker turns them on.
  { title: t('cashRegister.columns.session'), key: 'sessionNumber', sortable: false, defaultHidden: true },
  { title: t('cashRegister.columns.cashier'), key: 'cashierName', sortable: false, defaultHidden: true },
  { title: t('cashRegister.columns.warehouse'), key: 'warehouseName', sortable: false, defaultHidden: true },
  { title: t('cashRegister.columns.device'), key: 'device', sortable: false, defaultHidden: true },
  { title: t('cashRegister.columns.subtotal'), key: 'subtotal', sortable: false, align: 'end' as const, defaultHidden: true },
  { title: t('cashRegister.columns.vat'), key: 'taxTotal', sortable: false, align: 'end' as const, defaultHidden: true },
  { title: t('cashRegister.columns.stock'), key: 'stock', sortable: false, defaultHidden: true },
  { title: t('cashRegister.columns.reference'), key: 'reference', sortable: false, defaultHidden: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[props.locale || 'en'] || 'en-US')
function fmtCurrency(amount: number, currency?: string) {
  return formatCurrency(amount, currency || 'EUR', localeCode.value)
}

const pad = (n: number) => String(n).padStart(2, '0')
/** The local date, and the time when the sale has one (an imported day does not). */
function fmtDate(row: any): string {
  const d = new Date(row.date)
  if (Number.isNaN(d.getTime())) return ''
  if (!row.hasTime) return row.date.slice(0, 10)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusColor(s: string) {
  return ({ completed: 'success', stornoed: 'warning', voided: 'grey-darken-1' } as Record<string, string>)[s] || 'grey'
}

// ── #145: STORNO ────────────────────────────────────────────────────────────────────────────
const stornoOpen = ref(false)
const stornoTarget = ref<any | null>(null)

function canStorno(row: any) {
  return canStornoJournalRow(row, props.role)
}

function openStorno(row: any) {
  stornoTarget.value = {
    id: row.id, number: row.number, total: row.total, currency: row.currency, unp: row.fiscal?.unp,
    sessionId: row.sessionId, origin: row.origin, warehouseId: row.warehouseId,
  }
  stornoOpen.value = true
}

function onStornoDone(result: { transaction: any; receiptError?: string; stockError?: string }) {
  const warnings = [result.stockError && t('pos.stockNotMoved', { reason: result.stockError })].filter(Boolean)
  if (warnings.length) showSnackbar(warnings.join(' · '), 'warning', 10000)
  else showSuccess(t('pos.storno.done', { number: result.transaction?.transactionNumber || '' }))
  void fetchItems()
}

onMounted(() => {
  fetchItems()
})

defineExpose({ fetchItems })
</script>
