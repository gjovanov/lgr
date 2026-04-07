<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.inventoryCount') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'inventory.inventory-counts.new' }">{{ $t('common.create') }}</responsive-btn>
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

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label>{{ item.type || 'full' }}</v-chip>
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'warning' : 'grey'">
              {{ item.status }}
            </v-chip>
          </template>
          <template #item.varianceCount="{ item }">
            <span :class="item.varianceCount > 0 ? 'text-error font-weight-bold' : ''">{{ item.varianceCount || 0 }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'inventory.inventory-counts.edit', params: { id: item._id } }" />
            <v-btn v-if="item.status === 'in_progress'" icon="mdi-check-all" size="small" variant="text" color="success" :title="$t('warehouse.completeCount')" @click="complete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'

interface Item { _id: string; number: string; warehouseName: string; warehouseId?: string; date: string; type: string; status: string; itemCount: number; varianceCount: number; notes?: string; lines?: any[] }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  return f
})

const url = computed(() => `${appStore.orgUrl()}/warehouse/inventory-count`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'inventoryCounts',
  filters,
})

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: true },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('common.status'), key: 'status' },
  { title: t('warehouse.itemCount'), key: 'itemCount', align: 'end' as const },
  { title: t('warehouse.variances'), key: 'varianceCount', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function onExport(format: string) { console.log('Export inventory counts as', format) }

async function complete(item: Item) {
  try {
    await httpClient.post(`${appStore.orgUrl()}/warehouse/inventory-count/${item._id}/complete`)
    await fetchItems()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchItems() })
</script>
