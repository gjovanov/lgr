<template>
  <v-card-text data-testid="product-suppliers-tab">
    <div class="text-body-2 text-medium-emphasis mb-1">{{ $t('warehouse.supplierFacts.tabIntro') }}</div>
    <div class="text-body-2 text-medium-emphasis mb-3">{{ $t('warehouse.recordedSuppliers.intro') }}</div>

    <v-progress-linear v-if="loading" indeterminate class="mb-3" />
    <v-alert v-else-if="failed" type="warning" variant="tonal" density="compact" data-testid="product-suppliers-tab-failed">
      {{ $t('warehouse.supplierFacts.loadFailed') }}
    </v-alert>
    <v-alert v-else-if="!rows.length" type="info" variant="tonal" density="compact" data-testid="product-suppliers-tab-empty">
      {{ $t('warehouse.supplierFacts.empty') }}
    </v-alert>

    <!-- One row per supplier: what a person recorded (preferred, the supplier's code, the lead time, a note) and what
         the documents say, side by side. A supplier recorded with no document behind it says so. -->
    <div v-if="rows.length" class="suppliers-scroll">
      <v-table density="compact" data-testid="product-supplier-facts">
        <thead>
          <tr>
            <th>{{ $t('warehouse.supplierFacts.supplier') }}</th>
            <th class="text-center">{{ $t('warehouse.recordedSuppliers.preferred') }}</th>
            <th>{{ $t('warehouse.recordedSuppliers.supplierSku') }}</th>
            <th class="text-end">{{ $t('warehouse.recordedSuppliers.leadTime') }}</th>
            <th>{{ $t('warehouse.recordedSuppliers.note') }}</th>
            <th class="facts-start">{{ $t('warehouse.supplierFacts.lastPurchase') }}</th>
            <th v-if="hasPrices" class="text-end">{{ $t('warehouse.supplierFacts.lastCost') }}</th>
            <th class="text-end">{{ $t('warehouse.supplierFacts.quantityBought') }}</th>
            <th class="text-end">{{ $t('warehouse.supplierFacts.documents') }}</th>
            <th>{{ $t('warehouse.supplierFacts.lastDocument') }}</th>
            <th v-if="canEdit" class="text-end" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.supplierId" data-testid="product-supplier-row">
            <td>
              <entity-link :label="row.supplierName || '—'" :href="contactHref(row.supplierId)" />
              <v-chip v-if="row.recorded && !row.fact" size="x-small" variant="tonal" color="info" class="ml-1" data-testid="recorded-no-documents">
                {{ $t('warehouse.recordedSuppliers.noDocuments') }}
              </v-chip>
              <v-chip v-if="row.recorded && !row.recorded.supplierActive" size="x-small" variant="tonal" color="warning" class="ml-1" data-testid="recorded-inactive">
                {{ $t('warehouse.recordedSuppliers.inactive') }}
                <v-tooltip activator="parent" location="top">{{ $t('warehouse.recordedSuppliers.inactiveHint') }}</v-tooltip>
              </v-chip>
            </td>

            <!-- Preferred: one per article. Setting it on another supplier moves it, which the reload shows. -->
            <td class="text-center">
              <v-btn
                v-if="canEdit"
                :icon="row.recorded?.preferred ? 'mdi-star' : 'mdi-star-outline'"
                :color="row.recorded?.preferred ? 'warning' : undefined"
                variant="text"
                size="small"
                :aria-pressed="row.recorded?.preferred ? 'true' : 'false'"
                :aria-label="row.recorded?.preferred ? $t('warehouse.recordedSuppliers.unsetPreferred') : $t('warehouse.recordedSuppliers.setPreferred')"
                :disabled="busy"
                data-testid="recorded-preferred"
                @click="togglePreferred(row)"
              >
                <v-icon>{{ row.recorded?.preferred ? 'mdi-star' : 'mdi-star-outline' }}</v-icon>
                <v-tooltip activator="parent" location="top">
                  {{ row.recorded?.preferred ? $t('warehouse.recordedSuppliers.unsetPreferred') : $t('warehouse.recordedSuppliers.setPreferred') }}
                </v-tooltip>
              </v-btn>
              <v-icon v-else-if="row.recorded?.preferred" color="warning" data-testid="recorded-preferred" :aria-label="$t('warehouse.recordedSuppliers.preferred')">mdi-star</v-icon>
            </td>

            <template v-if="editing === row.supplierId">
              <td>
                <v-text-field
                  v-model="draft.supplierSku" density="compact" variant="outlined" hide-details single-line autofocus
                  style="min-width: 140px" :maxlength="SKU_MAX" :aria-label="$t('warehouse.recordedSuppliers.supplierSku')"
                  data-testid="recorded-sku-input" @keydown.enter.prevent="save(row)" @keydown.esc.prevent="cancel"
                />
              </td>
              <td>
                <v-text-field
                  v-model="draft.leadTimeDays" type="number" min="0" max="3650" step="1" density="compact" variant="outlined" hide-details single-line
                  style="min-width: 90px" :aria-label="$t('warehouse.recordedSuppliers.leadTime')"
                  data-testid="recorded-lead-input" @keydown.enter.prevent="save(row)" @keydown.esc.prevent="cancel"
                />
              </td>
              <td>
                <v-text-field
                  v-model="draft.note" density="compact" variant="outlined" hide-details single-line
                  style="min-width: 220px" :maxlength="NOTE_MAX" :aria-label="$t('warehouse.recordedSuppliers.note')"
                  data-testid="recorded-note-input" @keydown.enter.prevent="save(row)" @keydown.esc.prevent="cancel"
                />
              </td>
            </template>
            <template v-else>
              <td class="text-no-wrap" data-testid="recorded-sku">{{ row.recorded?.supplierSku || '—' }}</td>
              <td class="text-end text-no-wrap" data-testid="recorded-lead">
                {{ row.recorded?.leadTimeDays === undefined ? '—' : row.recorded.leadTimeDays }}
              </td>
              <td class="note-cell" data-testid="recorded-note">{{ row.recorded?.note || '—' }}</td>
            </template>

            <td class="text-no-wrap facts-start">{{ row.fact ? fmtDate(row.fact.lastPurchasedAt) : '—' }}</td>
            <td v-if="hasPrices" class="text-end text-no-wrap">{{ !row.fact || row.fact.lastUnitPrice === undefined ? '—' : fmtPrice(row.fact.lastUnitPrice, row.fact.currency) }}</td>
            <td class="text-end">{{ row.fact ? fmtQty(row.fact.quantity) : '—' }}</td>
            <td class="text-end">{{ row.fact ? row.fact.documents : '—' }}</td>
            <td class="text-no-wrap">
              <template v-if="row.fact">
                <v-chip size="x-small" variant="tonal" class="mr-1">{{ kindLabel(row.fact.lastDocument.kind) }}</v-chip>
                <entity-link :label="row.fact.lastDocument.number || '—'" v-bind="documentLink(row.fact.lastDocument.kind, row.fact.lastDocument.id)" />
              </template>
              <template v-else>—</template>
            </td>

            <td v-if="canEdit" class="text-end text-no-wrap">
              <template v-if="editing === row.supplierId">
                <v-btn icon="mdi-check" size="small" variant="text" color="success" :loading="busy" :aria-label="$t('common.save')" data-testid="recorded-save" @click="save(row)" />
                <v-btn icon="mdi-close" size="small" variant="text" :disabled="busy" :aria-label="$t('common.cancel')" data-testid="recorded-cancel" @click="cancel" />
              </template>
              <template v-else>
                <v-btn icon="mdi-pencil" size="small" variant="text" :disabled="busy" :aria-label="$t('warehouse.recordedSuppliers.edit')" data-testid="recorded-edit" @click="startEdit(row)">
                  <v-icon>mdi-pencil</v-icon>
                  <v-tooltip activator="parent" location="top">{{ $t('warehouse.recordedSuppliers.edit') }}</v-tooltip>
                </v-btn>
                <v-btn v-if="row.recorded" icon="mdi-delete-outline" size="small" variant="text" :disabled="busy" :aria-label="$t('warehouse.recordedSuppliers.clear')" data-testid="recorded-clear" @click="clear(row)">
                  <v-icon>mdi-delete-outline</v-icon>
                  <v-tooltip activator="parent" location="top">{{ row.fact ? $t('warehouse.recordedSuppliers.clearKeepsFacts') : $t('warehouse.recordedSuppliers.clear') }}</v-tooltip>
                </v-btn>
              </template>
            </td>
          </tr>
        </tbody>
      </v-table>
    </div>

    <!-- Record another supplier for this article: a supplier of the organization, found as it is typed. -->
    <div v-if="canEdit && !loading && !failed" class="mt-3 add-supplier">
      <v-autocomplete
        v-model="chosen"
        v-model:search="supplierSearch"
        :items="supplierItems"
        item-title="name"
        item-value="_id"
        :loading="searching"
        :label="$t('warehouse.recordedSuppliers.add')"
        :placeholder="$t('warehouse.recordedSuppliers.addPlaceholder')"
        persistent-placeholder
        prepend-inner-icon="mdi-truck-delivery-outline"
        density="compact"
        variant="outlined"
        clearable
        hide-details
        no-filter
        :hide-no-data="!supplierSearch"
        :no-data-text="$t('warehouse.recordedSuppliers.noMatches')"
        :disabled="busy"
        data-testid="recorded-add"
        @update:model-value="addSupplier"
      />
    </div>

    <!-- The documents behind them, newest first: a bill or a receipt, each a link. -->
    <template v-if="documents.length">
      <div class="text-subtitle-2 mt-6 mb-1">{{ $t('warehouse.supplierFacts.recentDocuments') }}</div>
      <v-table density="compact" data-testid="product-supplier-documents">
        <thead>
          <tr>
            <th>{{ $t('warehouse.supplierFacts.date') }}</th>
            <th>{{ $t('warehouse.document') }}</th>
            <th>{{ $t('warehouse.supplierFacts.supplier') }}</th>
            <th class="text-end">{{ $t('warehouse.quantity') }}</th>
            <th v-if="hasPrices" class="text-end">{{ $t('warehouse.supplierFacts.price') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in documents" :key="d.kind + d.id" data-testid="product-supplier-document">
            <td class="text-no-wrap">{{ fmtDate(d.date) }}</td>
            <td class="text-no-wrap">
              <v-chip size="x-small" variant="tonal" class="mr-1">{{ kindLabel(d.kind) }}</v-chip>
              <entity-link :label="d.number || '—'" v-bind="documentLink(d.kind, d.id)" />
            </td>
            <td><entity-link :label="d.supplierName || '—'" :href="contactHref(d.supplierId)" /></td>
            <td class="text-end">{{ fmtQty(d.quantity) }}</td>
            <td v-if="hasPrices" class="text-end text-no-wrap">{{ d.unitPrice === undefined ? '—' : fmtPrice(d.unitPrice, d.currency) }}</td>
          </tr>
        </tbody>
      </v-table>
    </template>
  </v-card-text>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useAccess } from 'ui-shared/access/useAccess'
import EntityLink from 'ui-shared/components/EntityLink'
import { appHref } from 'ui-shared/nav/navigate'
import { useAppStore } from '../store/app.store'
import { formatUnitPrice } from '../composables/product-price-columns'

/**
 * FR-28.7 / FR-28.9 — an article's Suppliers tab: one row per supplier, with what a person recorded and what the
 * documents say side by side.
 *
 *   - FROM THE DOCUMENTS (read-only): the date and unit price of the last purchase, how much was bought, in how many
 *     documents, and the document last used, from the received bills and the receipts that name a supplier; and the
 *     last ten documents behind them. Nothing here is entered, so none of it can be changed or removed.
 *   - RECORDED (editable by whoever holds `products.edit`): whether the supplier is the PREFERRED one (one per
 *     article: choosing another moves it), the supplier's own code for the article, the lead time and a note. A
 *     supplier a person recorded with no document behind it is listed too, with a badge saying so; clearing the
 *     recorded details of a supplier the documents name leaves it listed, with its facts.
 *
 * Editing is in the row: the pencil turns the code, the lead time and the note into inputs (Enter saves, Escape
 * cancels); the star saves at once. Every save replaces the recorded fields as a whole and reloads the tab, so a
 * preference that moved shows where it went.
 */
interface Fact {
  supplierId: string
  supplierName: string
  lastPurchasedAt: string
  lastUnitPrice?: number
  currency?: string
  quantity: number
  documents: number
  lastDocument: { kind: 'bill' | 'receipt'; id: string; number: string }
}
interface Recorded {
  supplierId: string
  supplierName: string
  supplierActive: boolean
  preferred: boolean
  supplierSku?: string
  leadTimeDays?: number
  note?: string
}
interface Doc {
  kind: 'bill' | 'receipt'
  id: string
  number: string
  date: string
  supplierId: string
  supplierName: string
  quantity: number
  unitPrice?: number
  currency?: string
}
interface Row {
  supplierId: string
  supplierName: string
  fact?: Fact
  recorded?: Recorded
}

/** The server's limits (`recorded-suppliers.service.ts`): the inputs stop there, and the server holds them too. */
const SKU_MAX = 100
const NOTE_MAX = 500

const props = defineProps<{ productId: string }>()
const { t } = useI18n()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()
/** Recording a supplier is editing the article (`products.edit`); anyone who reads the tab sees what is recorded. */
const canEdit = useAccess().can('products.edit')

const facts = ref<Fact[]>([])
const recorded = ref<Recorded[]>([])
const documents = ref<Doc[]>([])
const loading = ref(false)
const failed = ref(false)
const busy = ref(false)

const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
/** The server leaves the price out for a caller who may not see costs (FR-28.6): no column for it then. */
const hasPrices = computed(() => facts.value.some((s) => s.lastUnitPrice !== undefined) || documents.value.some((d) => d.unitPrice !== undefined))

/**
 * The preferred supplier first, then the suppliers the documents name, most recent first (the order the server gives
 * them), then the ones only a person recorded, by name. With nothing recorded the order is the facts' own.
 */
const rows = computed<Row[]>(() => {
  const byId = new Map<string, Row>()
  for (const f of facts.value) byId.set(f.supplierId, { supplierId: f.supplierId, supplierName: f.supplierName, fact: f })
  for (const r of recorded.value) {
    const row = byId.get(r.supplierId)
    if (row) { row.recorded = r; row.supplierName ||= r.supplierName }
    else byId.set(r.supplierId, { supplierId: r.supplierId, supplierName: r.supplierName, recorded: r })
  }
  const all = [...byId.values()]
  const rank = (r: Row) => (r.recorded?.preferred ? 0 : r.fact ? 1 : 2)
  const factOrder = new Map(facts.value.map((f, i) => [f.supplierId, i]))
  return all.sort((a, b) =>
    rank(a) - rank(b)
    || (factOrder.get(a.supplierId) ?? 0) - (factOrder.get(b.supplierId) ?? 0)
    || a.supplierName.localeCompare(b.supplierName))
})

const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleDateString(localeCode.value) : '')
const fmtQty = (n: number) => new Intl.NumberFormat(localeCode.value, { maximumFractionDigits: 3 }).format(n || 0)
const fmtPrice = (amount: number, currency?: string) => formatUnitPrice(amount, currency || baseCurrency.value, localeCode.value)
const kindLabel = (kind: 'bill' | 'receipt') => t(kind === 'bill' ? 'warehouse.supplierFacts.kindBill' : 'warehouse.supplierFacts.kindReceipt')
const contactHref = (id: string) => appHref('invoicing', `/invoicing/contacts/${id}/edit`)
/** A bill opens in the invoicing app, a receipt in this one. */
function documentLink(kind: 'bill' | 'receipt', id: string): { href?: string; to?: object } {
  return kind === 'bill'
    ? { href: appHref('invoicing', `/invoicing/bills/${id}/edit`) }
    : { to: { name: 'inventory.movements.view', params: { id } } }
}

// A slower answer for an earlier article never overwrites the current one.
let request = 0
async function load(quiet = false) {
  if (!props.productId) return
  const mine = ++request
  if (!quiet) loading.value = true
  failed.value = false
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-supplier/${props.productId}`)
    if (mine !== request) return
    facts.value = data.suppliers || []
    recorded.value = data.recorded || []
    documents.value = data.documents || []
  } catch {
    if (mine !== request) return
    facts.value = []
    recorded.value = []
    documents.value = []
    failed.value = true
  } finally {
    if (mine === request) loading.value = false
  }
}

// ── Editing in the row ─────────────────────────────────────────────────────────────────────────────
const editing = ref<string | null>(null)
const draft = reactive({ supplierSku: '', leadTimeDays: '' as string | number, note: '' })

function startEdit(row: Row) {
  editing.value = row.supplierId
  draft.supplierSku = row.recorded?.supplierSku ?? ''
  draft.leadTimeDays = row.recorded?.leadTimeDays ?? ''
  draft.note = row.recorded?.note ?? ''
}
function cancel() {
  editing.value = null
}

const ERROR_KEYS: Record<string, string> = {
  supplier_inactive: 'warehouse.recordedSuppliers.errors.supplierInactive',
  not_a_supplier: 'warehouse.recordedSuppliers.errors.notASupplier',
  supplier_not_found: 'warehouse.recordedSuppliers.errors.supplierNotFound',
  too_long: 'warehouse.recordedSuppliers.errors.tooLong',
  invalid_lead_time: 'warehouse.recordedSuppliers.errors.invalidLeadTime',
  preferred_conflict: 'warehouse.recordedSuppliers.errors.preferredConflict',
}
const failure = (e: any) => showError(ERROR_KEYS[e?.response?.data?.code] ? t(ERROR_KEYS[e.response.data.code]) : t('warehouse.recordedSuppliers.errors.generic'))

const urlOf = (supplierId: string) => `${appStore.orgUrl()}/warehouse/product/${props.productId}/suppliers/${supplierId}`

/** Replace the recorded fields of one supplier as a whole (the server's PUT), then reload what the tab shows. */
async function put(supplierId: string, body: { preferred: boolean; supplierSku?: string; leadTimeDays?: number; note?: string }): Promise<boolean> {
  busy.value = true
  try {
    await httpClient.put(urlOf(supplierId), body)
    await load(true)
    return true
  } catch (e) {
    failure(e)
    return false
  } finally {
    busy.value = false
  }
}

async function save(row: Row) {
  const lead = String(draft.leadTimeDays).trim()
  const saved = await put(row.supplierId, {
    preferred: !!row.recorded?.preferred,
    supplierSku: draft.supplierSku.trim() || undefined,
    leadTimeDays: lead === '' ? undefined : Number(lead),
    note: draft.note.trim() || undefined,
  })
  if (saved) {
    editing.value = null
    showSuccess(t('warehouse.recordedSuppliers.saved'))
  }
}

async function togglePreferred(row: Row) {
  await put(row.supplierId, {
    preferred: !row.recorded?.preferred,
    supplierSku: row.recorded?.supplierSku,
    leadTimeDays: row.recorded?.leadTimeDays,
    note: row.recorded?.note,
  })
}

async function clear(row: Row) {
  busy.value = true
  try {
    await httpClient.delete(urlOf(row.supplierId))
    if (editing.value === row.supplierId) editing.value = null
    await load(true)
    showSuccess(t(row.fact ? 'warehouse.recordedSuppliers.clearedKeepsFacts' : 'warehouse.recordedSuppliers.cleared'))
  } catch (e) {
    failure(e)
  } finally {
    busy.value = false
  }
}

// ── Recording another supplier ─────────────────────────────────────────────────────────────────────
const chosen = ref<string | null>(null)
const supplierSearch = ref('')
const searching = ref(false)
const found = ref<Array<{ _id: string; name: string }>>([])
const contactName = (c: any): string => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id
/** Suppliers already in the table are not offered again. */
const supplierItems = computed(() => {
  const listed = new Set(rows.value.map((r) => r.supplierId))
  return found.value.filter((s) => !listed.has(s._id))
})

let searchRequest = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
async function searchSuppliers(q: string) {
  const mine = ++searchRequest
  searching.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, {
      params: { type: 'supplier', size: 20, sortBy: 'companyName', sortOrder: 'asc', ...(q ? { search: q } : {}) },
    })
    if (mine === searchRequest) {
      found.value = (data.contacts || []).filter((c: any) => c.isActive !== false).map((c: any) => ({ _id: c._id, name: contactName(c) }))
    }
  } catch { /* the field keeps what it has */ } finally {
    if (mine === searchRequest) searching.value = false
  }
}
watch(supplierSearch, (q) => {
  // The field's own text after a pick is the picked name: searching it again would only narrow the list to one.
  if (chosen.value) return
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => searchSuppliers(q || ''), 300)
})

async function addSupplier(supplierId: string | null) {
  if (!supplierId) return
  const saved = await put(supplierId, { preferred: false })
  chosen.value = null
  supplierSearch.value = ''
  if (saved) {
    const row = rows.value.find((r) => r.supplierId === supplierId)
    if (row) startEdit(row)
  }
}

watch(() => props.productId, () => { editing.value = null; void load() }, { immediate: true })
// The first suppliers are asked for when the tab is, not when a person types: the field opens with choices.
if (canEdit) void searchSuppliers('')
</script>

<style scoped>
.suppliers-scroll {
  overflow-x: auto;
}
/* What the documents say starts after the recorded columns: a rule between the two kinds of cell. */
.facts-start {
  border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.note-cell {
  max-width: 260px;
  min-width: 140px;
  white-space: normal;
  overflow-wrap: anywhere;
}
.add-supplier {
  max-width: 420px;
}
</style>
