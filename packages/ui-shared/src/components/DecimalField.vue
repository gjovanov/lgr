<template>
  <v-text-field
    :model-value="text"
    type="number"
    step="any"
    inputmode="decimal"
    class="decimal-field"
    @update:model-value="onType"
    @update:focused="onFocused"
  />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { formatFixed, parseTyped, roundTo } from '../composables/price-precision'

/**
 * A number with a fixed count of decimals: a price to four (0.0472), a margin to three (2000.555).
 *
 *   - At rest it shows every decimal (`12.5000`), so a column of figures reads as one.
 *   - While the person types, the text is theirs („12." on its way to 12.5) and the model already holds the figure
 *     rounded to `decimals`: a save by keyboard, with the field still focused, stores no fifth decimal.
 *   - ⚠ It emits only for what was TYPED. A figure it was handed is shown rounded and never written back: an article
 *     loaded with 0.04723 keeps it until somebody changes that price.
 *   - An emptied field is 0.
 *
 * Every other attribute goes to the `v-text-field` (label, density, variant, suffix, disabled, `aria-label`, …).
 */
const props = defineProps<{
  modelValue?: number | string | null
  /** Decimal places shown at rest, and kept of what is typed. */
  decimals: number
}>()

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const text = ref(formatFixed(props.modelValue, props.decimals))
/** The figure the text stands for: what was typed last, or what the parent last handed in. */
let held = roundTo(props.modelValue, props.decimals)
/** The person has typed since the field took focus. */
let typing = false

watch(() => [props.modelValue, props.decimals] as const, ([value, decimals]) => {
  const next = roundTo(value, decimals)
  // The parent handing back the figure just typed is no reason to rewrite the text under the cursor.
  if (typing && next === held) return
  held = next
  text.value = formatFixed(value, decimals)
})

function onType(value: unknown) {
  typing = true
  text.value = value === null || value === undefined ? '' : String(value)
  held = roundTo(parseTyped(value) ?? 0, props.decimals)
  emit('update:modelValue', held)
}

function onFocused(focused: boolean) {
  if (focused) return
  if (typing) text.value = formatFixed(held, props.decimals)
  typing = false
}
</script>

<style scoped>
/* No spin buttons: they take the room of two digits, step by a ten-thousandth, and turn a scroll of the wheel over a
   focused field into a changed price. `display: none` (not `appearance`) is what stops the wheel in Chrome. */
.decimal-field :deep(input[type='number']) {
  appearance: textfield;
  -moz-appearance: textfield;
}
.decimal-field :deep(input[type='number']::-webkit-inner-spin-button),
.decimal-field :deep(input[type='number']::-webkit-outer-spin-button) {
  display: none;
  margin: 0;
}
</style>
