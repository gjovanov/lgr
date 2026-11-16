<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.bankAccounts') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
        <responsive-btn v-cap="'bank-accounts.create'" color="primary" icon="mdi-plus" @click="router.push({ name: 'accounting.bank-account-new' })">
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
        <entity-link :label="item.name" :to="{ name: 'accounting.bank-account-edit', params: { id: item._id } }" />
      </template>
      <template #item.balance="{ item }">
        {{ formatCurrency(item.balance, item.currency || currency, localeCode) }}
      </template>
      <template #item.isDefault="{ item }">
        <v-icon v-if="item.isDefault" color="primary">mdi-star</v-icon>
      </template>
      <template #item.bankOperations="{ item }">
        {{ operations[item._id] ?? 0 }}
      </template>
      <template #item.isActive="{ item }">
        <v-icon :color="item.isActive ? 'success' : 'grey'">
          {{ item.isActive ? 'mdi-check-circle' : 'mdi-close-circle' }}
        </v-icon>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="navigateToEdit(item)" />
        <v-btn v-cap="'bank-accounts.delete'" icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
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
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { type BankAccount } from '../../store/accounting.store'
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
import { currentMonth } from './books-chart'

const appStore = useAppStore()
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const { search, debouncedSearch } = useSearchDebounce()

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  return f
})

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/bank-account`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'bankAccounts',
  filters,
})

const deleteDialog = ref(false)
const selectedId = ref('')

const headers = computed(() => [
  { title: t('common.name'), key: 'name' },
  { title: t('accounting.bank'), key: 'bankName' },
  { title: t('accounting.accountNumber'), key: 'accountNumber' },
  { title: t('accounting.iban'), key: 'iban' },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.balance'), key: 'balance', align: 'end' as const },
  { title: t('accounting.default'), key: 'isDefault', align: 'center' as const },
  // FR-25a §3.3: the bank documents of this month the books booked on the account, on the cog.
  { title: t('accounting.bankAccountBooks.operationsThisMonth'), key: 'bankOperations', align: 'end' as const, sortable: false, defaultHidden: true },
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
} = useGridColumns({ headers, gridId: () => String(route?.name || 'accounting.bank-accounts') })

/** Bank account id → its bank operations this month. Read only while the column is shown. */
const operations = ref<Record<string, number>>({})
const showOperations = computed(() => effectiveHeaders.value.some((h: any) => h.key === 'bankOperations'))

async function loadOperations() {
  if (!appStore.currentOrg?.id) return
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/analytics/bank-operations`, { params: { month: currentMonth() } })
    operations.value = data.counts ?? {}
  } catch {
    // A role that reads bank accounts but not the chart's analytics: the column stays at 0.
    operations.value = {}
  }
}

watch(showOperations, (shown) => {
  if (shown) void loadOperations()
}, { immediate: true })

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function navigateToEdit(item: BankAccount | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    router.push({ name: 'accounting.bank-account-edit', params: { id: item._id as string } })
  }
}

function confirmDelete(item: BankAccount) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/accounting/bank-account/${selectedId.value}`)
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
