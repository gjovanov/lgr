<template>
  <v-row dense>
    <v-col cols="12" md="3">
      <v-select
        v-model="form.paymentMethod"
        :label="$t('invoicing.paymentMethod')"
        :items="paymentMethods"
        item-title="text"
        item-value="value"
        :clearable="config.paymentMethodMode === 'clearable'"
        persistent-placeholder
      />
    </v-col>
    <v-col cols="12" md="3">
      <v-select v-model="form.currency" :label="$t('common.currency')" :items="currencies" />
    </v-col>
    <v-col cols="12" md="3">
      <v-text-field v-model.number="form.exchangeRate" :label="$t('invoicing.exchangeRate')" type="number" step="0.0001" min="0" />
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
const props = defineProps<{ doc: any }>()
const { config, form, paymentMethods } = props.doc
const currencies = ['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']
</script>
