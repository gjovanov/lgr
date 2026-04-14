<template>
  <v-combobox
    :model-value="displayValue"
    :items="comboItems"
    item-title="title"
    item-value="value"
    return-object
    density="compact"
    hide-details
    variant="underlined"
    :label="label"
    :placeholder="$t ? $t('invoicing.taxRate') : 'Tax Rate'"
    suffix="%"
    data-testid="tax-rate-combobox"
    @update:model-value="onValueChange"
  >
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps">
        <template #prepend>
          <v-icon size="small" :color="item.raw.raw?.isDefault ? 'primary' : 'grey'">
            {{ item.raw.raw?.isDefault ? 'mdi-star' : 'mdi-percent-outline' }}
          </v-icon>
        </template>
      </v-list-item>
    </template>
  </v-combobox>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface VatRate {
  name: string
  rate: number
  default?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: number | null | undefined
    /**
     * VAT rate presets, typically read from `org.settings.taxConfig.vatRates`.
     * The combobox always allows a free-typed override.
     */
    rates?: VatRate[]
    /** The numeric rate marked as default on the org settings (e.g. 18 / 20). */
    defaultRate?: number | null
    label?: string
  }>(),
  {
    rates: () => [],
    defaultRate: null,
    label: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [rate: number]
}>()

interface ComboItem { title: string; value: number; raw: { name: string; rate: number; isDefault: boolean } }

const comboItems = computed<ComboItem[]>(() => {
  return props.rates.map((r) => ({
    title: `${r.name} — ${r.rate}%`,
    value: r.rate,
    raw: { name: r.name, rate: r.rate, isDefault: !!r.default || r.rate === props.defaultRate },
  }))
})

const displayValue = computed<ComboItem | string>(() => {
  const match = comboItems.value.find((i) => i.value === props.modelValue)
  if (match) return match
  return props.modelValue != null ? String(props.modelValue) : ''
})

function onValueChange(val: any) {
  let rate: number
  if (val && typeof val === 'object' && 'value' in val) {
    rate = Number(val.value)
  } else if (typeof val === 'string') {
    // Accept "18" or "18 %" or "Standard — 18%" → extract number.
    const numStr = val.includes('—') ? val.split('—')[1] : val
    rate = Number(numStr.replace(/[%\s]/g, ''))
  } else {
    rate = Number(val)
  }
  if (Number.isNaN(rate) || rate < 0) return
  emit('update:modelValue', rate)
}
</script>
