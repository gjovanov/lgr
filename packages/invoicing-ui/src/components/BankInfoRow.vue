<template>
  <div v-if="bank" class="bank-info-row d-flex flex-wrap ga-4 text-caption text-medium-emphasis">
    <span><strong>{{ $t('invoicing.bankName') }}:</strong> {{ bank.bankName }}</span>
    <span v-if="bank.swift"><strong>BIC:</strong> {{ bank.swift }}</span>
    <span v-if="bank.iban"><strong>IBAN:</strong> {{ bank.iban }}</span>
    <span v-else-if="bank.accountNumber"><strong>{{ $t('invoicing.accountNumber') }}:</strong> {{ bank.accountNumber }}</span>
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

const bank = computed(() => {
  const list = props.org?.bankDetails || []
  return list.find(b => b.isDefault) || list[0] || null
})
</script>
