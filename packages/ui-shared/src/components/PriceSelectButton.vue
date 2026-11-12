<template>
  <v-menu :disabled="!productId" location="bottom start" @update:model-value="onOpen">
    <template #activator="{ props: mp }">
      <v-btn
        v-bind="mp"
        :icon="pinned ? 'mdi-tag-check' : 'mdi-tag-multiple-outline'"
        size="x-small"
        variant="text"
        tabindex="-1"
        :density="density"
        :color="productId ? 'primary' : undefined"
        :title="pinned && pinnedTitle ? pinnedTitle : $t('invoicing.selectPrice')"
        :aria-label="$t('invoicing.selectPrice')"
        :data-pinned="pinned ? 'true' : undefined"
      />
    </template>
    <v-list density="compact" min-width="240" max-height="360">
      <v-list-subheader>{{ $t('invoicing.selectPrice') }}</v-list-subheader>
      <v-list-item v-if="loading" disabled>
        <v-list-item-title class="text-medium-emphasis">{{ $t('common.loading') }}</v-list-item-title>
      </v-list-item>
      <template v-else>
        <!-- A chosen price can be given back: the line is priced for the client again. Offered only where the
             screen keeps the choice (`pinned` and a `release-label`): the customer order. -->
        <template v-if="pinned && releaseLabel">
          <v-list-item data-testid="price-release" @click="release">
            <template #prepend>
              <v-icon size="small" color="grey">mdi-autorenew</v-icon>
            </template>
            <v-list-item-title>{{ releaseLabel }}</v-list-item-title>
            <template v-if="resolvedPrice !== undefined" #append>
              <span class="text-body-2 font-weight-medium ml-4">{{ fmt(resolvedPrice) }}</span>
            </template>
          </v-list-item>
          <v-divider />
        </template>
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
import { computed, ref } from 'vue'
import { fetchPriceOptions, formatPriceItem, priceOptionLabel, type PriceOption } from '../composables/usePriceOptions'

const props = withDefaults(defineProps<{
  productId?: string
  contactId?: string
  quantity?: number
  orgUrl: string
  currency?: string
  /** `compact` where the column has no room to give: the order trees, whose price column holds the button and a figure. */
  density?: 'default' | 'comfortable' | 'compact'
  /** The line's price was chosen and is kept as chosen: the button says so. The customer order's lines. */
  pinned?: boolean
  /** What the button says (its title) while `pinned`. */
  pinnedTitle?: string
  /** With `pinned`: the menu's first entry, which gives the choice back (`release`). */
  releaseLabel?: string
}>(), { currency: 'EUR', quantity: 1 })

const emit = defineEmits<{
  'select': [option: PriceOption]
  /** The choice is given back. `price` is what the customer resolves to now, when the list knows it. */
  'release': [price: number | undefined]
}>()

const options = ref<PriceOption[]>([])
const resolvedKey = ref('')
const loading = ref(false)

/** The price the customer resolves to now: the option the list marks. */
const resolvedPrice = computed(() => options.value.find((o) => o.key === resolvedKey.value)?.price)

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

function release() {
  emit('release', resolvedPrice.value)
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
