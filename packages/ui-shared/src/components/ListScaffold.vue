<template>
  <v-container fluid>
    <!-- Header: title + actions -->
    <div class="d-flex align-center mb-4 ga-2 flex-wrap">
      <div>
        <h1 class="text-h5">{{ title }}</h1>
        <div v-if="subtitle" class="text-body-2 text-medium-emphasis">{{ subtitle }}</div>
      </div>
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
      <v-card :class="{ 'list-fit': fit }">
        <v-card-text>
          <div class="d-flex align-center mb-2">
            <span v-if="showResultsCount" class="text-body-2 text-medium-emphasis">
              {{ pagination.total }} {{ $t('common.results') }}
            </span>
            <v-spacer />
            <slot name="results-actions" />
            <v-btn
              icon="mdi-cog"
              size="x-small"
              variant="text"
              :color="colsCustomized ? 'primary' : undefined"
              :title="$t('grid.columns')"
              :aria-label="$t('grid.columns')"
              @click="colDialogOpen = true"
            />
          </div>

          <GridColumnPickerDialog
            v-model="colDialogOpen"
            :entries="colEntries"
            @toggle="toggleCol"
            @reorder="reorderCols"
            @reset="resetCols"
          />

          <v-data-table-server
            :headers="effectiveHeaders"
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
import { computed, ref, toRef, useSlots } from 'vue'
import { useRoute } from 'vue-router'
import StatCard, { type StatCardDef } from './StatCard.vue'
import EmptyState from './EmptyState.vue'
import GridColumnPickerDialog from './GridColumnPickerDialog.vue'
import { useGridColumns } from '../composables/useGridColumns'
import type { PaginationState } from '../composables/usePaginatedTable'

interface EmptyDef {
  icon?: string
  title?: string
  description?: string
}

const props = withDefaults(defineProps<{
  title: string
  /** A second line under the title, e.g. which way an order goes (FR-22 D-1). */
  subtitle?: string
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
  /**
   * FR-22.23: the list fits a 1366 px laptop — every row one line, tighter cell gutters. A cell
   * that can run long (a partner's name) marks its content `cell-clip`: it is cut short with an
   * ellipsis past 12em (`--cell-clip` sets another width), the full text in its `title`.
   */
  fit?: boolean
  /**
   * Where the column choices are kept. Defaults to the route name; a grid mounted in two apps
   * (FR-21's cash-register journal) names itself, so both remember the same columns.
   */
  gridId?: string
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

// ── per-user column visibility + order (every ListScaffold grid gets this) ──
const route = useRoute()
const colDialogOpen = ref(false)
const {
  effectiveHeaders,
  entries: colEntries,
  toggle: toggleCol,
  reorder: reorderCols,
  reset: resetCols,
  customized: colsCustomized,
} = useGridColumns({
  headers: toRef(props, 'headers'),
  gridId: () => props.gridId || String(route?.name || route?.path || 'grid'),
})

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

<style scoped>
/* FR-22.23 (`fit`): at 1366 px a document list's row of icons ran past the table's edge and its
   rows wrapped to several lines. One line per row, an 8 px gutter instead of 16. */
.list-fit :deep(.v-table > .v-table__wrapper > table > tbody > tr > td),
.list-fit :deep(.v-table > .v-table__wrapper > table > thead > tr > th) {
  padding-inline: 8px;
}
.list-fit :deep(.v-table > .v-table__wrapper > table > tbody > tr > td) {
  white-space: nowrap;
}
.list-fit :deep(.cell-clip) {
  display: inline-block;
  max-width: var(--cell-clip, 12em);
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}
</style>
