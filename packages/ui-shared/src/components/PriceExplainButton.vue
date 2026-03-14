<template>
  <v-btn
    v-if="steps && steps.length > 0"
    icon
    size="x-small"
    variant="text"
    color="info"
    @click="dialog = true"
  >
    <v-icon size="16">mdi-information-outline</v-icon>
    <v-tooltip activator="parent" location="top">{{ $t('pricing.explainPrice') || 'Explain price' }}</v-tooltip>
  </v-btn>

  <v-dialog v-model="dialog" max-width="420">
    <v-card>
      <v-card-title class="text-h6">
        {{ $t('pricing.priceBreakdown') || 'Price Breakdown' }}
      </v-card-title>
      <v-card-text>
        <v-list density="compact">
          <v-list-item
            v-for="(step, idx) in steps"
            :key="idx"
            :class="{ 'bg-blue-lighten-5': idx === steps.length - 1 }"
          >
            <template #prepend>
              <v-icon
                :color="stepColor(step.type)"
                size="18"
                class="mr-2"
              >
                {{ stepIcon(step.type) }}
              </v-icon>
            </template>
            <v-list-item-title class="d-flex justify-space-between align-center">
              <span>{{ step.label }}</span>
              <span class="font-weight-medium">{{ formatPrice(step.price) }}</span>
            </v-list-item-title>
            <template v-if="idx < steps.length - 1" #append>
              <v-icon size="14" color="grey">mdi-arrow-down</v-icon>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="dialog = false">{{ $t('common.close') || 'Close' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface PriceStep {
  type: 'base' | 'tag' | 'contact' | 'override'
  label: string
  price: number
}

defineProps<{
  steps: PriceStep[]
  currency?: string
}>()

const dialog = ref(false)

function stepIcon(type: string): string {
  switch (type) {
    case 'base': return 'mdi-tag-outline'
    case 'tag': return 'mdi-label-outline'
    case 'contact': return 'mdi-account-outline'
    case 'override': return 'mdi-pencil-outline'
    default: return 'mdi-circle-small'
  }
}

function stepColor(type: string): string {
  switch (type) {
    case 'base': return 'grey'
    case 'tag': return 'primary'
    case 'contact': return 'success'
    case 'override': return 'warning'
    default: return 'grey'
  }
}

function formatPrice(price: number): string {
  return price.toFixed(2)
}
</script>
