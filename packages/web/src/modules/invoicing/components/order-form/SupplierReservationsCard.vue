<template>
  <!-- Linked reservations (first-class RES- documents). The tree above shows them under their warehouse, so
       this flat list, which also holds the cancelled ones (and „reserve again"), starts closed (D-6). -->
  <CollapsiblePanel screen="orders.edit" panel-id="reservations" :default-open="false" :summary="reservationsSummary" class="mt-4" data-testid="order-reservations">
    <template #title>
      <v-icon size="20" color="primary">mdi-lock-clock</v-icon>
      {{ $t('nav.reservations') }}
      <v-chip size="x-small" variant="tonal">{{ activeReservations.length }}</v-chip>
      <v-chip v-if="hasStaged" size="x-small" variant="tonal" color="warning">{{ $t('invoicing.reservations.unsaved') }}</v-chip>
    </template>
    <v-card-text class="pa-2">
      <div v-if="!reservations.length" class="text-medium-emphasis text-body-2 pa-2">
        {{ $t('invoicing.noReservationsYet') }}
      </div>
      <div v-else style="overflow-x: auto">
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ $t('invoicing.reservationNumber') }}</th>
              <th>{{ $t('invoicing.product') }}</th>
              <th>{{ $t('invoicing.customer') }}</th>
              <th>{{ $t('invoicing.internalOrder') }}</th>
              <th>{{ $t('warehouse.warehouse') }}</th>
              <th class="text-end">{{ $t('invoicing.qty') }}</th>
              <th class="text-end">{{ $t('invoicing.invoicedQty') }}</th>
              <th class="text-end">{{ $t('invoicing.dispatchedQty') }}</th>
              <th>{{ $t('common.status') }}</th>
              <th style="width: 40px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="res in reservations" :key="res._id">
              <td class="text-no-wrap">
                <router-link :to="{ name: 'invoicing.reservations.detail', params: { id: String(res._id) } }">{{ res.reservationNumber }}</router-link>
              </td>
              <td>{{ lineDescription(res.allocationId) }}</td>
              <td>{{ contactNames[res.contactId] || '—' }}</td>
              <td class="text-no-wrap">
                <router-link v-if="res.internalOrderId" :to="{ name: 'invoicing.internalOrders.edit', params: { id: res.internalOrderId }, query: internalOrderLineQuery(res) }">
                  {{ internalOrderNumbers[res.internalOrderId] || '…' }}
                </router-link>
                <span v-else>—</span>
              </td>
              <td>{{ warehouseName(res.warehouseId) }}</td>
              <td class="text-end">{{ res.quantity }}</td>
              <td class="text-end">{{ res.invoicedQuantity || 0 }}</td>
              <td class="text-end">{{ res.dispatchedQuantity || 0 }}</td>
              <td>
                <v-chip size="x-small" label variant="tonal" :color="resStatusColor(res.status)">
                  {{ $t(`invoicing.status.${res.status}`) }}
                </v-chip>
              </td>
              <td class="text-no-wrap">
                <v-btn
                  v-if="res.status === 'active' && !readonly"
                  :icon="cancels.includes(res._id) ? 'mdi-undo' : 'mdi-close'"
                  size="x-small"
                  variant="text"
                  :color="cancels.includes(res._id) ? undefined : 'error'"
                  :title="cancels.includes(res._id) ? $t('invoicing.reservations.keep') : $t('invoicing.cancelReservation')"
                  :aria-label="cancels.includes(res._id) ? $t('invoicing.reservations.keep') : $t('invoicing.cancelReservation')"
                  @click="emit('toggleCancel', res._id)"
                />
                <!-- #203: a cancelled reservation, made again — staged like the rest, saved with the order. -->
                <v-btn
                  v-if="res.status === 'cancelled' && !readonly && !stagedRepeat(res._id)"
                  icon="mdi-restore"
                  size="x-small"
                  variant="text"
                  color="primary"
                  :title="$t('invoicing.reservations.reserveAgain')"
                  :aria-label="$t('invoicing.reservations.reserveAgain')"
                  @click="emit('stageRepeat', res)"
                />
              </td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </v-card-text>
  </CollapsiblePanel>
</template>

<script setup lang="ts">
/**
 * The supplier order's Reservations card: every reservation on the order, the cancelled ones too, with cancel on save
 * and „reserve again", both staged (#203). Moved out of `OrderFormView` (FR-32.23).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import { internalOrderLineQuery } from '../../composables/order-tree/links'
import { resStatusColor } from '../../composables/order-form/shared'

const props = defineProps<{
  reservations: any[]
  /** Reservations staged to be cancelled on save, by id. */
  cancels: string[]
  hasStaged: boolean
  readonly: boolean
  contactNames: Record<string, string>
  internalOrderNumbers: Record<string, string>
  warehouseName: (id: string) => string
  /** The description of the line an allocation is on. */
  lineDescription: (allocationId: string) => string
  stagedRepeat: (resId: string) => boolean
}>()
const emit = defineEmits<{ toggleCancel: [resId: string]; stageRepeat: [res: any] }>()
const { t } = useI18n()

const activeReservations = computed(() => props.reservations.filter((r) => r.status !== 'cancelled'))
/** The card, folded (FR-28.43): how many hold stock, for how many clients. */
const reservationsSummary = computed(() => {
  const clients = new Set(activeReservations.value.map((r) => String(r.contactId || '')).filter(Boolean))
  return [t('invoicing.panels.reservationsCount', activeReservations.value.length), t('invoicing.panels.clients', clients.size)].join(' · ')
})
</script>
