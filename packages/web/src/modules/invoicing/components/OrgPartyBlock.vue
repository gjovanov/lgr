<template>
  <div class="org-party-block">
    <div class="text-h6 font-weight-bold mb-1">{{ org?.name || '—' }}</div>
    <!-- FR-25a: the company's МОЛ, under its name, as the printed form carries it in its block. -->
    <div v-if="representative" class="text-body-2" data-testid="org-party-representative">{{ $t('invoicing.partyRepresentative') }}: {{ representative }}</div>
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
import { useI18n } from 'vue-i18n'
import { representativeOf } from 'config/party-identity'
import type { Organization } from '../store/app.store'

const props = defineProps<{
  org: Organization | null
}>()

const primaryAddress = computed(() => {
  const list = props.org?.addresses || []
  return list.find(a => a.isDefault) || list[0] || null
})

const representative = computed(() => representativeOf(props.org))

const { t } = useI18n()

// Labelled as on the printed invoice (ЕИК / ИН по ДДС).
const taxLabel = computed(() => {
  const parts: string[] = []
  if (props.org?.taxNumber) parts.push(`${t('invoicing.partyTaxId')}: ${props.org.taxNumber}`)
  if (props.org?.vatNumber) parts.push(`${t('invoicing.partyVatId')}: ${props.org.vatNumber}`)
  return parts.join(' · ')
})
</script>
