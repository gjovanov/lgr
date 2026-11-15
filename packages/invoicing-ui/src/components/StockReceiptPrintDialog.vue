<template>
  <!-- Owner, 2026-11-15: a supplier bill's „Складова разписка" is the sheet the warehouse prices the goods from, so
       the print asks which price to show. Nothing prints before „Печат"; Cancel and Esc leave everything as it was. -->
  <v-dialog v-model="open" max-width="440" @after-enter="focusPrint">
    <v-card data-testid="stock-receipt-dialog">
      <v-card-title class="d-flex align-center ga-2 text-wrap">
        <v-icon>mdi-clipboard-text-outline</v-icon>
        {{ $t('invoicing.stockReceipt.print') }}
      </v-card-title>
      <v-card-text>
        <v-select
          v-model="level"
          :items="items"
          :label="$t('invoicing.stockReceipt.price')"
          density="compact"
          variant="outlined"
          hide-details
          data-testid="stock-receipt-price"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" data-testid="stock-receipt-cancel" @click="open = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          ref="printButton"
          color="primary"
          variant="flat"
          prepend-icon="mdi-printer"
          :loading="loading"
          :disabled="!level"
          data-testid="stock-receipt-confirm"
          @click="confirm"
        >
          {{ $t('common.print') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { accessGrant } from 'ui-shared/access/useAccess'
import { priceLevelItems, rememberPriceLevel, startingPriceLevel, type PriceLevelItem } from '../composables/stock-receipt-price'

const props = defineProps<{
  modelValue: boolean
  /** The print is being rendered: the button spins, and a second press does nothing. */
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** „Печат" was pressed: print at this level (`config/stock-receipt-price`, the route's `priceLevel`). */
  confirm: [priceLevel: string]
}>()

const { t, locale } = useI18n()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const items = ref<PriceLevelItem[]>([])
const level = ref('')
const printButton = ref<{ $el?: HTMLElement } | null>(null)

// Read again on every open: the last choice may have been made on another bill, and the role may have changed
// since (FR-27.5). Only the levels the role sees are offered; the route refuses the others whatever is sent.
watch(open, (isOpen) => {
  if (!isOpen) return
  const grant = accessGrant()
  items.value = priceLevelItems(grant, (key) => t(key), locale.value)
  level.value = startingPriceLevel(grant)
}, { immediate: true })

/** The level it opens on is the one most often wanted: Enter prints it. */
function focusPrint() {
  printButton.value?.$el?.focus?.()
}

function confirm() {
  if (!level.value) return
  rememberPriceLevel(level.value)
  emit('confirm', level.value)
}
</script>
