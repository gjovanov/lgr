<template>
  <!-- The unit of a line (a document's, an order's): closed it shows the localized abbreviation only, the list
       shows the abbreviation with the full name. One component for the three tables that had the same markup,
       because the value is drawn through a `#selection` slot, and that is what made the cell grow a second line
       when it took focus: `one-line-value` (ui-shared/styles/line-grid.css) keeps it on one line, and what is
       typed to search takes the abbreviation's place. Everything else (readonly, title, test id, aria-label)
       falls through to the autocomplete. -->
  <v-autocomplete
    :model-value="modelValue"
    :items="items"
    item-title="title"
    item-value="value"
    density="compact"
    hide-details
    variant="underlined"
    class="one-line-value"
    :class="{ 'one-line-value--typing': typing }"
    @update:model-value="emit('update:modelValue', $event)"
    @update:search="typing = !!$event"
  >
    <template #selection="{ item }">{{ item.raw.short }}</template>
    <template #item="{ item, props: ip }">
      <v-list-item v-bind="ip" :title="item.raw.short" :subtitle="item.raw.full" />
    </template>
  </v-autocomplete>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { UomOption } from '../composables/useProductUnits'

defineProps<{
  modelValue?: string | null
  /** `useProductUnits().uomOptions` */
  items: UomOption[]
}>()

const emit = defineEmits<{
  'update:modelValue': [unit: string]
}>()

/** Something is typed into the field: it is shown in the unit's place, on the same line. */
const typing = ref(false)
</script>
