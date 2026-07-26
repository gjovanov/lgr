<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    max-width="1400"
    scrollable
  >
    <v-card>
      <v-toolbar color="surface" flat density="compact">
        <v-toolbar-title class="text-body-1 font-weight-bold">
          {{ $t('invoicing.searchContact') }}
        </v-toolbar-title>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="emit('update:modelValue', false)" />
      </v-toolbar>

      <v-card-text class="pa-3">
        <v-row dense class="mb-2">
          <v-col cols="12" md="6">
            <v-text-field
              v-model="search"
              prepend-inner-icon="mdi-magnify"
              :placeholder="$t('common.search')"
              clearable
              hide-details
              density="compact"
              variant="outlined"
              autofocus
            />
          </v-col>
          <v-col v-if="!type" cols="12" md="3">
            <v-select
              v-model="typeFilter"
              :label="$t('common.type')"
              :items="typeOptions"
              item-title="title"
              item-value="value"
              clearable
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>

        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          :items-per-page-options="[10, 25, 50, 100]"
          @update:options="onUpdateOptions"
          item-value="_id"
          density="compact"
          hover
          @click:row="onRowClick"
          class="picker-table"
        >
          <template #item.companyName="{ item }">
            {{ item.companyName || [item.firstName, item.lastName].filter(Boolean).join(' ') }}
          </template>
          <template #item.type="{ item }">
            <v-chip size="x-small" variant="tonal" :color="item.type === 'supplier' ? 'info' : item.type === 'both' ? 'primary' : undefined">
              {{ $t(`invoicing.${item.type}`, item.type) }}
            </v-chip>
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePaginatedTable } from '../composables/usePaginatedTable'
import { useSearchDebounce } from '../composables/useSearchDebounce'

export interface PickerContact {
  _id: string
  companyName?: string
  firstName?: string
  lastName?: string
  type: string
  taxNumber?: string
  taxId?: string
  vatNumber?: string
  email?: string
  phone?: string
}

const props = defineProps<{
  modelValue: boolean
  orgUrl: string
  /** Fixed type filter (customer|supplier — 'both'-typed contacts are included server-side).
   *  Omit to search all contacts with an in-dialog type filter. */
  type?: 'customer' | 'supplier'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'select': [contact: PickerContact]
}>()

const { t } = useI18n()
const { search, debouncedSearch } = useSearchDebounce()
const typeFilter = ref<string | null>(null)

const typeOptions = computed(() => [
  { title: t('invoicing.customer'), value: 'customer' },
  { title: t('invoicing.supplier'), value: 'supplier' },
  { title: t('invoicing.both'), value: 'both' },
])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  const type = props.type || typeFilter.value
  if (type) f.type = type
  return f
})

const url = computed(() => `${props.orgUrl}/invoicing/contact`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'contacts',
  filters,
  defaultSize: 25,
})

const headers = computed(() => [
  { title: t('invoicing.companyName'), key: 'companyName', sortable: true },
  { title: t('invoicing.taxNumber'), key: 'taxNumber', sortable: false },
  { title: t('invoicing.vatNumber'), key: 'vatNumber', sortable: false },
  { title: t('invoicing.email'), key: 'email', sortable: false },
  { title: t('invoicing.phone'), key: 'phone', sortable: false },
  { title: t('common.type'), key: 'type', sortable: false },
])

function onRowClick(_e: Event, row: { item: PickerContact }) {
  emit('select', row.item)
  emit('update:modelValue', false)
}

// Lazy-fetch on first open
watch(() => props.modelValue, (open) => {
  if (open) fetchItems()
})
</script>

<style scoped>
.picker-table :deep(tbody tr) {
  cursor: pointer;
}
</style>
