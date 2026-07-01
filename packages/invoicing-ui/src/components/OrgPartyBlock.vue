<template>
  <div class="org-party-block">
    <div class="text-h6 font-weight-bold mb-1">{{ org?.name || '—' }}</div>
    <div v-if="taxLabel" class="text-body-2 text-medium-emphasis">{{ taxLabel }}</div>
    <div v-if="primaryAddress" class="mt-2">
      <div class="text-caption text-medium-emphasis">{{ $t('invoicing.address') }}</div>
      <div class="text-body-1">{{ primaryAddress.street }}</div>
      <div class="text-body-1">{{ primaryAddress.postalCode }} {{ primaryAddress.city }}</div>
      <div class="text-body-1">{{ primaryAddress.country }}</div>
    </div>
    <div v-else class="text-body-2 text-medium-emphasis mt-2">
      {{ $t('invoicing.noOrgAddress') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Organization } from '../store/app.store'

const props = defineProps<{
  org: Organization | null
}>()

const primaryAddress = computed(() => {
  const list = props.org?.addresses || []
  return list.find(a => a.isDefault) || list[0] || null
})

const taxLabel = computed(() => {
  const parts: string[] = []
  if (props.org?.taxNumber) parts.push(`Tax ID: ${props.org.taxNumber}`)
  if (props.org?.vatNumber) parts.push(`VAT: ${props.org.vatNumber}`)
  return parts.join(' · ')
})
</script>
