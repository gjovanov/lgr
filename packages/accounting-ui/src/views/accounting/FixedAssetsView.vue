<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.fixedAssets') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
        <responsive-btn color="primary" icon="mdi-plus" @click="router.push({ name: 'accounting.fixed-asset-new' })">
          {{ $t('common.add') }}
        </responsive-btn>
      </div>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

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
      <template #item.name="{ item }">
        <entity-link :label="item.name" :to="{ name: 'accounting.fixed-asset-edit', params: { id: item._id } }" />
      </template>
      <template #item.acquisitionDate="{ item }">
        {{ item.acquisitionDate?.split('T')[0] }}
      </template>
      <template #item.acquisitionCost="{ item }">
        {{ formatCurrency(item.acquisitionCost, currency, localeCode) }}
      </template>
      <template #item.currentValue="{ item }">
        {{ formatCurrency(item.currentValue, currency, localeCode) }}
      </template>
      <template #item.status="{ item }">
        <v-chip size="small" :color="statusColor(item.status)">
          {{ item.status }}
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
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'

interface FixedAsset {
  _id: string
  code: string
  name: string
  category: string
  acquisitionDate: string
  acquisitionCost: number
  depreciationMethod: string
  usefulLife: number
  currentValue: number
  status: string
}

const appStore = useAppStore()
const router = useRouter()
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
  { title: t('accounting.purchaseDate'), key: 'acquisitionDate' },
  { title: t('accounting.purchasePrice'), key: 'acquisitionCost', align: 'end' as const },
  { title: t('accounting.currentValue'), key: 'currentValue', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function statusColor(status: string) {
  const colors: Record<string, string> = {
    active: 'success', disposed: 'grey', 'fully-depreciated': 'warning',
  }
  return colors[status] || 'grey'
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function navigateToEdit(item: FixedAsset | Record<string, unknown>) {
  if (item && '_id' in item && item._id) {
    router.push({ name: 'accounting.fixed-asset-edit', params: { id: item._id as string } })
  }
}

function confirmDelete(item: FixedAsset) {
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
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchItems()
})
</script>
