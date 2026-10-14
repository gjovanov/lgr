<template>
  <v-combobox
    :model-value="currentDisplay"
    :items="comboItems"
    item-title="title"
    item-value="value"
    return-object
    :loading="loading"
    density="compact"
    hide-details
    variant="underlined"
    style="min-width: 130px"
    :placeholder="$t('invoicing.unitPrice')"
    data-testid="price-combobox"
    @update:model-value="onValueChange"
  >
    <!-- Closed control shows ONLY the number (≤5 decimals, no name); the "— {tag name}"
         appears only in the open dropdown items (#item below). min-width fits 5 decimals + arrow. -->
    <template #selection>
      <span class="text-truncate">{{ displayNumber }}</span>
    </template>
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
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchPriceOptions, formatPriceItem, priceOptionLabel, type PriceOption } from '../composables/usePriceOptions'

const props = withDefaults(defineProps<{
  modelValue: number
  productId?: string
  contactId?: string
  quantity?: number
  orgUrl: string
  currency?: string
  resolvedPrice?: number
  priceExplanation?: { type: string; label: string; price: number }[]
  /** When false, never overwrite modelValue with the backend-resolved price (lines
   *  loaded from a persisted document keep their historical price + explanation). */
  autoApplyResolved?: boolean
  /** List EVERY named price, the filterless „Цена N" slots included (`/pricing/options?all=true`,
   *  what PriceSelectButton shows). Off: only the prices that apply to this contact/quantity. */
  all?: boolean
}>(), {
  currency: 'EUR',
  quantity: 1,
  autoApplyResolved: true,
  all: false,
})

const emit = defineEmits<{
  'update:modelValue': [price: number]
  'update:priceExplanation': [steps: { type: string; label: string; price: number }[]]
  'price-selected': [option: PriceOption | null]
}>()

const { t } = useI18n()
const options = ref<PriceOption[]>([])
const resolvedKey = ref('')
const loading = ref(false)

const comboItems = computed(() =>
  options.value.map(opt => ({
    title: formatPriceItem({ ...opt, name: priceOptionLabel(opt, t) }, props.currency),
    value: opt.price,
    raw: opt,
  }))
)

// Show the selected item (formatted) or raw number if no match
const currentDisplay = computed(() => {
  const match = comboItems.value.find(item => item.value === props.modelValue)
  return match || (props.modelValue != null ? String(props.modelValue) : '')
})

// Closed-state text: the price only, always 5 decimals (1 → "1.00000"), no name.
const displayNumber = computed(() => {
  if (props.modelValue == null || props.modelValue === ('' as any)) return ''
  const n = Number(props.modelValue)
  if (Number.isNaN(n)) return String(props.modelValue)
  return n.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5, useGrouping: false })
})

function typeIcon(type?: string) {
  switch (type) {
    case 'base': return 'mdi-tag-outline'
    case 'tag': return 'mdi-label'
    case 'contact': return 'mdi-account'
    case 'category': return 'mdi-shape'
    case 'tier': return 'mdi-stairs'
    default: return 'mdi-currency-usd'
  }
}

function typeColor(type?: string) {
  switch (type) {
    case 'base': return 'grey'
    case 'tag': return 'blue'
    case 'contact': return 'green'
    case 'category': return 'orange'
    case 'tier': return 'purple'
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
    const result = await fetchPriceOptions(props.orgUrl, props.productId, props.contactId, props.quantity, props.all)
    options.value = result.options
    resolvedKey.value = result.resolvedKey

    // Auto-select the resolved option and emit its price
    await nextTick()
    autoSelectResolved()
  } catch {
    options.value = []
  } finally {
    loading.value = false
  }
}

/**
 * Build the full price explanation chain: always starts with selling price,
 * then shows the winning step (tag/contact/category) if different.
 */
function buildExplanationChain(selected: PriceOption): { type: string; label: string; price: number }[] {
  const steps: { type: string; label: string; price: number }[] = []

  // Step 1: Always include the base selling price as the starting point
  const base = options.value.find(o => o.type === 'base')
  if (base) {
    steps.push({ type: 'base', label: base.name, price: base.price })
  }

  // Step 2: If the selected option is not the base, add it as the override step
  if (selected.type !== 'base') {
    steps.push({ type: selected.type, label: selected.name, price: selected.price })
  }

  return steps
}

/**
 * After options load, find the option matching resolvedKey and emit its price.
 * This is the core of tag-based pricing: the backend resolves the best price
 * (base → category → tag lowest → contact), and we auto-select it here.
 */
function autoSelectResolved() {
  // Persisted lines are historical facts — never rewrite their price on load/refetch.
  if (!props.autoApplyResolved) return
  if (!resolvedKey.value || options.value.length === 0) return

  const resolved = options.value.find(o => o.key === resolvedKey.value)
  if (!resolved) return

  const chain = buildExplanationChain(resolved)

  if (props.modelValue === resolved.price) {
    // Price is already correct — just ensure the explanation chain is set
    emit('update:priceExplanation', chain)
    return
  }

  // Emit the resolved price as the new value
  emit('update:modelValue', resolved.price)
  emit('update:priceExplanation', chain)
  emit('price-selected', resolved)
}

function onValueChange(val: any) {
  // With return-object, dropdown selection emits the full item object
  // Free-text entry emits a raw string
  let price: number
  let selectedOption: PriceOption | null = null

  if (val && typeof val === 'object' && 'value' in val) {
    // Dropdown selection — item object with { title, value, raw }
    price = Number(val.value)
    selectedOption = val.raw || null
  } else if (typeof val === 'string') {
    // Free-text entry — might be "10.00 — Selling price" or just "42.50"
    const numStr = val.includes('—') ? val.split('—')[0].trim() : val.trim()
    price = Number(numStr)
  } else {
    price = Number(val)
  }

  if (isNaN(price) || price < 0) return

  emit('update:modelValue', price)

  // Build full price explanation chain
  if (selectedOption) {
    // User selected from dropdown — build chain from base → selected
    emit('update:priceExplanation', buildExplanationChain(selectedOption))
  } else {
    // Free-text override — build chain from base → manual override
    const base = options.value.find(o => o.type === 'base')
    const steps: { type: string; label: string; price: number }[] = []
    if (base) steps.push({ type: 'base', label: base.name, price: base.price })
    steps.push({ type: 'override', label: 'Manual override', price })
    emit('update:priceExplanation', steps)
  }

  emit('price-selected', selectedOption)
}

// Watch for prop changes that should trigger re-fetch + auto-select
watch(() => props.productId, loadOptions)
watch(() => props.contactId, loadOptions)
watch(() => props.all, loadOptions)
watch(() => props.quantity, loadOptions, { flush: 'post' })

onMounted(loadOptions)
</script>
