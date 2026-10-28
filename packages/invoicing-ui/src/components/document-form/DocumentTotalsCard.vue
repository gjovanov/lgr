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
      <!-- What has been paid and what is still due. A payment has no page of its own, so this is
           where the form shows it (it used to be a „Payments" smart button that opened nothing). -->
      <template v-if="amountPaid > 0">
        <div class="d-flex justify-space-between mt-2" data-testid="totals-amount-paid">
          <span>{{ $t('invoicing.amountPaid') }}</span>
          <span>{{ fmtCurrency(amountPaid) }}</span>
        </div>
        <div class="d-flex justify-space-between" data-testid="totals-amount-due">
          <span>{{ $t('invoicing.amountDue') }}</span>
          <span class="font-weight-medium">{{ fmtCurrency(amountDue) }}</span>
        </div>
      </template>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ doc: any }>()
const { config, subtotal, discountTotal, taxBase, taxTotal, documentTotal, uniformTaxRate, fmtCurrency, isColActive, invoiceData } = props.doc

// Shown whenever a line HAS a discount, not only while the Discount column is visible: hiding
// the row while a discount still applied left a subtotal and VAT that did not add up to the total.
const showDiscount = computed(() =>
  config.totals.showDiscountRow && (isColActive('discount') || discountTotal.value > 0),
)

const amountPaid = computed(() => Number(invoiceData.value?.amountPaid) || 0)
// Against the total on screen, so an edit shows what will be due once it is saved.
const amountDue = computed(() => Math.max(0, Math.round((documentTotal.value - amountPaid.value) * 100) / 100))
</script>
