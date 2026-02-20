<template>
  <v-card>
    <v-card-text>
      <v-text-field
        v-model="internalSearch"
        prepend-inner-icon="mdi-magnify"
        :label="$t('common.search')"
        single-line
        hide-details
        clearable
        class="mb-4"
      />
      <v-data-table
        :headers="headers"
        :items="items"
        :search="internalSearch"
        :loading="loading"
        item-value="_id"
        @click:row="(_event: Event, row: any) => emit('click:row', row.item)"
      >
        <template v-for="(_, name) in $slots" #[name]="slotData">
          <slot :name="name" v-bind="slotData ?? {}" />
        </template>
      </v-data-table>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  headers: Array<Record<string, unknown>>
  items: Array<Record<string, unknown>>
  loading?: boolean
  search?: string
}>()

const emit = defineEmits<{
  'click:row': [item: Record<string, unknown>]
}>()

const internalSearch = ref(props.search || '')

watch(() => props.search, (val) => {
  if (val !== undefined) internalSearch.value = val
})
</script>
