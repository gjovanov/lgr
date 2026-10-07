<template>
  <v-menu :disabled="!productId" location="bottom start" @update:model-value="onOpen">
    <template #activator="{ props: mp }">
      <v-btn
        v-bind="mp"
        icon="mdi-tag-multiple-outline"
        size="x-small"
        variant="text"
        tabindex="-1"
        :color="productId ? 'primary' : undefined"
        :title="$t('invoicing.selectPrice')"
        :aria-label="$t('invoicing.selectPrice')"
      />
    </template>
    <v-list density="compact" min-width="240" max-height="360">
      <v-list-subheader>{{ $t('invoicing.selectPrice') }}</v-list-subheader>
      <v-list-item v-if="loading" disabled>
        <v-list-item-title class="text-medium-emphasis">{{ $t('common.loading') }}</v-list-item-title>
      </v-list-item>
      <template v-else>
        <v-list-item
          v-for="opt in options"
          :key="opt.key"
          :active="opt.key === resolvedKey"
          @click="pick(opt)"
        >
          <template #prepend>
            <v-icon size="small" :color="typeColor(opt.type)">{{ typeIcon(opt.type) }}</v-icon>
          </template>
          <v-list-item-title>{{ priceOptionLabel(opt, $t) }}</v-list-item-title>
          <template #append>
            <span class="text-body-2 font-weight-medium ml-4">{{ fmt(opt.price) }}</span>
          </template>
        </v-list-item>
        <v-list-item v-if="!options.length" disabled>
          <v-list-item-title class="text-medium-emphasis">{{ $t('invoicing.noPrices') }}</v-list-item-title>
        </v-list-item>
      </template>
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { fetchPriceOptions, formatPriceItem, priceOptionLabel, type PriceOption } from '../composables/usePriceOptions'

const props = withDefaults(defineProps<{
  productId?: string
  contactId?: string
  quantity?: number
  orgUrl: string
  currency?: string
}>(), { currency: 'EUR', quantity: 1 })

const emit = defineEmits<{ 'select': [option: PriceOption] }>()

const options = ref<PriceOption[]>([])
const resolvedKey = ref('')
const loading = ref(false)

async function onOpen(open: boolean) {
  if (!open || !props.productId) return
  loading.value = true
  try {
    // all=true: every named price incl. the display-only Цена tier slots.
    const res = await fetchPriceOptions(props.orgUrl, props.productId, props.contactId, props.quantity, true)
    options.value = res.options
    resolvedKey.value = res.resolvedKey
  } catch {
    options.value = []
  } finally {
    loading.value = false
  }
}

function pick(opt: PriceOption) {
  emit('select', opt)
}

function fmt(price: number) {
  return formatPriceItem({ key: '', name: '', price, type: 'base' }, props.currency).split(' — ')[0] + ' ' + (props.currency || '')
}

function typeIcon(type?: string) {
  return { base: 'mdi-tag-outline', tag: 'mdi-label', contact: 'mdi-account', category: 'mdi-shape', tier: 'mdi-stairs' }[type || ''] || 'mdi-currency-usd'
}
function typeColor(type?: string) {
  return { base: 'grey', tag: 'blue', contact: 'green', category: 'orange', tier: 'purple' }[type || ''] || 'grey'
}
</script>
