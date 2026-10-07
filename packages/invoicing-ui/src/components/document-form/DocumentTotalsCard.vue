<template>
  <v-card variant="outlined">
    <v-card-text>
      <div class="d-flex justify-space-between mb-2">
        <span>{{ $t('invoicing.subtotal') }}</span>
        <span class="font-weight-medium">{{ fmtCurrency(subtotal) }}</span>
      </div>
      <template v-if="showDiscount">
        <div class="d-flex justify-space-between mb-2">
          <span>{{ $t('invoicing.discountTotal') }}</span>
          <span class="text-error">-{{ fmtCurrency(discountTotal) }}</span>
        </div>
        <!-- The sum of the line amounts, which are shown after their discount. -->
        <div class="d-flex justify-space-between mb-2">
          <span>{{ $t('invoicing.taxBase') }}</span>
          <span class="font-weight-medium">{{ fmtCurrency(taxBase) }}</span>
        </div>
      </template>
      <div class="d-flex justify-space-between mb-2">
        <span>{{ uniformTaxRate !== null ? $t('invoicing.taxTotalWithRate', { rate: uniformTaxRate }) : $t('invoicing.taxTotal') }}</span>
        <span>{{ fmtCurrency(taxTotal) }}</span>
      </div>
      <v-divider class="my-2" />
      <div class="d-flex justify-space-between text-h6">
        <span>{{ $t('common.total') }}</span>
        <span>{{ fmtCurrency(documentTotal) }}</span>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ doc: any }>()
const { config, subtotal, discountTotal, taxBase, taxTotal, documentTotal, uniformTaxRate, fmtCurrency, isColActive } = props.doc

// Shown whenever a line HAS a discount, not only while the Discount column is visible: hiding
// the row while a discount still applied left a subtotal and VAT that did not add up to the total.
const showDiscount = computed(() =>
  config.totals.showDiscountRow && (isColActive('discount') || discountTotal.value > 0),
)
</script>
