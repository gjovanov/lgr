<template>
  <v-dialog :model-value="modelValue" max-width="520" @update:model-value="(v: boolean) => { if (!v) emit('update:modelValue', false) }">
    <v-card data-testid="order-cascade">
      <v-card-title class="text-wrap">{{ title }}</v-card-title>
      <v-card-text>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" role="alert">{{ error }}</v-alert>
        <template v-if="summary.count > 0">
          <div class="text-body-1 mb-2">{{ $t('invoicing.cascade.releases', { count: summary.count, quantity: summary.quantity }) }}</div>
          <template v-if="side === 'supplier'">
            <div class="text-body-2">{{ $t('invoicing.cascade.clients', { count: summary.clients }) }}</div>
            <div v-if="summary.orders.length" class="text-body-2" data-testid="order-cascade-orders">
              {{ $t('invoicing.cascade.clientOrders', { numbers: summary.orders.map((o) => o.number).join(', ') }) }}
            </div>
            <div v-if="summary.withoutOrder" class="text-body-2">{{ $t('invoicing.cascade.withoutOrder', { count: summary.withoutOrder }) }}</div>
          </template>
          <template v-else>
            <div v-if="summary.fromStock" class="text-body-2">{{ $t('invoicing.cascade.fromStock', { count: summary.fromStock }) }}</div>
            <div v-if="summary.orders.length" class="text-body-2" data-testid="order-cascade-orders">
              {{ $t('invoicing.cascade.supplierOrders', { numbers: summary.orders.map((o) => o.number).join(', ') }) }}
            </div>
          </template>
        </template>
        <div v-else class="text-body-1">{{ $t('invoicing.cascade.nothing') }}</div>
        <div v-if="stagedLost" class="text-body-2 text-warning mt-3">{{ $t('invoicing.cascade.stagedLost') }}</div>
      </v-card-text>
      <!-- As the reservation's release: „Не" keeps the order, the other button says what happens to it. -->
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">{{ $t('common.no') }}</v-btn>
        <v-btn :color="confirmColor || 'error'" variant="flat" :loading="loading" @click="emit('confirm')">{{ confirmLabel }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import type { CascadeSummary } from '../composables/order-cascade'

/**
 * FR-22.41: before an order is cancelled or completed, what that releases — how many reservations
 * and how much, and the orders on the other side by number (a supplier order names the client
 * orders it lets down). The parent runs the action and shows a refusal here.
 */
defineProps<{
  modelValue: boolean
  title: string
  side: 'supplier' | 'client'
  summary: CascadeSummary
  confirmLabel: string
  confirmColor?: string
  loading?: boolean
  error?: string
  /** Reservation changes staged on the order go with it (the supplier-order form). */
  stagedLost?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; confirm: [] }>()
</script>
