<template>
  <v-card>
    <v-card-text>
      <v-text-field
        v-if="showSearch"
        v-model="internalSearch"
        prepend-inner-icon="mdi-magnify"
        :label="$t('common.search')"
        single-line
        hide-details
        clearable
        class="mb-4"
        @update:model-value="onSearchInput"
      />
      <v-data-table-server
        :headers="headers"
        :items="items"
        :items-length="total"
        :loading="loading"
        :page="page + 1"
        :items-per-page="size"
        item-value="_id"
        @update:options="$emit('update:options', $event)"
        @click:row="(_event: Event, row: any) => $emit('click:row', row.item)"
      >
        <template v-for="(_, name) in $slots" #[name]="slotData">
          <slot :name="name" v-bind="slotData ?? {}" />
        </template>
      </v-data-table-server>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  headers: Array<Record<string, unknown>>
  items: Array<Record<string, unknown>>
  total: number
  loading?: boolean
  page: number
  size: number
  showSearch?: boolean
}>(), {
  loading: false,
  showSearch: true,
})

const emit = defineEmits<{
  'update:options': [options: any]
  'click:row': [item: Record<string, unknown>]
  'update:search': [value: string]
}>()

const internalSearch = ref('')

let debounceTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput(val: string | null) {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('update:search', val || '')
  }, 300)
}
</script>
