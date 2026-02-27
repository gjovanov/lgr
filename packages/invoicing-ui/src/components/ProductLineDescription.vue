<template>
  <div class="product-line-description" style="position:relative">
    <v-text-field
      ref="inputRef"
      :model-value="description"
      density="compact"
      hide-details
      variant="underlined"
      :placeholder="$t('invoicing.searchProduct')"
      @update:model-value="onInput"
      @focus="onFocus"
      @blur="onBlur"
    />
    <v-menu
      v-model="menuOpen"
      :activator="inputRef?.$el"
      :close-on-content-click="true"
      offset-y
      max-height="250"
      min-width="280"
    >
      <v-list density="compact">
        <v-list-item
          v-for="p in filteredProducts"
          :key="p._id"
          @mousedown.prevent="selectProduct(p)"
        >
          <v-list-item-title>{{ p.name }}</v-list-item-title>
          <v-list-item-subtitle>{{ p.sku }} &mdash; {{ fmtPrice(p) }}</v-list-item-subtitle>
        </v-list-item>
        <v-list-item v-if="filteredProducts.length === 0" disabled>
          <v-list-item-title class="text-grey">{{ $t('invoicing.noProductsFound') }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
    <v-chip
      v-if="linkedProductName"
      size="x-small"
      closable
      color="primary"
      class="mt-1"
      @click:close="clearProduct"
    >
      {{ linkedProductName }}
    </v-chip>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'

interface Product {
  _id: string
  name: string
  sku: string
  unit: string
  sellingPrice: number
  purchasePrice: number
  taxRate: number
  currency: string
}

const props = defineProps<{
  description: string
  productId?: string
  priceField: 'sellingPrice' | 'purchasePrice'
}>()

const emit = defineEmits<{
  'update:description': [value: string]
  'update:productId': [value: string | undefined]
  'product-selected': [product: Product]
  'product-cleared': []
}>()

const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const inputRef = ref()
const menuOpen = ref(false)
const products = ref<Product[]>([])
const linkedProductName = ref('')
const searchText = ref('')

const filteredProducts = computed(() => {
  const q = searchText.value.toLowerCase()
  if (q.length < 2) return []
  return products.value.filter(
    (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
  )
})

function fmtPrice(p: Product) {
  return formatCurrency(p[props.priceField], p.currency || baseCurrency.value, localeCode.value)
}

function onInput(val: string) {
  searchText.value = val
  emit('update:description', val)
  menuOpen.value = searchText.value.length >= 2 && filteredProducts.value.length > 0
}

function onFocus() {
  if (searchText.value.length >= 2 && filteredProducts.value.length > 0) {
    menuOpen.value = true
  }
}

function onBlur() {
  // Delay close so mousedown on menu item fires first
  setTimeout(() => { menuOpen.value = false }, 150)
}

function selectProduct(p: Product) {
  linkedProductName.value = p.name
  emit('update:description', p.name)
  emit('update:productId', p._id)
  emit('product-selected', p)
  menuOpen.value = false
  searchText.value = p.name
}

function clearProduct() {
  linkedProductName.value = ''
  emit('update:productId', undefined)
  emit('product-cleared')
}

function resolveProductName(pid: string | undefined) {
  if (!pid) { linkedProductName.value = ''; return }
  const found = products.value.find((p) => p._id === pid)
  linkedProductName.value = found?.name || ''
}

watch(() => props.productId, (pid) => resolveProductName(pid))

// Watch for filteredProducts changes to keep menu in sync
watch(filteredProducts, (fp) => {
  if (fp.length > 0 && searchText.value.length >= 2) {
    menuOpen.value = true
  } else {
    menuOpen.value = false
  }
})

onMounted(async () => {
  try {
    const orgId = appStore.currentOrg?.id
    if (!orgId) return
    const { data } = await httpClient.get(`/org/${orgId}/warehouse/product`, { params: { pageSize: 0 } })
    products.value = data.products || []
    // Resolve initial productId if editing
    resolveProductName(props.productId)
    searchText.value = props.description
  } catch { /* products remain empty */ }
})
</script>
