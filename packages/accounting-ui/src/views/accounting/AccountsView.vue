<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.accounts') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
        <!-- FR-25a §3.1: a books org's chart is the accountant's, as booked: nothing is added to it here. -->
        <responsive-btn v-if="!asBooked" v-cap="'accounts.create'" color="primary" icon="mdi-plus" @click="router.push({ name: 'accounting.account-new' })">
          {{ $t('common.add') }}
        </responsive-btn>
      </div>
    </div>

    <v-alert v-if="asBooked" type="info" variant="tonal" density="compact" icon="mdi-lock-outline" class="mb-4" data-testid="accounts-as-booked">
      {{ $t('accounting.accountBooks.readOnly') }}
    </v-alert>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row align="center">
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <!-- What the books say of an account: set only on a books org's chart, so offered only there. -->
          <template v-if="asBooked">
            <v-col cols="6" md="2">
              <v-select v-model="hasAnalytics" :label="$t('accounting.accountBooks.hasAnalytics')" :items="yesNo" clearable hide-details density="compact" data-testid="accounts-has-analytics" />
            </v-col>
            <v-col cols="6" md="2">
              <v-select v-model="quantitative" :label="$t('accounting.accountBooks.quantitative')" :items="yesNo" clearable hide-details density="compact" data-testid="accounts-quantitative" />
            </v-col>
          </template>
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
      <template #item.code="{ item }">
        <span :style="{ paddingLeft: getIndent(item) + 'px' }">{{ item.code }}</span>
      </template>
      <template #item.name="{ item }">
        <entity-link :label="item.name" :to="{ name: 'accounting.account-edit', params: { id: item._id } }" />
      </template>
      <template #item.type="{ item }">
        <v-chip size="small" :color="typeColor(item.type)">{{ item.type }}</v-chip>
      </template>
      <template #item.balance="{ item }">
        {{ formatCurrency(item.balance, currency, localeCode) }}
      </template>
      <template #item.isActive="{ item }">
        <v-icon :color="item.isActive ? 'success' : 'grey'">
          {{ item.isActive ? 'mdi-check-circle' : 'mdi-close-circle' }}
        </v-icon>
      </template>
      <template #item.balanceSide="{ item }">
        <v-chip v-if="balanceSideKey(item.balanceSide)" size="small" label :color="balanceSideColor(item.balanceSide)">
          {{ $t(balanceSideKey(item.balanceSide)!) }}
        </v-chip>
      </template>
      <template #item.quantitative="{ item }">
        <v-icon v-if="item.quantitative" color="primary" :aria-label="$t('accounting.accountBooks.quantitative')">mdi-numeric</v-icon>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="navigateToEdit(item)" />
        <v-btn v-if="!asBooked" v-cap="'accounts.delete'" icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
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
          <v-btn color="error" :loading="store.loading" @click="doDelete">
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
import { useAccountingStore, type Account } from '../../store/accounting.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useGridColumns } from 'ui-shared/composables/useGridColumns'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import GridColumnPickerDialog from 'ui-shared/components/GridColumnPickerDialog.vue'
import { balanceSideColor, balanceSideKey, isBooksOrg } from './books-chart'

const appStore = useAppStore()
const store = useAccountingStore()
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

/** FR-25a §3.1: the org keeps the accountant's books, and its chart is as booked there. */
const asBooked = computed(() => isBooksOrg(appStore.currentOrg as any))
const hasAnalytics = ref<'yes' | 'no' | null>(null)
const quantitative = ref<'yes' | 'no' | null>(null)
const yesNo = computed(() => [{ title: t('common.yes'), value: 'yes' }, { title: t('common.no'), value: 'no' }])

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const { search, debouncedSearch } = useSearchDebounce()

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (hasAnalytics.value) f.hasAnalytics = hasAnalytics.value === 'yes' ? 'true' : 'false'
  if (quantitative.value) f.quantitative = quantitative.value === 'yes' ? 'true' : 'false'
  return f
})

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/account`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'accounts',
  filters,
})

const deleteDialog = ref(false)
const selectedId = ref('')

const headers = computed(() => [
  { title: t('accounting.accountCode'), key: 'code' },
  { title: t('common.name'), key: 'name' },
  { title: t('accounting.accountType'), key: 'type' },
  { title: t('accounting.subType'), key: 'subType' },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.balance'), key: 'balance', align: 'end' as const },
  // FR-25a §3.1: what the books say of the account, on the cog.
  { title: t('accounting.accountBooks.balanceSide'), key: 'balanceSide', defaultHidden: true },
  { title: t('accounting.accountBooks.quantitative'), key: 'quantitative', align: 'center' as const, defaultHidden: true },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
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
} = useGridColumns({ headers, gridId: () => String(route?.name || 'accounting.accounts') })

function typeColor(type: string) {
  const colors: Record<string, string> = {
    asset: 'blue', liability: 'red', equity: 'purple', revenue: 'green', expense: 'orange',
  }
  return colors[type] || 'grey'
}

function getIndent(item: Account) {
  if (!item.parentId) return 0
  let depth = 0
  let current = item
  while (current.parentId) {
    depth++
    const parent = items.value.find((a: any) => a._id === current.parentId)
    if (!parent) break
    current = parent
  }
  return depth * 20
}

function navigateToEdit(item: Account | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    router.push({ name: 'accounting.account-edit', params: { id: item._id as string } })
  }
}

function confirmDelete(item: Account) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await store.deleteAccount(selectedId.value)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchItems()
})
</script>
