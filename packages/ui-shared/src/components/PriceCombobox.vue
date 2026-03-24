<template>
  <v-combobox
    v-model="displayValue"
    :items="comboItems"
    item-title="title"
    item-value="value"
    :loading="loading"
    density="compact"
    hide-details
    variant="underlined"
    type="number"
    :placeholder="$t('invoicing.unitPrice')"
    data-testid="price-combobox"
    @update:model-value="onValueChange"
  >
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps">
        <template #prepend>
          <v-icon size="small" :color="typeColor(item.raw.raw?.type)">
            {{ typeIcon(item.raw.raw?.type) }}
          </v-icon>
        </template>
      </v-list-item>
    </template>
  </v-combobox>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { fetchPriceOptions, formatPriceItem, type PriceOption } from '../composables/usePriceOptions'

const props = withDefaults(defineProps<{
  modelValue: number
  productId?: string
  contactId?: string
  quantity?: number
  orgUrl: string
  currency?: string
  resolvedPrice?: number
  priceExplanation?: { type: string; label: string; price: number }[]
}>(), {
  currency: 'EUR',
  quantity: 1,
})

const emit = defineEmits<{
  'update:modelValue': [price: number]
  'update:priceExplanation': [steps: { type: string; label: string; price: number }[]]
  'price-selected': [option: PriceOption | null]
}>()

const options = ref<PriceOption[]>([])
const resolvedKey = ref('')
const loading = ref(false)

const comboItems = computed(() =>
  options.value.map(opt => ({
    title: formatPriceItem(opt, props.currency),
    value: opt.price,
    raw: opt,
  }))
)

const displayValue = computed({
  get: () => props.modelValue,
  set: () => {}, // handled by onValueChange
})

function typeIcon(type?: string) {
  switch (type) {
    case 'base': return 'mdi-tag-outline'
    case 'tag': return 'mdi-label'
    case 'contact': return 'mdi-account'
    case 'category': return 'mdi-shape'
    default: return 'mdi-currency-usd'
  }
}

function typeColor(type?: string) {
  switch (type) {
    case 'base': return 'grey'
    case 'tag': return 'blue'
    case 'contact': return 'green'
    case 'category': return 'orange'
    default: return 'grey'
  }
}

async function loadOptions() {
  if (!props.productId) {
    options.value = []
    return
  }
  loading.value = true
  try {
    const result = await fetchPriceOptions(props.orgUrl, props.productId, props.contactId, props.quantity)
    options.value = result.options
    resolvedKey.value = result.resolvedKey
  } catch {
    options.value = []
  } finally {
    loading.value = false
  }
}

function onValueChange(val: any) {
  // v-combobox can emit the item object or a raw typed value
  let price: number
  let selectedOption: PriceOption | null = null

  if (val && typeof val === 'object' && 'value' in val) {
    price = Number(val.value)
    selectedOption = val.raw || null
  } else {
    price = Number(val)
  }

  if (isNaN(price) || price < 0) return

  emit('update:modelValue', price)

  // Build price explanation
  if (selectedOption) {
    const steps = [
      { type: selectedOption.type, label: selectedOption.name, price: selectedOption.price },
    ]
    emit('update:priceExplanation', steps)
  } else if (price !== props.resolvedPrice) {
    // Free-text override
    const existing = props.priceExplanation || []
    const steps = [...existing, { type: 'override', label: 'Manual override', price }]
    emit('update:priceExplanation', steps)
  }

  emit('price-selected', selectedOption)
}

// Watch for prop changes that should trigger re-fetch
watch(() => props.productId, loadOptions)
watch(() => props.contactId, loadOptions)
watch(() => props.quantity, loadOptions, { flush: 'post' })

onMounted(loadOptions)
</script>
