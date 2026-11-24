<template>
  <!-- Convert-to-invoices dialog -->
  <v-dialog v-model="open" max-width="560">
    <v-card>
      <v-card-title>{{ $t('invoicing.convertToInvoices') }}</v-card-title>
      <v-card-text>
        <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('invoicing.orderConvertHint') }}</p>
        <v-list density="compact">
          <v-list-item v-for="c in convertibleClients" :key="c.contactId">
            <v-list-item-title>{{ c.name }}</v-list-item-title>
            <v-list-item-subtitle>{{ $t('invoicing.openReservedQty') }}: {{ c.open }}</v-list-item-subtitle>
            <template #append>
              <v-btn size="small" color="primary" variant="flat" :loading="convertingId === c.contactId" @click="convertFor(c.contactId)">
                {{ $t('invoicing.convertToInvoice') }}
              </v-btn>
            </template>
          </v-list-item>
          <v-list-item v-if="!convertibleClients.length">
            <v-list-item-title class="text-medium-emphasis">{{ $t('invoicing.noOpenReservations') }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * A supplier order's Convert: one sales invoice per client, of what is reserved for that client and not invoiced yet.
 * Moved out of `OrderFormView` (FR-32.23); the request and what it says are the ones the form made.
 */
import { computed, ref } from 'vue'
import { convertOrderFor } from '../../api/orders'
import { useConversionFeedback } from '../../composables/useConversionFeedback'

const props = defineProps<{
  /** The order's reservations, as its GET returns them. */
  reservations: any[]
  contactNames: Record<string, string>
  /** The supplier order. */
  orderId: string
  /** The form's reload after a conversion. */
  reload: () => Promise<void>
}>()
const open = defineModel<boolean>({ required: true })
const conversion = useConversionFeedback()

const convertingId = ref('')
const convertibleClients = computed(() => {
  const byClient = new Map<string, number>()
  for (const r of props.reservations) {
    if (r.status !== 'active') continue
    const left = (Number(r.quantity) || 0) - (Number(r.invoicedQuantity) || 0)
    if (r.contactId && left > 0) byClient.set(String(r.contactId), (byClient.get(String(r.contactId)) || 0) + left)
  }
  return [...byClient.entries()].map(([contactId, left]) => ({
    contactId,
    open: left,
    name: props.contactNames[contactId] || contactId,
  }))
})

async function convertFor(contactId: string) {
  convertingId.value = contactId
  try {
    conversion.converted(await convertOrderFor(props.orderId, { contactId }))
    await props.reload()
  } catch (e: any) {
    conversion.failed(e)
  } finally {
    convertingId.value = ''
  }
}
</script>
