<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.fixedAssets') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
        <responsive-btn v-cap="'fixed-assets.create'" color="primary" icon="mdi-plus" @click="router.push({ name: 'accounting.fixed-asset-new' })">
          {{ $t('common.add') }}
        </responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row align="center">
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <!-- FR-25a §3.4: the tax category (or none), and whether the books import made the asset. -->
          <v-col cols="6" md="3">
            <v-select
              v-model="taxCategory"
              :label="$t('accounting.fixedAssetBooks.tax.category')"
              :items="taxCategoryItems"
              clearable
              hide-details
              density="compact"
              data-testid="fixed-assets-tax-category"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-select
              v-model="origin"
              :label="$t('accounting.fixedAssetBooks.origin')"
              :items="originItems"
              clearable
              hide-details
              density="compact"
              data-testid="fixed-assets-origin"
            />
          </v-col>
          <v-spacer />
          <v-col cols="auto">
            <v-btn
              icon="mdi-cog"
              size="x-small"
              variant="text"
              :color="colsCustomized ? 'primary' : undefined"
              :title="$t('grid.columns')"
              :aria-label="$t('grid.columns')"
              @click="colDialogOpen = true"
            />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <GridColumnPickerDialog v-model="colDialogOpen" :entries="colEntries" @toggle="toggleCol" @reorder="reorderCols" @reset="resetCols" />

    <v-data-table-server
      :headers="effectiveHeaders"
      :items="items"
      :items-length="pagination.total"
      :loading="loading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      @update:options="onUpdateOptions"
      @click:row="(_e: any, row: any) => navigateToEdit(row.item)"
    >
      <template #item.name="{ item }">
        <div class="d-flex align-center ga-1">
          <!-- As booked in the accountant's program: opens read-only. -->
          <v-icon
            v-if="item.imported"
            size="small"
            color="medium-emphasis"
            :title="$t('accounting.fixedAssetBooks.asBooked')"
            :aria-label="$t('accounting.fixedAssetBooks.imported')"
            data-testid="fixed-asset-imported"
          >
            mdi-lock-outline
          </v-icon>
          <entity-link :label="item.name" :to="{ name: 'accounting.fixed-asset-edit', params: { id: item._id } }" />
        </div>
      </template>
      <template #item.purchaseDate="{ item }">
        {{ dayOf(item.purchaseDate) ?? '' }}
      </template>
      <template #item.purchasePrice="{ item }">
        {{ money(item.purchasePrice, item) }}
      </template>
      <template #item.currentValue="{ item }">
        <span class="d-inline-flex align-center ga-1">
          {{ money(item.currentValue, item) }}
          <!-- An asset of the books: the value its books start from, not today's (FR-25a §4.2). -->
          <v-icon v-if="item.imported" size="x-small" color="medium-emphasis" :title="$t('accounting.fixedAssetBooks.openingValueHint')">mdi-information-outline</v-icon>
        </span>
      </template>
      <template #item.status="{ item }">
        <v-chip size="small" :color="statusColor(item.status)">
          {{ statusLabelKey(item.status) ? $t(statusLabelKey(item.status)!) : item.status }}
        </v-chip>
      </template>
      <template #item.taxCategory="{ item }">
        {{ taxCategoryRoman(item.taxCategory) ?? '' }}
      </template>
      <template #item.taxDepreciationRate="{ item }">
        {{ typeof item.taxDepreciationRate === 'number' ? `${item.taxDepreciationRate.toLocaleString(localeCode)} %` : '' }}
      </template>
      <template #item.inServiceDate="{ item }">
        {{ dayOf(item.inServiceDate) ?? '' }}
      </template>
      <template #item.actions="{ item }">
        <!-- An asset of the books takes no action here: it opens read-only from its row. -->
        <template v-if="!item.imported">
          <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="navigateToEdit(item)" />
          <v-btn v-cap="'fixed-assets.delete'" icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
        </template>
      </template>
    </v-data-table-server>

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirmDelete') }}</v-card-title>
        <v-card-text>{{ $t('common.confirmDeleteMessage') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="loading" @click="doDelete">
            {{ $t('common.delete') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useGridColumns } from 'ui-shared/composables/useGridColumns'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import GridColumnPickerDialog from 'ui-shared/components/GridColumnPickerDialog.vue'
import { TAX_CATEGORIES, dayOf, taxCategoryRoman } from 'config/fixed-asset-tax'
import { assetCurrency, fixedAssetFilters, refusalKey, statusColor, statusLabelKey } from './fixed-asset-form'

/** A row as the list answers it (`fixed-asset.service.ts#listFixedAssets`): never the properties or the schedule. */
interface FixedAssetRow {
  _id: string
  code: string
  name: string
  category: string
  purchaseDate: string
  purchasePrice: number
  currentValue: number
  currency?: string
  status: string
  taxCategory?: string
  taxDepreciationRate?: number
  inServiceDate?: string
  /** The books import made it: as booked, read-only. */
  imported: boolean
}

const appStore = useAppStore()
const router = useRouter()
const route = useRoute()
const { t, te } = useI18n()
const { showSuccess, showError } = useSnackbar()

const orgCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', bg: 'bg-BG', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})
/** Each asset in its own currency: an asset of the books written off before the euro is in lev. */
const money = (n: unknown, item: FixedAssetRow) => (typeof n === 'number' ? formatCurrency(n, assetCurrency(item, orgCurrency.value), localeCode.value) : '')

const { search, debouncedSearch } = useSearchDebounce()
const taxCategory = ref<string | null>(null)
const origin = ref<'imported' | 'native' | null>(null)

const taxCategoryItems = computed(() => [
  ...TAX_CATEGORIES.map(c => ({ value: c.code, title: `${c.roman} – ${t(`accounting.fixedAssetBooks.tax.categories.${c.code}`)}` })),
  { value: 'none', title: t('accounting.fixedAssetBooks.tax.noCategory') },
])
const originItems = computed(() => [
  { value: 'imported', title: t('accounting.fixedAssetBooks.imported') },
  { value: 'native', title: t('accounting.fixedAssetBooks.native') },
])

const filters = computed(() => fixedAssetFilters({ search: debouncedSearch.value, taxCategory: taxCategory.value, origin: origin.value }))

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/fixed-asset`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'fixedAssets',
  filters,
})

const deleteDialog = ref(false)
const selectedId = ref('')

const headers = computed(() => [
  { title: t('common.code'), key: 'code' },
  { title: t('common.name'), key: 'name' },
  { title: t('common.category'), key: 'category' },
  { title: t('accounting.purchaseDate'), key: 'purchaseDate' },
  { title: t('accounting.purchasePrice'), key: 'purchasePrice', align: 'end' as const },
  { title: t('accounting.currentValue'), key: 'currentValue', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  // FR-25a §3.4: the tax side, on the cog.
  { title: t('accounting.fixedAssetBooks.tax.category'), key: 'taxCategory', defaultHidden: true },
  { title: t('accounting.fixedAssetBooks.tax.rate'), key: 'taxDepreciationRate', align: 'end' as const, defaultHidden: true },
  { title: t('accounting.fixedAssetBooks.tax.inServiceDate'), key: 'inServiceDate', defaultHidden: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

// Per-user columns (visibility and order), as every ListScaffold grid has them.
const colDialogOpen = ref(false)
const {
  effectiveHeaders,
  entries: colEntries,
  toggle: toggleCol,
  reorder: reorderCols,
  reset: resetCols,
  customized: colsCustomized,
} = useGridColumns({ headers, gridId: () => String(route?.name || 'accounting.fixed-assets') })

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function navigateToEdit(item: FixedAssetRow | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    router.push({ name: 'accounting.fixed-asset-edit', params: { id: item._id as string } })
  }
}

function confirmDelete(item: FixedAssetRow) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/accounting/fixed-asset/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    const key = refusalKey(e?.response?.data)
    showError(key && te(key) ? t(key) : e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchItems()
})
</script>
