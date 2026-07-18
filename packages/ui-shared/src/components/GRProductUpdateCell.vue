<template>
  <v-select
    v-if="col.key === 'type'"
    :model-value="productUpdate.type"
    :items="['goods', 'service', 'raw_material', 'finished_product']"
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
  <v-text-field
    v-else-if="col.tierIndex != null"
    :model-value="priceTiers[col.tierIndex]?.finalPrice"
    type="number"
    step="0.01"
    density="compact"
    hide-details
    variant="underlined"
    @update:model-value="emit('set-tier', col.tierIndex!, $event)"
  />
  <v-text-field
    v-else
    :model-value="productUpdate[col.productField!]"
    :type="col.inputType === 'number' ? 'number' : 'text'"
    step="0.01"
    density="compact"
    hide-details
    variant="underlined"
    @update:model-value="emit('set-field', col.productField!, $event)"
  />
</template>

<script setup lang="ts">
import type { GRColumn } from '../composables/useGRColumns'

// Presentational cell for one goods-receipt product-update column.
// Markup mirrors the inline cells in inventory-ui MovementFormView.

defineProps<{
  col: GRColumn
  productUpdate: Record<string, any>
  priceTiers: Array<{ name: string; percent?: number; finalPrice?: number; manualOverride?: boolean; contactIds?: string[]; tags?: string[] }>
  categories: Array<{ _id: string; name: string }>
  uomOptions: Array<{ title: string; value: string }>
}>()

const emit = defineEmits<{
  'set-field': [field: string, value: any]
  'set-tier': [tierIndex: number, value: any]
}>()
</script>
