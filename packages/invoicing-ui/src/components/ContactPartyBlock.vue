<template>
  <div class="contact-party-block">
    <div class="text-h6 font-weight-bold mb-1">{{ contact?.companyName || displayName || '—' }}</div>
    <div v-if="taxLabel" class="text-body-2 text-medium-emphasis">{{ taxLabel }}</div>
    <div v-if="address" class="mt-2">
      <div class="text-caption text-medium-emphasis">{{ $t('invoicing.address') }}</div>
      <div class="text-body-1">{{ address.street || '—' }}</div>
      <div class="text-body-1">{{ address.postalCode }} {{ address.city }}</div>
      <div class="text-body-1">{{ address.country }}</div>
    </div>
    <div v-else class="text-body-2 text-medium-emphasis mt-2">
      {{ $t('invoicing.noContactAddress') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Address {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

interface Contact {
  companyName?: string
  firstName?: string
  lastName?: string
  taxNumber?: string
  vatNumber?: string
  taxId?: string
  addresses?: Array<{ type?: string; street: string; city: string; state?: string; postalCode: string; country: string; isDefault?: boolean }>
}

const props = defineProps<{
  /** Optional contact whose addresses we display. When provided, takes precedence. */
  contact?: Contact | null
  /** Fallback address (e.g., the form's `billingAddress`) used when contact is not set
   * or doesn't have any addresses on file. */
  address?: Address | null
  /** Override display name when contact is null (rare — used for one-off freeform billing). */
  displayName?: string
}>()

const address = computed<Address | null>(() => {
  if (props.contact?.addresses?.length) {
    const list = props.contact.addresses
    return list.find(a => a.isDefault) || list.find(a => a.type === 'billing') || list[0] || null
  }
  if (props.address && (props.address.street || props.address.city || props.address.country)) {
    return props.address
  }
  return null
})

const taxLabel = computed(() => {
  if (!props.contact) return ''
  const parts: string[] = []
  if (props.contact.taxNumber) parts.push(`Tax ID: ${props.contact.taxNumber}`)
  if (props.contact.vatNumber) parts.push(`VAT: ${props.contact.vatNumber}`)
  return parts.join(' · ')
})
</script>
