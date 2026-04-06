<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.exchangeRates') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
        <responsive-btn color="primary" icon="mdi-plus" @click="router.push({ name: 'accounting.exchange-rate-new' })">
          {{ $t('common.add') }}
        </responsive-btn>
      </div>
    </div>

    <v-row class="mb-4">
      <v-col cols="12" sm="4">
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
      </v-col>
    </v-row>

    <v-data-table-server
      :headers="headers"
      :items="items"
      :items-length="pagination.total"
      :loading="loading"
      :page="pagination.page + 1"
      :items-per-page="pagination.size"
      @update:options="onUpdateOptions"
      @click:row="(_e: any, row: any) => navigateToEdit(row.item)"
    >
      <template #item.rate="{ item }">
        {{ item.rate.toFixed(6) }}
      </template>
      <template #item.date="{ item }">
        {{ item.date?.split('T')[0] }}
      </template>
      <template #item.source="{ item }">
        <v-chip v-if="item.source" size="small" variant="outlined">
          {{ item.source }}
        </v-chip>
      </template>
      <template #item.actions="{ item }">
        <v-btn icon="mdi-pencil" size="small" variant="text" @click.stop="navigateToEdit(item)" />
        <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click.stop="confirmDelete(item)" />
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
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { type ExchangeRate } from '../../store/accounting.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'

const appStore = useAppStore()
const router = useRouter()
const { t } = useI18n()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  return f
})

const url = computed(() => `/org/${appStore.currentOrg?.id}/accounting/exchange-rate`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'exchangeRates',
  filters,
})

const deleteDialog = ref(false)
const selectedId = ref('')

const headers = computed(() => [
  { title: t('accounting.fromCurrency'), key: 'fromCurrency' },
  { title: t('accounting.toCurrency'), key: 'toCurrency' },
  { title: t('accounting.rate'), key: 'rate', align: 'end' as const },
  { title: t('common.date'), key: 'date' },
  { title: t('accounting.source'), key: 'source' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function navigateToEdit(item: ExchangeRate | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    router.push({ name: 'accounting.exchange-rate-edit', params: { id: item._id as string } })
  }
}

function confirmDelete(item: ExchangeRate) {
  selectedId.value = item._id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/accounting/exchange-rate/${selectedId.value}`)
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
