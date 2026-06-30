<template>
  <v-card variant="outlined">
    <v-card-text>
      <div class="d-flex justify-space-between mb-2">
        <span>{{ $t('invoicing.subtotal') }}</span>
        <span class="font-weight-medium">{{ fmtCurrency(subtotal) }}</span>
      </div>
      <div v-if="config.totals.showDiscountRow" class="d-flex justify-space-between mb-2">
        <span>{{ $t('invoicing.discountTotal') }}</span>
        <span class="text-error">-{{ fmtCurrency(discountTotal) }}</span>
      </div>
      <div class="d-flex justify-space-between mb-2">
        <span>{{ $t('invoicing.taxTotal') }}</span>
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
const props = defineProps<{ doc: any }>()
const { config, subtotal, discountTotal, taxTotal, documentTotal, fmtCurrency } = props.doc
</script>
