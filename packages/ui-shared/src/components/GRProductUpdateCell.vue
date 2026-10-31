<template>
  <v-select
    v-if="col.key === 'type'"
    :model-value="productUpdate.type"
    :items="productTypeItems()"
    density="compact"
    hide-details
    variant="underlined"
    @update:model-value="emit('set-field', 'type', $event)"
  />
  <v-autocomplete
    v-else-if="col.key === 'categoryId'"
    :model-value="productUpdate.categoryId"
    :items="categories"
    item-title="name"
    item-value="_id"
    density="compact"
    hide-details
    variant="underlined"
    clearable
    @update:model-value="emit('set-field', 'categoryId', $event)"
  />
  <v-autocomplete
    v-else-if="col.key === 'unit'"
    :model-value="productUpdate.unit"
    :items="uomOptions"
    item-title="title"
    item-value="value"
    density="compact"
    hide-details
    variant="underlined"
    @update:model-value="emit('set-field', 'unit', $event)"
  />
  <!-- A tier by its NAME: blank when the article holds no tier of that name; a price typed there
       adds it under that name (`gr-product-update.ts#setTierPrice`). -->
  <v-text-field
    v-else-if="col.tierName"
    :model-value="tierPriceOf(priceTiers, col.tierName)"
    type="number"
    step="0.0001"
    density="compact"
    hide-details
    variant="underlined"
    @update:model-value="emit('set-tier', col.tierName!, $event)"
  />
  <v-text-field
    v-else
    :model-value="productUpdate[col.productField!]"
    :type="col.inputType === 'number' ? 'number' : 'text'"
    step="0.0001"
    density="compact"
    hide-details
    variant="underlined"
    @update:model-value="emit('set-field', col.productField!, $event)"
  />
</template>

<script setup lang="ts">
import type { GRColumn } from '../composables/useGRColumns'
import { tierPriceOf, type GRTier } from '../composables/gr-product-update'
import { useProductTypes } from '../composables/useProductTypes'

// Presentational cell for one goods-receipt product-update column.
// Markup mirrors the inline cells in inventory-ui MovementFormView.

const { productTypeItems } = useProductTypes()

defineProps<{
  col: GRColumn
  productUpdate: Record<string, any>
  priceTiers: GRTier[]
  categories: Array<{ _id: string; name: string }>
  uomOptions: Array<{ title: string; value: string }>
}>()

const emit = defineEmits<{
  'set-field': [field: string, value: any]
  'set-tier': [tierName: string, value: any]
}>()
</script>
