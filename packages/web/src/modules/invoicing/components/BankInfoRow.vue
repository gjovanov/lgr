<template>
  <div v-if="banks.length" class="d-flex flex-column ga-1">
    <div
      v-for="(bank, i) in banks"
      :key="i"
      class="bank-info-row d-flex flex-wrap ga-4 text-caption text-medium-emphasis"
    >
      <span><strong>{{ $t('invoicing.bankName') }}:</strong> {{ bank.bankName }}</span>
      <span v-if="bank.swift"><strong>BIC:</strong> {{ bank.swift }}</span>
      <span v-if="bank.iban"><strong>IBAN:</strong> {{ bank.iban }}</span>
      <span v-else-if="bank.accountNumber"><strong>{{ $t('invoicing.accountNumber') }}:</strong> {{ bank.accountNumber }}</span>
    </div>
  </div>
  <div v-else class="text-caption text-medium-emphasis">
    {{ $t('invoicing.noOrgBank') }}
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Organization } from '../store/app.store'

const props = defineProps<{
  org: Organization | null
}>()

// All org bank accounts (default first), capped at 5.
const banks = computed(() => {
  const list = [...(props.org?.bankDetails || [])]
  list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return list.slice(0, 5)
})
</script>
