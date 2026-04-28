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
    data-testid="tax-rate-combobox"
    @update:model-value="onValueChange"
  >
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps" :subtitle="item.raw.raw?.name">
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
import { computed, ref, onMounted } from 'vue'
import { httpClient } from '../composables/useHttpClient'

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
     * If empty AND `orgUrl` is set, the component fetches them itself.
     * The combobox always allows a free-typed override.
     */
    rates?: VatRate[]
    /** The numeric rate marked as default on the org settings (e.g. 18 / 20). */
    defaultRate?: number | null
    /** Base org URL used to auto-fetch settings when `rates` is empty. E.g. `/org/abc123`. */
    orgUrl?: string
    label?: string
  }>(),
  {
    rates: () => [],
    defaultRate: null,
    orgUrl: '',
    label: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [rate: number]
}>()

// Module-level cache to avoid refetching on every row render. Keyed by orgUrl.
const fetchCache = new Map<string, { rates: VatRate[]; defaultRate: number | null }>()
const fetched = ref<{ rates: VatRate[]; defaultRate: number | null } | null>(null)

async function loadIfNeeded() {
  if (props.rates && props.rates.length > 0) return
  if (!props.orgUrl) return
  if (fetchCache.has(props.orgUrl)) {
    fetched.value = fetchCache.get(props.orgUrl)!
    return
  }
  try {
    const { data } = await httpClient.get(props.orgUrl)
    const settings = (data?.org?.settings || data?.settings || {}) as any
    const tc = settings.taxConfig || {}
    const payload = {
      rates: (tc.vatRates || []) as VatRate[],
      defaultRate: (tc.defaultVatRate ?? null) as number | null,
    }
    fetchCache.set(props.orgUrl, payload)
    fetched.value = payload
  } catch {
    /* keep free-typed fallback silently */
  }
}

onMounted(loadIfNeeded)

const effectiveRates = computed<VatRate[]>(() => (props.rates && props.rates.length ? props.rates : (fetched.value?.rates || [])))
const effectiveDefault = computed<number | null>(() =>
  props.defaultRate != null ? props.defaultRate : (fetched.value?.defaultRate ?? null),
)

interface ComboItem { title: string; value: number; raw: { name: string; rate: number; isDefault: boolean } }

const comboItems = computed<ComboItem[]>(() => {
  return effectiveRates.value.map((r) => ({
    title: `${r.rate}%`,
    value: r.rate,
    raw: { name: r.name, rate: r.rate, isDefault: !!r.default || r.rate === effectiveDefault.value },
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
