<template>
  <v-container fluid>
    <!-- Header: title + actions -->
    <div class="d-flex align-center mb-4 ga-2 flex-wrap">
      <h1 class="text-h5">{{ title }}</h1>
      <v-spacer />
      <div class="d-flex ga-2 align-center flex-wrap justify-end">
        <slot name="actions" />
      </div>
    </div>

    <!-- KPI summary row -->
    <div v-if="$slots.kpis || kpis?.length" class="mb-4">
      <slot name="kpis">
        <v-row dense>
          <v-col v-for="k in kpis" :key="k.key" cols="6" sm="3">
            <StatCard
              :label="k.label"
              :value="k.value"
              :icon="k.icon"
              :color="k.color"
              :trend="k.trend"
              :loading="k.loading"
              :active="k.active"
              :clickable="!!k.filter"
              @click="$emit('kpi-click', k)"
            />
          </v-col>
        </v-row>
      </slot>
    </div>

    <!-- Filters -->
    <slot name="filters" />

    <!-- Body -->
    <template v-if="view === 'list'">
      <v-card>
        <v-card-text>
          <div v-if="showResultsCount" class="d-flex align-center mb-2">
            <span class="text-body-2 text-medium-emphasis">
              {{ pagination.total }} {{ $t('common.results') }}
            </span>
            <v-spacer />
            <slot name="results-actions" />
          </div>

          <v-data-table-server
            :headers="headers"
            :items="items"
            :items-length="pagination.total"
            :loading="loading"
            :page="pagination.page + 1"
            :items-per-page="pagination.size"
            :items-per-page-options="itemsPerPageOptions"
            :item-value="itemValue"
            :density="density"
            hover
            @update:options="$emit('update:options', $event)"
          >
            <!-- First-load skeleton; thin progress bar on subsequent page loads -->
            <template #loading>
              <v-skeleton-loader v-if="!items.length" :type="`table-row@${skeletonRows}`" />
            </template>

            <!-- Empty state (distinguishes "no matches for filters" vs "nothing here yet") -->
            <template #no-data>
              <EmptyState
                :icon="resolvedEmpty.icon"
                :title="resolvedEmpty.title"
                :description="resolvedEmpty.description"
              >
                <template v-if="$slots['empty-actions']" #actions>
                  <slot name="empty-actions" :filtered="hasActiveFilters" />
                </template>
              </EmptyState>
            </template>

            <!-- Forward item.* / header.* / etc. cell slots to the inner table -->
            <template v-for="name in forwardedSlots" #[name]="slotData">
              <slot :name="name" v-bind="slotData ?? {}" />
            </template>
          </v-data-table-server>
        </v-card-text>
      </v-card>
    </template>

    <!-- Alternate view (kanban / pivot / chart) -->
    <template v-else>
      <slot name="view" :view="view" />
    </template>

    <!-- Dialogs / extras (payment, delete, create-edit modal, transfer …) -->
    <slot />
  </v-container>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue'
import StatCard, { type StatCardDef } from './StatCard.vue'
import EmptyState from './EmptyState.vue'
import type { PaginationState } from '../composables/usePaginatedTable'

interface EmptyDef {
  icon?: string
  title?: string
  description?: string
}

const props = withDefaults(defineProps<{
  title: string
  headers: any[]
  items: any[]
  loading: boolean
  pagination: PaginationState
  kpis?: StatCardDef[]
  /** current view mode; 'list' renders the built-in table, anything else uses the #view slot */
  view?: string
  itemValue?: string
  density?: 'compact' | 'comfortable' | 'default'
  showResultsCount?: boolean
  skeletonRows?: number
  itemsPerPageOptions?: any[]
  /** true when any filter/search is active — switches the empty state to the "no matches" variant */
  hasActiveFilters?: boolean
  empty?: EmptyDef
  emptyFiltered?: EmptyDef
}>(), {
  view: 'list',
  itemValue: '_id',
  density: 'compact',
  showResultsCount: true,
  skeletonRows: 8,
  hasActiveFilters: false,
  itemsPerPageOptions: () => [
    { value: 10, title: '10' },
    { value: 25, title: '25' },
    { value: 50, title: '50' },
    { value: 100, title: '100' },
    { value: -1, title: '$vuetify.dataFooter.itemsPerPageAll' },
  ],
})

defineEmits<{
  'update:options': [opts: any]
  'kpi-click': [kpi: StatCardDef]
}>()

const slots = useSlots()
const RESERVED = new Set([
  'actions', 'kpis', 'filters', 'view', 'empty-actions', 'results-actions', 'no-data', 'loading', 'default',
])
const forwardedSlots = computed(() => Object.keys(slots).filter((n) => !RESERVED.has(n)))

const resolvedEmpty = computed(() => {
  const base = { icon: 'mdi-inbox-outline', title: '', description: '' }
  if (props.hasActiveFilters) {
    return { ...base, icon: 'mdi-filter-remove-outline', ...props.emptyFiltered }
  }
  return { ...base, ...props.empty }
})
</script>
