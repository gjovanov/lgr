<template>
  <!-- FR-31.19: on the shared list shell, so the list has the column picker and remembers its columns (keyed by the
       route name, `inventory.inventory-counts`, which does not change). -->
  <ListScaffold
    :title="$t('nav.inventoryCount')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="!!debouncedSearch"
    :empty="{ icon: 'mdi-clipboard-check', title: $t('list.empty.inventoryCounts'), description: $t('list.empty.inventoryCountsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <responsive-btn v-cap="'inventory-counts.create'" color="primary" icon="mdi-plus" :to="{ name: 'inventory.inventory-counts.new' }">{{ $t('common.create') }}</responsive-btn>
    </template>

    <template #filters>
      <v-card class="mb-4">
        <v-card-text class="pb-4">
          <v-row>
            <v-col cols="12" md="4">
              <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>
    </template>

    <template #item.date="{ item }">{{ formatDate(item.date) }}</template>
    <template #item.type="{ item }">
      <v-chip size="small" label>{{ $t(`warehouse.countType.${item.type || 'full'}`) }}</v-chip>
    </template>
    <template #item.status="{ item }">
      <v-chip size="small" label :color="item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'warning' : 'grey'">
        {{ $t(`warehouse.countStatus.${item.status}`) }}
      </v-chip>
    </template>
    <template #item.varianceCount="{ item }">
      <span :class="item.varianceCount > 0 ? 'text-error font-weight-bold' : ''">{{ item.varianceCount || 0 }}</span>
    </template>
    <template #item.actions="{ item }">
      <v-btn :aria-label="$t('common.edit')" :title="$t('common.edit')" icon="mdi-pencil" size="small" variant="text" :to="{ name: 'inventory.inventory-counts.edit', params: { id: item._id } }" />
      <v-btn v-if="item.status === 'in_progress'" v-cap="['inventory-counts.create', 'inventory-counts.edit']" icon="mdi-check-all" size="small" variant="text" color="success" :title="$t('warehouse.completeCount')" :loading="completing === item._id" :disabled="completing !== null && completing !== item._id" data-testid="complete-count" @click="complete(item)" />
    </template>
  </ListScaffold>
</template>

<script setup lang="ts">
import { formatDate } from 'ui-shared/format'
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { completeInventoryCount } from '../api/inventory-counts'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
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
// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'inventoryCounts',
  filters,
  urlSync: true,
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


// The count being completed: a large one takes a while to book, and a second click while it runs asked for the
// completion again. The button shows it is working, and the others wait.
const completing = ref<string | null>(null)

async function complete(item: Item) {
  if (completing.value) return
  completing.value = item._id
  try {
    await completeInventoryCount(item._id)
    await fetchItems()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    completing.value = null
  }
}

onMounted(() => { fetchItems() })
</script>
