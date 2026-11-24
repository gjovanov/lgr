<template>
  <ListScaffold
    :title="$t('accounting.analytics.title')"
    :subtitle="asBooked ? $t('accounting.analytics.asBooked') : undefined"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-file-tree-outline', title: $t('accounting.analytics.empty'), description: $t('accounting.analytics.emptyHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    fit
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <v-btn variant="outlined" prepend-icon="mdi-microsoft-excel" :loading="exporting" data-testid="analytics-export" @click="exportExcel">
        {{ $t('accounting.analytics.export') }}
      </v-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="3">
          <v-select v-model="root" :label="$t('accounting.analytics.root')" :items="rootOptions" clearable data-testid="analytics-root" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="kind" :label="$t('accounting.analytics.kind')" :items="kindOptions" clearable />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="hasContact" :label="$t('accounting.analytics.hasContact')" :items="yesNo" clearable />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <v-select v-model="active" :label="$t('common.status')" :items="activeOptions" clearable />
        </v-col>
      </FilterBar>
    </template>

    <!-- The tree: each row indented by its depth, a root in bold with a button that opens it alone. -->
    <template #item.path="{ item }">
      <span class="d-inline-flex align-center" :style="{ paddingLeft: analyticIndent(item.path) + 'px' }" :title="item.path">
        <!-- Every row keeps the button's room, so a child is indented past its root's name, not its button. -->
        <span class="tree-slot">
          <v-btn
            v-if="item.depth === 0 && root !== item.root"
            icon="mdi-folder-open-outline"
            size="x-small"
            variant="text"
            :title="$t('accounting.analytics.openRoot')"
            :aria-label="$t('accounting.analytics.openRoot')"
            data-testid="analytics-open-root"
            @click="openRoot(item.root)"
          />
        </span>
        <entity-link
          :class="{ 'font-weight-bold': item.depth === 0 }"
          :label="item.name"
          :to="{ name: 'accounting.analytic', params: { id: item._id } }"
        />
      </span>
    </template>
    <template #item.root="{ item }">{{ rootTitle(item.root) }}</template>
    <template #item.kind="{ item }">
      <v-chip size="small" label :color="kindColor(item.kind)">{{ $t(kindLabelKey(item.kind)) }}</v-chip>
    </template>
    <template #item.contactName="{ item }">
      <entity-link v-if="item.contactId" class="cell-clip" :label="item.contactName || item.contactId" :to="`/invoicing/contacts/${item.contactId}/edit`" />
    </template>
    <template #item.bankAccountName="{ item }">
      <entity-link v-if="item.bankAccountId" :label="item.bankAccountName || item.bankAccountId" :to="{ name: 'accounting.bank-account-edit', params: { id: item.bankAccountId } }" />
    </template>
    <template #item.fixedAssetName="{ item }">
      <entity-link v-if="item.fixedAssetId" class="cell-clip" :label="item.fixedAssetName || item.fixedAssetId" :to="{ name: 'accounting.fixed-asset-edit', params: { id: item.fixedAssetId } }" />
    </template>
    <template #item.isActive="{ item }">
      <v-icon :color="item.isActive ? 'success' : 'grey'">{{ item.isActive ? 'mdi-check-circle' : 'mdi-close-circle' }}</v-icon>
    </template>
    <template #item.actions="{ item }">
      <v-btn
        icon="mdi-eye-outline"
        size="small"
        variant="text"
        :to="{ name: 'accounting.analytic', params: { id: item._id } }"
        :title="$t('accounting.analytics.open')"
        :aria-label="$t('accounting.analytics.open')"
      />
    </template>
  </ListScaffold>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import { downloadAsSession } from 'ui-shared/composables/useSessionDownload'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import EntityLink from 'ui-shared/components/EntityLink.vue'
import {
  ANALYTIC_KINDS,
  analyticIndent,
  analyticsFilters,
  kindColor,
  kindLabelKey,
  rootLabelKey,
  type AnalyticRootInfo,
} from './books-chart'

/**
 * FR-25a §3.2: the books' analytics as a tree: each root, then what is under it, indented by depth. Sorted, filtered
 * and paged on the server (`accounting/analytics`); a root's button shows it alone.
 */

const { t } = useI18n()
const appStore = useAppStore()
const { showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const root = ref<string | null>(null)
const kind = ref<string | null>(null)
const hasContact = ref<'yes' | 'no' | null>(null)
const active = ref<'active' | 'inactive' | null>(null)
const roots = ref<AnalyticRootInfo[]>([])
const asBooked = ref(false)
const exporting = ref(false)

const filters = computed(() => analyticsFilters({
  search: debouncedSearch.value,
  root: root.value,
  kind: kind.value,
  hasContact: hasContact.value,
  active: active.value,
}))
const hasActiveFilters = computed(() => Object.keys(filters.value).length > 0)

// FR-05: the grid's state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'root', ref: root },
  { key: 'kind', ref: kind, sanitize: v => ((ANALYTIC_KINDS as readonly string[]).includes(v) ? v : undefined) },
  { key: 'contact', ref: hasContact, sanitize: v => (v === 'yes' || v === 'no' ? v : undefined) },
  { key: 'active', ref: active, sanitize: v => (v === 'active' || v === 'inactive' ? v : undefined) },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/accounting/analytics`),
  entityKey: 'analytics',
  filters,
  urlSync: true,
  defaultSize: 25,
  defaultSortBy: 'path',
  defaultSortOrder: 'asc',
})

const headers = computed(() => [
  { title: t('accounting.analytics.path'), key: 'path', sortable: true },
  { title: t('accounting.analytics.root'), key: 'root', sortable: true, defaultHidden: true },
  { title: t('accounting.analytics.kind'), key: 'kind', sortable: true },
  { title: t('accounting.analytics.unit'), key: 'unit', sortable: true },
  { title: t('accounting.analytics.contact'), key: 'contactName', sortable: false },
  { title: t('accounting.analytics.bankAccount'), key: 'bankAccountName', sortable: false },
  { title: t('accounting.analytics.fixedAsset'), key: 'fixedAssetName', sortable: false },
  { title: t('common.active'), key: 'isActive', sortable: true, align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function rootTitle(name: string): string {
  const key = rootLabelKey(name, roots.value)
  return key ? t(key) : name
}

const rootOptions = computed(() => roots.value.map(r => ({ title: `${rootTitle(r.root)} (${r.count})`, value: r.root })))
const kindOptions = computed(() => ANALYTIC_KINDS.map(k => ({ title: t(kindLabelKey(k)), value: k })))
const yesNo = computed(() => [{ title: t('common.yes'), value: 'yes' }, { title: t('common.no'), value: 'no' }])
const activeOptions = computed(() => [{ title: t('common.active'), value: 'active' }, { title: t('common.inactive'), value: 'inactive' }])

function openRoot(name: string) {
  root.value = name
}

async function loadRoots() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/accounting/analytics/roots`)
    roots.value = data.roots ?? []
    asBooked.value = !!data.asBooked
  } catch {
    // The grid works without the roots' words: the filter only lists none.
  }
}

/** The grid as it is filtered and sorted, as an Excel sheet, in the viewer's words. */
async function exportExcel() {
  exporting.value = true
  try {
    const labels = {
      title: t('accounting.analytics.title'),
      columns: {
        path: t('accounting.analytics.path'),
        root: t('accounting.analytics.root'),
        kind: t('accounting.analytics.kind'),
        unit: t('accounting.analytics.unit'),
        contact: t('accounting.analytics.contact'),
        bankAccount: t('accounting.analytics.bankAccount'),
        fixedAsset: t('accounting.analytics.fixedAsset'),
        isActive: t('common.active'),
      },
      kinds: Object.fromEntries(ANALYTIC_KINDS.map(k => [k, t(kindLabelKey(k))])),
      roots: Object.fromEntries(roots.value.map(r => [r.root, rootTitle(r.root)])),
      yes: t('common.yes'),
      no: t('common.no'),
    }
    const params = new URLSearchParams({
      ...filters.value,
      sortBy: pagination.value.sortBy,
      sortOrder: pagination.value.sortOrder,
      labels: JSON.stringify(labels),
    })
    await downloadAsSession(`${appStore.orgUrl()}/accounting/analytics/export?${params}`, 'analytics.xlsx')
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    exporting.value = false
  }
}

onMounted(() => {
  void loadRoots()
  fetchItems()
})
</script>

<style scoped>
.tree-slot {
  display: inline-flex;
  justify-content: center;
  flex: 0 0 28px;
  width: 28px;
}
</style>
