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
import { useI18n } from 'vue-i18n'

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

// '-' is the legacy "unknown" placeholder — treat it as empty so it never renders as an address.
const val = (v?: string) => (v && v !== '-' ? v : '')

const address = computed<Address | null>(() => {
  if (props.contact?.addresses?.length) {
    const list = props.contact.addresses
    return list.find(a => a.isDefault) || list.find(a => a.type === 'billing') || list[0] || null
  }
  if (props.address && (val(props.address.street) || val(props.address.city))) {
    return {
      street: val(props.address.street),
      city: val(props.address.city),
      state: val(props.address.state),
      postalCode: val(props.address.postalCode),
      country: val(props.address.country),
    }
  }
  return null
})

const { t } = useI18n()

// Labelled as on the printed invoice (ЕИК / ИН по ДДС). The registration number lives in
// `taxNumber` for contacts made in the form and in `taxId` for imported ones — the print
// reads `taxId`, so fall back to it rather than show nothing.
const taxLabel = computed(() => {
  if (!props.contact) return ''
  const parts: string[] = []
  const reg = props.contact.taxNumber || props.contact.taxId
  if (reg) parts.push(`${t('invoicing.partyTaxId')}: ${reg}`)
  if (props.contact.vatNumber) parts.push(`${t('invoicing.partyVatId')}: ${props.contact.vatNumber}`)
  return parts.join(' · ')
})
</script>
