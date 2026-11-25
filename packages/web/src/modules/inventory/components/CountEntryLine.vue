<template>
  <!-- FR-33.4 (#933): the count's entry line, the last row of the lines (D-7). The movement's pair: `ProductSearch` and
       Details, with the stock of the count's warehouse in each hit and no price (a count prices nothing). Sticky, so a
       long count's entry line stays in view under the rows; it is drawn outside the virtual rows. -->
  <tr class="count-entry" data-testid="count-entry">
    <td class="text-medium-emphasis text-center"><v-icon size="small">mdi-plus</v-icon></td>
    <td :colspan="colspan">
      <div class="d-flex align-center ga-1">
        <ProductSearch
          ref="searchRef"
          :key="fresh"
          :org-url="orgUrl"
          :disabled="!warehouseId"
          :price-field="null"
          :stock-warehouse-id="warehouseId"
          :base-currency="baseCurrency"
          :locale="locale"
          class="flex-grow-1"
          style="max-width: 640px"
          @product-selected="onPicked"
          @details="openDetails"
        />
        <ProductDetailsButton :disabled="!warehouseId" @click="openDetails('')" />
        <span v-if="!warehouseId" class="text-caption text-medium-emphasis ms-2" data-testid="count-entry-hint">
          {{ $t('warehouse.countLine.needWarehouse') }}
        </span>
        <span v-else-if="note" class="text-caption text-info ms-2" data-testid="count-entry-note">{{ note }}</span>
      </div>
      <!-- FR-33.5: Details for one article or a whole shelf: several at once, the count's articles marked. -->
      <ProductPickerDialog
        v-model="detailsOpen"
        :org-url="orgUrl"
        :base-currency="baseCurrency"
        :locale="locale"
        multiple
        :stock-warehouse-id="warehouseId"
        :existing-product-ids="existingProductIds"
        :initial-search="detailsText"
        @select-many="onManyPicked"
      />
    </td>
  </tr>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import ProductSearch from 'ui-shared/components/ProductSearch.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ProductDetailsButton from 'ui-shared/components/ProductDetailsButton.vue'
import type { PickedArticle } from '../composables/count-lines'

defineProps<{
  orgUrl: string
  /** The count's warehouse: the hits' stock, and System. None: the line waits for one. */
  warehouseId: string
  /** The articles on the count, marked in Details. */
  existingProductIds: readonly string[]
  /** The cells after the first: the line spans the table. */
  colspan: number
  baseCurrency?: string
  locale?: string
  /** What the last pick did ("Already on the count: line 2"). */
  note?: string
}>()

const emit = defineEmits<{
  /** The articles picked, in the order picked: one from the search, one or several from Details. */
  add: [articles: PickedArticle[]]
}>()

const searchRef = ref<{ $el?: HTMLElement } | null>(null)
/** A new key after each pick: the field starts empty again, a fresh entry line (FR-33.6). */
const fresh = ref(0)
const detailsOpen = ref(false)
const detailsText = ref('')

function onPicked(product: PickedArticle) {
  fresh.value++
  emit('add', [product])
}

function openDetails(text: string) {
  detailsText.value = text
  detailsOpen.value = true
}

function onManyPicked(products: PickedArticle[]) {
  fresh.value++
  if (products.length) emit('add', products)
}

/** The cursor in the search field ("+ Add line", and past the last line). */
function focus() {
  const input = searchRef.value?.$el?.querySelector('input')
  if (input && !input.disabled) input.focus()
}

defineExpose({ focus })
</script>

<style scoped>
.count-entry {
  position: sticky;
  bottom: 0;
  z-index: 2;
}
.count-entry > td {
  background: rgb(var(--v-theme-surface));
  border-top: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
