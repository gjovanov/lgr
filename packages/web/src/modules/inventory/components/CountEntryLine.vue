<template>
  <!-- FR-33.4 (#933): the count's entry line, the last row of the lines (D-7). The movement's pair: `ProductSearch` and
       Details, with the stock of the count's warehouse in each hit and no price (a count prices nothing). Sticky, so a
       long count's entry line stays in view under the rows; it is drawn outside the virtual rows. -->
  <tr class="count-entry" data-testid="count-entry">
    <td class="text-medium-emphasis text-center"><v-icon size="small">mdi-plus</v-icon></td>
    <td :colspan="colspan">
      <div class="d-flex align-center ga-1">
        <!-- FR-33.11: Enter in the field is heard here first, before ProductSearch's own (a capture listener on an
             ancestor runs before the field's): a code that names one article is taken without a list. -->
        <div ref="fieldRef" class="flex-grow-1" style="max-width: 640px" @keydown.capture="onFieldKeydown">
          <ProductSearch
            ref="searchRef"
            :key="fresh"
            :org-url="orgUrl"
            :disabled="!warehouseId"
            :price-field="null"
            :stock-warehouse-id="warehouseId"
            :base-currency="baseCurrency"
            :locale="locale"
            @product-selected="onPicked"
            @details="openDetails"
          />
        </div>
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
import { lookupProductCode } from '../api/products'
import type { PickedArticle } from '../composables/count-lines'
import { CODE_MIN_CHARS, scanPace, useCountScanner } from '../composables/count-scan'

const props = defineProps<{
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

// ── FR-33.11: a scanner. Enter asks what the field's code names (FR-22.55's rule); a code of one article is taken as a
//    pick is, with no list; anything else typed is FR-33.12's first hit, and anything else scanned leaves the list open.
const fieldRef = ref<HTMLElement | null>(null)
const pace = scanPace()
/** Keys that edit or move in the text: a person typing, never a scanner. */
const EDIT_KEYS = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
/** Set while an Enter is handed on to ProductSearch for its first hit: that one is not looked up again. */
let handingOn = false

function fieldInput(): HTMLInputElement | null {
  return fieldRef.value?.querySelector('input') ?? null
}

const scanner = useCountScanner({
  text: () => fieldInput()?.value ?? '',
  lookup: async (code) => (await lookupProductCode(code)).product,
  onCount: () => props.existingProductIds,
  taken: (rest) => {
    // Nothing typed behind the code: a fresh entry line, as after a pick. Otherwise the field keeps the next code.
    if (!rest) {
      fresh.value++
      return
    }
    const input = fieldInput()
    if (!input) return
    input.value = rest
    input.dispatchEvent(new Event('input', { bubbles: true }))
  },
  add: (article) => emit('add', [article]),
  firstHit: () => {
    const input = fieldInput()
    if (!input) return
    handingOn = true
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    } finally {
      handingOn = false
    }
  },
})

function onFieldKeydown(e: KeyboardEvent) {
  const input = fieldInput()
  // Only the field's own keys: ↓ moves the focus into the list, which is not inside this element.
  if (!input || e.target !== input || handingOn) return
  if (e.key === 'Enter') {
    if (e.defaultPrevented || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
    // Too short to be a code, and no Enter before it still in turn: the field's own Enter.
    if (!scanner.busy() && input.value.trim().length < CODE_MIN_CHARS) return
    e.preventDefault()
    e.stopPropagation()
    void scanner.enter(pace.enter(input.value))
    return
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) pace.key(input.value === '')
  else if (EDIT_KEYS.has(e.key)) pace.edit()
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
