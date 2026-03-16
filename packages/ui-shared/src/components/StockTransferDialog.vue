<template>
  <v-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" max-width="800" persistent>
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon color="warning" class="mr-2">mdi-alert-circle</v-icon>
        {{ $t('invoicing.transferRequired') }}
      </v-card-title>

      <v-card-text>
        <v-alert type="warning" variant="tonal" class="mb-4">
          {{ $t('invoicing.insufficientStock') }}
        </v-alert>

        <!-- Shortfalls table -->
        <v-table density="compact" class="mb-4">
          <thead>
            <tr>
              <th>{{ $t('warehouse.product') }}</th>
              <th>{{ $t('warehouse.warehouse') }}</th>
              <th class="text-end">Requested</th>
              <th class="text-end">Available</th>
              <th class="text-end">Deficit</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in shortfalls" :key="s.productId + s.warehouseId">
              <td>{{ s.productName }}</td>
              <td>{{ s.warehouseName }}</td>
              <td class="text-end">{{ s.requested }}</td>
              <td class="text-end">{{ s.available }}</td>
              <td class="text-end text-error font-weight-bold">{{ s.deficit }}</td>
            </tr>
          </tbody>
        </v-table>

        <!-- Transfer proposals -->
        <p class="text-subtitle-2 mb-2">{{ $t('invoicing.autoTransfer') }}:</p>
        <div v-for="p in proposals" :key="p.productId" class="mb-3 pa-3 border rounded">
          <div class="font-weight-medium mb-1">{{ p.productName }} → {{ p.toWarehouseName }}</div>
          <div v-for="src in p.sources" :key="src.fromWarehouseId" class="d-flex justify-space-between text-body-2">
            <span>{{ src.fromWarehouseName }} (available: {{ src.available }})</span>
            <span class="font-weight-bold">Transfer: {{ src.transferQuantity }}</span>
          </div>
          <v-alert v-if="p.deficit > 0" type="error" variant="tonal" density="compact" class="mt-2">
            Still short by {{ p.deficit }} units — total stock across all warehouses is insufficient
          </v-alert>
        </div>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn v-if="allResolvable" color="primary" :loading="confirming" @click="$emit('confirm', proposals)">
          {{ $t('common.confirm') }} &amp; {{ $t('invoicing.send') || 'Send' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: boolean
  shortfalls: any[]
  proposals: any[]
  allResolvable: boolean
  confirming?: boolean
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
  'confirm': [proposals: any[]]
}>()
</script>
