<template>
  <!-- Reserve-for-client dialog: changes the client (and the quantity) of a reservation on an allocation -->
  <v-dialog v-model="state.open" max-width="480">
    <v-card>
      <v-card-title>{{ $t('invoicing.reservations.changeClient') }}</v-card-title>
      <v-card-text>
        <div class="text-body-2 text-medium-emphasis mb-3">
          {{ state.description }} · {{ warehouseName(state.warehouseId) }} ·
          {{ $t('invoicing.freeQty') }}: {{ state.free }}
        </div>
        <div class="d-flex align-center ga-1 mb-3">
          <v-autocomplete
            v-model="state.contactId"
            :items="clientOptions"
            item-title="companyName"
            item-value="_id"
            :label="$t('invoicing.customer')"
            density="compact"
            variant="outlined"
            no-filter
            hide-details
            class="flex-grow-1"
            :loading="loadingContacts"
            @update:search="(s: string) => emit('search', s)"
          />
          <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.searchContact')" :aria-label="$t('invoicing.searchContact')" @click="emit('find')" />
        </div>
        <v-text-field
          v-model.number="state.quantity"
          type="number"
          min="0"
          :max="state.free"
          :label="$t('invoicing.qty')"
          density="compact"
          variant="outlined"
          hide-details
        />
        <div class="text-caption text-medium-emphasis mt-2">{{ $t('invoicing.reservations.savedWithOrder') }}</div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="state.open = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!state.contactId || !(state.quantity > 0) || state.quantity > state.free"
          @click="emit('submit')"
        >
          {{ $t('invoicing.reserve') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * The supplier order's "change client" dialog (#203): it stages; nothing is posted until the order is saved. Its state
 * is the form's (`useStagedReservations#reserveDialog`), since the wide contact picker fills its client too.
 * Moved out of `OrderFormView` (FR-32.23).
 */
import type { ClientChangeState } from '../../composables/order-form/useStagedReservations'

defineProps<{
  state: ClientChangeState
  clientOptions: any[]
  loadingContacts: boolean
  warehouseName: (id: string) => string
}>()
const emit = defineEmits<{
  /** Text typed in the client field: the form searches its client pool. */
  search: [text: string]
  /** The wide contact picker, for this dialog's client. */
  find: []
  submit: []
}>()
</script>
