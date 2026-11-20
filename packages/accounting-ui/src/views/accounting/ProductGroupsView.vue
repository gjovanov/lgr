<template>
  <v-container v-if="settingsKnown && !books" fluid>
    <h1 class="text-h5 mb-4">{{ $t('accounting.productGroups.title') }}</h1>
    <v-alert type="info" variant="tonal" data-testid="product-groups-not-books">{{ $t('accounting.productGroups.notBooks') }}</v-alert>
  </v-container>

  <ListScaffold
    v-else
    :title="$t('accounting.productGroups.title')"
    :subtitle="$t('accounting.productGroups.subtitle')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :kpis="kpis"
    :has-active-filters="hasActiveFilters"
    :empty="emptyState"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    :items-per-page-options="PAGE_SIZES"
    item-value="productId"
    fit
    @update:options="onUpdateOptions"
    @kpi-click="onKpi"
  >
    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="3">
          <v-select v-model="filter" :label="$t('accounting.productGroups.show')" :items="filterOptions" data-testid="product-groups-filter" />
        </v-col>
        <v-col cols="6" sm="3" md="2">
          <DateField v-model="from" :label="$t('accounting.productGroups.from')" :placeholder="$t('accounting.productGroups.fromStart')" persistent-placeholder clearable />
        </v-col>
        <v-col cols="6" sm="3" md="2">
          <DateField v-model="to" :label="$t('accounting.productGroups.to')" :placeholder="$t('accounting.productGroups.today')" persistent-placeholder clearable />
        </v-col>
      </FilterBar>
    </template>

    <!-- When the documents were read, and whether they are being read again after a change. -->
    <template #results-actions>
      <span v-if="answer" class="text-caption text-medium-emphasis mr-2 d-inline-flex align-center" data-testid="product-groups-evidence">
        <v-progress-circular v-if="!answer.evidence.fresh" indeterminate size="12" width="2" class="mr-1" />
        {{ answer.evidence.fresh
          ? $t('accounting.productGroups.evidenceAt', { at: formatDateTime(answer.evidence.computedAt) })
          : $t('accounting.productGroups.refreshing') }}
      </span>
    </template>

    <template #item.name="{ item }">
      <entity-link
        class="cell-clip product-cell"
        :label="item.name || item.productId"
        :to="productPath(item.productId)"
        :title="item.sku ? `${item.name} · ${item.sku}` : item.name"
      />
    </template>
    <template #item.state="{ item }">
      <v-chip size="small" label :color="stateColor(item.state)">{{ $t(stateLabelKey(item.state)) }}</v-chip>
      <v-icon v-if="item.oneDocument" size="small" class="ml-1" icon="mdi-alert-outline" :title="$t('accounting.productGroups.oneDocument')" />
    </template>
    <template #item.group="{ item }">
      <span v-if="item.stored" class="cell-clip group-cell" :title="storedTitle(item)">
        {{ analyticLabel(item.stored.analyticId) }}
        <span class="text-caption text-medium-emphasis">· {{ storedCaption(item) }}</span>
        <span v-if="item.suggestion" class="text-caption text-primary">
          · {{ $t('accounting.productGroups.suggestion', { group: analyticLabel(item.suggestion.analyticId) }) }}
        </span>
      </span>
      <span v-else-if="item.suggestion" class="cell-clip group-cell text-medium-emphasis font-italic">
        {{ $t('accounting.productGroups.suggestion', { group: analyticLabel(item.suggestion.analyticId) }) }}
      </span>
      <span v-else-if="item.groups.length > 1" class="text-medium-emphasis">
        {{ $t('accounting.productGroups.groupsNamed', item.groups.length) }}
      </span>
      <span v-else class="text-medium-emphasis">—</span>
    </template>
    <template #item.value="{ item }">{{ formatMoney(item.value, currency) }}</template>
    <template #item.lines="{ item }">{{ formatNumber(item.lines) }}</template>
    <template #item.actions="{ item }">
      <div class="d-flex justify-end align-center ga-1">
        <v-btn
          v-if="actionsOf(item).accept"
          v-cap="'accounts.edit'"
          size="small"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-check"
          :loading="busy === item.productId"
          :title="$t('accounting.productGroups.acceptHint', { group: analyticLabel(item.suggestion.analyticId) })"
          data-testid="product-groups-accept"
          @click="accept(item)"
        >
          {{ $t('accounting.productGroups.accept') }}
        </v-btn>
        <v-btn
          v-if="actionsOf(item).confirm"
          v-cap="'accounts.edit'"
          size="small"
          variant="tonal"
          color="success"
          prepend-icon="mdi-check-decagram-outline"
          :loading="busy === item.productId"
          :title="$t('accounting.productGroups.confirmHint')"
          data-testid="product-groups-confirm"
          @click="confirmRow(item)"
        >
          {{ $t('accounting.productGroups.confirm') }}
        </v-btn>
        <v-btn
          v-cap="'accounts.edit'"
          icon="mdi-pencil"
          size="small"
          variant="text"
          :disabled="busy === item.productId"
          :title="$t('accounting.productGroups.set')"
          :aria-label="$t('accounting.productGroups.set')"
          data-testid="product-groups-set"
          @click="openSet(item)"
        />
        <v-btn
          v-if="actionsOf(item).withdraw"
          v-cap="'accounts.edit'"
          icon="mdi-undo-variant"
          size="small"
          variant="text"
          color="warning"
          :disabled="busy === item.productId"
          :title="$t('accounting.productGroups.withdraw')"
          :aria-label="$t('accounting.productGroups.withdraw')"
          data-testid="product-groups-withdraw"
          @click="withdraw(item)"
        />
      </div>
    </template>

    <!-- The documents behind the row: per group they name, and those against the group learning gave. -->
    <template #expanded-row="{ columns, item }">
      <tr>
        <td :colspan="columns.length" class="pa-3" data-testid="product-groups-evidence-row">
          <div v-if="item.oneDocument" class="text-caption mb-2">
            <v-icon size="small" icon="mdi-alert-outline" /> {{ $t('accounting.productGroups.oneDocument') }}
          </div>
          <div v-if="!item.groups.length && !item.contradicting.docs" class="text-medium-emphasis">
            {{ $t('accounting.productGroups.noEvidence') }}
          </div>
          <div v-for="g in item.groups" :key="g.analyticId" class="mb-3">
            <div class="d-flex align-center flex-wrap ga-2 mb-1">
              <span class="font-weight-medium" :title="analyticPath(g.analyticId)">{{ analyticLabel(g.analyticId) }}</span>
              <span class="text-caption text-medium-emphasis">
                {{ $t('accounting.productGroups.documentsOf', { n: g.docs, day: day(g.last) }, g.docs) }}
              </span>
              <v-btn
                v-if="g.analyticId === item.stored?.analyticId && actionsOf(item).confirm"
                v-cap="'accounts.edit'"
                size="x-small"
                variant="text"
                color="success"
                :loading="busy === item.productId"
                @click="confirmRow(item)"
              >
                {{ $t('accounting.productGroups.confirm') }}
              </v-btn>
              <v-btn
                v-else-if="g.analyticId !== item.stored?.analyticId && isActiveGroup(g.analyticId)"
                v-cap="'accounts.edit'"
                size="x-small"
                variant="text"
                color="primary"
                :loading="busy === item.productId"
                data-testid="product-groups-use"
                @click="setGroup(item, g.analyticId)"
              >
                {{ $t('accounting.productGroups.useThis') }}
              </v-btn>
            </div>
            <ProductGroupDocuments :documents="g.documents" :total="g.docs" />
          </div>
          <div v-if="item.contradicting.docs" class="mb-1">
            <div class="font-weight-medium mb-1">
              {{ $t('accounting.productGroups.contradicting', { n: item.contradicting.docs }, item.contradicting.docs) }}
            </div>
            <ProductGroupDocuments :documents="item.contradicting.documents" :total="item.contradicting.docs" />
          </div>
        </td>
      </tr>
    </template>

    <!-- The accountant's group for a product: one the documents name in a click, or any active goods group. -->
    <v-dialog v-model="dialog.open" max-width="560">
      <v-card v-if="dialog.row">
        <v-card-title>{{ $t('accounting.productGroups.setTitle') }}</v-card-title>
        <v-card-subtitle>{{ dialog.row.name }}<span v-if="dialog.row.sku"> · {{ dialog.row.sku }}</span></v-card-subtitle>
        <v-card-text>
          <div v-if="picker.named.length" class="mb-3">
            <div class="text-caption text-medium-emphasis mb-1">{{ $t('accounting.productGroups.named') }}</div>
            <v-chip-group v-model="dialog.analyticId" column selected-class="text-primary">
              <v-chip v-for="g in picker.named" :key="g.id" :value="g.id" size="small" filter>{{ groupLabel(g.path) }} ({{ g.docs }})</v-chip>
            </v-chip-group>
          </div>
          <v-autocomplete
            v-model="dialog.analyticId"
            :items="pickerItems"
            :label="$t('accounting.productGroups.pick')"
            density="compact"
            variant="outlined"
            hide-details
            auto-select-first
            data-testid="product-groups-pick"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog.open = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn v-cap="'accounts.edit'" color="primary" variant="flat" :disabled="!dialog.analyticId" data-testid="product-groups-save" @click="saveDialog">
            {{ $t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </ListScaffold>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import { askConfirm } from 'ui-shared/composables/confirm'
import { useAccess } from 'ui-shared/access/useAccess'
import { formatDate, formatDateTime, formatMoney, formatNumber } from 'ui-shared/format'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import EntityLink from 'ui-shared/components/EntityLink.vue'
import DateField from 'ui-shared/components/DateField.vue'
import ProductGroupDocuments from '../../components/ProductGroupDocuments.vue'
import { isBooksOrg } from './books-chart'
import {
  REVIEW_FILTERS,
  STALE_POLLS,
  STALE_POLL_MS,
  actionsOf,
  expectedOf,
  filterCount,
  filterLabelKey,
  groupLabel,
  pickerOf,
  pickerStart,
  productPath,
  reviewFilters,
  sourceLabelKey,
  stateColor,
  stateLabelKey,
  valueShare,
  writeErrorKey,
  type GoodsGroup,
  type ReviewAnswer,
  type ReviewFilter,
  type ReviewRow,
} from './product-groups-page'

/**
 * FR-25 R3, slice 2: the review queue of the product → goods group map. The goods sold in the period, by their sales
 * value (net, in the org's currency), with the state of each one's group; the conflicts and the products with no
 * group by default. The accountant sets a group, accepts a proposal or confirms an automatic one, and can withdraw a
 * decision. Every write names the row as the page showed it, so a row changed meanwhile is refused (409) and shown
 * again as it is. The states and the documents come from a learning run the server keeps per organization
 * (`product-group-review.service.ts`); after a change it serves the previous run while it reads the documents again,
 * and the page asks again until it has the new one.
 */

const { t } = useI18n()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()
const { can } = useAccess()

/** No "All": the server pages the queue at most 100 rows at a time, each with its documents. */
const PAGE_SIZES = [
  { value: 10, title: '10' },
  { value: 25, title: '25' },
  { value: 50, title: '50' },
  { value: 100, title: '100' },
]

// The org's settings come with `/auth/me` (the store's type does not name them); a sign-in's org has none yet. Until
// they come the page neither asks for the queue nor says the org keeps no books.
const sessionOrg = computed(() => appStore.currentOrg as { settings?: unknown } | null)
const settingsKnown = computed(() => !!sessionOrg.value?.settings)
const books = computed(() => isBooksOrg(sessionOrg.value))
const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const base = () => `${appStore.orgUrl()}/accounting/product-groups`

const { search, debouncedSearch } = useSearchDebounce()
const filter = ref<ReviewFilter>('todo')
// A cleared date field says null, whatever its type says: the filters read either as none.
const from = ref<string | undefined>()
const to = ref<string | undefined>()

const filters = computed(() => reviewFilters({ filter: filter.value, search: debouncedSearch.value, from: from.value, to: to.value }))
const hasActiveFilters = computed(() => !!debouncedSearch.value || !!from.value || !!to.value || (filter.value !== 'todo' && filter.value !== 'all'))

// FR-05: the grid's state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'state', ref: filter, default: 'todo', sanitize: v => ((REVIEW_FILTERS as readonly string[]).includes(v) ? v : undefined) },
  { key: 'from', ref: from, codec: 'date' },
  { key: 'to', ref: to, codec: 'date' },
])

const answer = ref<ReviewAnswer | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | null = null
let polls = 0

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => (books.value ? `${base()}/review` : '')),
  entityKey: 'rows',
  filters,
  urlSync: true,
  defaultSize: 25,
  defaultSortBy: 'value',
  defaultSortOrder: 'desc',
  onAnswer: (data: ReviewAnswer) => {
    answer.value = data
    poll(data)
  },
})

/** While the server reads the documents again, ask again now and then until the answer is the new reading. */
function poll(data: ReviewAnswer) {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  if (data.evidence?.fresh) {
    polls = 0
    return
  }
  if (polls >= STALE_POLLS) return
  polls++
  pollTimer = setTimeout(() => {
    pollTimer = null
    void fetchItems()
  }, STALE_POLL_MS)
}
onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

const headers = computed(() => [
  { title: '', key: 'data-table-expand', sortable: false, width: 36 },
  { title: t('accounting.productGroups.product'), key: 'name', sortable: true },
  // Hidden until the cog shows it (the name's title carries it): a row offering all three buttons fits 1366 px then.
  { title: t('accounting.productGroups.sku'), key: 'sku', sortable: false, defaultHidden: true },
  { title: t('accounting.productGroups.state'), key: 'state', sortable: false },
  { title: t('accounting.productGroups.group'), key: 'group', sortable: false },
  { title: t('accounting.productGroups.value'), key: 'value', sortable: true, align: 'end' as const },
  { title: t('accounting.productGroups.lines'), key: 'lines', sortable: true, align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false, align: 'end' as const },
])

const filterOptions = computed(() => REVIEW_FILTERS.map(f => {
  const n = filterCount(f, answer.value?.summary)
  return { title: n === undefined ? t(filterLabelKey(f)) : `${t(filterLabelKey(f))} (${formatNumber(n)})`, value: f }
}))

const share = (x: number | null) => (x === null ? '—' : `${formatNumber(x * 100, { decimals: 1 })} %`)

const kpis = computed(() => {
  const s = answer.value?.summary
  return [
    { key: 'posting', label: t('accounting.productGroups.kpi.posting'), value: s ? share(valueShare(s.coverage.all)) : '', icon: 'mdi-percent-outline', color: 'primary', loading: !s },
    { key: 'conflict', label: t('accounting.productGroups.kpi.conflicts'), value: s ? formatNumber(s.byState.conflict) : '', icon: 'mdi-alert-circle-outline', color: 'error', loading: !s, filter: { filter: 'conflict' }, active: filter.value === 'conflict' },
    { key: 'unmapped', label: t('accounting.productGroups.kpi.unmapped'), value: s ? formatNumber(s.byState.unmapped) : '', icon: 'mdi-help-circle-outline', color: 'warning', loading: !s, filter: { filter: 'unmapped' }, active: filter.value === 'unmapped' },
    { key: 'suggested', label: t('accounting.productGroups.kpi.suggested'), value: s ? formatNumber(s.suggested) : '', icon: 'mdi-check-all', color: 'info', loading: !s, filter: { filter: 'unmapped' } },
  ]
})

/** A count's card shows its products; a second click goes back to the work. */
function onKpi(k: { filter?: Record<string, any> }) {
  const next = k.filter?.filter as ReviewFilter | undefined
  if (!next) return
  filter.value = filter.value === next ? 'todo' : next
}

const emptyState = computed(() => (filter.value === 'todo' && !hasActiveFilters.value
  ? { icon: 'mdi-check-circle-outline', title: t('accounting.productGroups.nothingToReview'), description: t('accounting.productGroups.nothingToReviewHint') }
  : { icon: 'mdi-tag-multiple-outline', title: t('accounting.productGroups.empty'), description: t('accounting.productGroups.emptyHint') }))

// ── the rows' words ──

// A document's day comes as its UTC midnight, which the formatter reads as that day wherever the browser is: a zone
// here would turn it into a moment and show the day before, east of UTC.
const day = (d: string | undefined) => formatDate(d)
const analyticPath = (id: string) => answer.value?.analytics[id]?.path ?? groups.value.find(g => g.id === id)?.path ?? id
const analyticLabel = (id: string) => groupLabel(analyticPath(id))
const isActiveGroup = (id: string) => groups.value.some(g => g.id === id && g.active)
const reviewerName = (id: string | undefined) => (id ? answer.value?.reviewers[id] ?? '' : '')

function storedCaption(row: ReviewRow): string {
  const s = row.stored!
  const parts = [t(sourceLabelKey(s.source))]
  if (s.reviewedAt) {
    const who = reviewerName(s.reviewedBy)
    parts.push(who ? t('accounting.productGroups.decidedBy', { who, at: day(s.reviewedAt) }) : day(s.reviewedAt))
  }
  const group = answer.value?.analytics[s.analyticId]
  if (group && !group.active) parts.push(t('accounting.productGroups.inactive'))
  return parts.join(' · ')
}

const storedTitle = (row: ReviewRow) => `${analyticPath(row.stored!.analyticId)} · ${storedCaption(row)}`

// ── the accountant's writes ──

const busy = ref<string | null>(null)
const groups = ref<GoodsGroup[]>([])

async function loadGroups() {
  try {
    const { data } = await httpClient.get(`${base()}/groups`)
    groups.value = data.groups ?? []
  } catch {
    // The picker then offers nothing and Save stays off; the rows still show the groups they name.
  }
}

/** One write, then the page again: the row's new state, or a row changed meanwhile as it is now. */
async function write(row: ReviewRow, send: () => Promise<unknown>, doneKey: string) {
  busy.value = row.productId
  try {
    await send()
    showSuccess(t(doneKey))
  } catch (e: any) {
    const key = writeErrorKey(e?.response?.data?.code)
    showError(key ? t(key) : e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    busy.value = null
    polls = 0
    void fetchItems()
  }
}

function setGroup(row: ReviewRow, analyticId: string) {
  void write(row, () => httpClient.put(`${base()}/${row.productId}`, { analyticId, expected: expectedOf(row) }), 'accounting.productGroups.saved')
}

function accept(row: ReviewRow) {
  if (row.suggestion) setGroup(row, row.suggestion.analyticId)
}

function confirmRow(row: ReviewRow) {
  const expected = expectedOf(row)
  if (!expected) return
  void write(row, () => httpClient.post(`${base()}/${row.productId}/confirm`, { expected }), 'accounting.productGroups.confirmed')
}

async function withdraw(row: ReviewRow) {
  const expected = expectedOf(row)
  if (!expected) return
  const own = row.stored?.source === 'accountant'
  const ok = await askConfirm({
    text: own ? t('accounting.productGroups.withdrawAccountant') : t('accounting.productGroups.withdrawReviewed'),
    confirm: t('accounting.productGroups.withdraw'),
    danger: own,
  })
  if (!ok) return
  void write(row, () => httpClient.delete(`${base()}/${row.productId}/review`, { params: { expected } }), 'accounting.productGroups.withdrawn')
}

const dialog = ref<{ open: boolean; row: ReviewRow | null; analyticId: string | null }>({ open: false, row: null, analyticId: null })
const picker = computed(() => (dialog.value.row ? pickerOf(dialog.value.row, groups.value) : { named: [], all: [] }))
const pickerItems = computed(() => picker.value.all.map(g => ({ title: groupLabel(g.path), value: g.id })))

async function openSet(row: ReviewRow) {
  if (!groups.value.length) await loadGroups()
  dialog.value = { open: true, row, analyticId: pickerStart(row, groups.value) }
}

function saveDialog() {
  const { row, analyticId } = dialog.value
  dialog.value.open = false
  if (row && analyticId) setGroup(row, analyticId)
}

// Who may set a group gets the picker's groups once the org is known to keep books: the rows' "use this group" too.
watch(books, isBooks => {
  if (isBooks && can('accounts.edit') && !groups.value.length) void loadGroups()
}, { immediate: true })

onMounted(() => {
  void fetchItems()
})
</script>

<style scoped>
/* FR-22.23: one line per row on a 1366 px laptop, with a row's three buttons; a wide screen shows more of each. */
.product-cell {
  --cell-clip: min(26em, 19vw);
}
.group-cell {
  --cell-clip: min(24em, 17vw);
}
</style>
