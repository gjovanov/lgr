<template>
  <v-text-field
    :model-value="displayValue"
    :label="label"
    :rules="rules"
    :readonly="readonly"
    :disabled="disabled"
    :density="density"
    :variant="variant"
    :hide-details="hideDetails"
    type="number"
    step="0.01"
    min="0"
    :prefix="currencySymbol"
    class="text-end"
    @update:model-value="onInput"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { parseTyped } from '../composables/price-precision'

const props = withDefaults(defineProps<{
  modelValue: number
  label?: string
  currency?: string
  rules?: Array<(v: unknown) => boolean | string>
  readonly?: boolean
  disabled?: boolean
  density?: 'default' | 'comfortable' | 'compact'
  variant?: 'filled' | 'outlined' | 'plain' | 'underlined' | 'solo' | 'solo-inverted' | 'solo-filled'
  hideDetails?: boolean | string
}>(), {
  label: '',
  currency: 'EUR',
  rules: () => [],
  readonly: false,
  disabled: false,
  density: 'default',
  variant: 'filled',
  hideDetails: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

const currencySymbol = computed(() => {
  const symbols: Record<string, string> = { EUR: '\u20AC', USD: '$', GBP: '\u00A3', MKD: '\u0434\u0435\u043D' }
  return symbols[props.currency] || props.currency
})

const displayValue = computed(() => props.modelValue)

function onInput(val: string | number) {
  // A comma is a decimal point (owner, 2026-11-12): parseFloat("12,5") was 12.
  emit('update:modelValue', parseTyped(val) ?? 0)
}
</script>
