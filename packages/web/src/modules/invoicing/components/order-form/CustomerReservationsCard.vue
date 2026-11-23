<template>
  <!-- Coverage toolbox + linked reservations. The order-wide buttons stay on the header, folded or
       not: they act on the whole order, not on what the panel shows. -->
  <CollapsiblePanel screen="internal-orders.edit" panel-id="reservations" :default-open="false" :summary="$t('invoicing.panels.reservationsCount', activeReservations.length)" class="mt-4" data-testid="internal-order-reservations">
    <template #title>
      <v-icon size="20" color="primary">mdi-lock-clock</v-icon>
      {{ $t('nav.reservations') }}
      <v-chip size="x-small" variant="tonal">{{ activeReservations.length }}</v-chip>
    </template>
    <template #actions>
      <template v-if="canReserve">
        <v-btn size="small" variant="outlined" color="primary" prepend-icon="mdi-warehouse" :loading="reserving" @click="emit('reserveAvailable')">
          {{ $t('invoicing.reserveAvailable') }}
        </v-btn>
        <v-btn size="small" variant="outlined" color="warning" prepend-icon="mdi-shield-search" @click="emit('cover')">
          {{ $t('invoicing.coverShortages') }}
        </v-btn>
        <v-btn size="small" variant="outlined" prepend-icon="mdi-factory" @click="emit('generate')">
          {{ $t('invoicing.generateExternalOrder') }}
        </v-btn>
      </template>
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
              <th>{{ $t('invoicing.source') }}</th>
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
              <td class="text-no-wrap"><EntityLink :label="res.reservationNumber" :to="{ name: 'invoicing.reservations.detail', params: { id: String(res._id) } }" /></td>
              <td>{{ lineDescription(res) }}</td>
              <td>
                <v-chip
                  v-if="res.source === 'order'"
                  size="x-small"
                  variant="tonal"
                  color="info"
                  :to="orderLink(res)"
                >
                  {{ orderNumbers[String(res.orderId)] || 'ORDO' }}
                </v-chip>
                <v-chip v-else size="x-small" variant="tonal">{{ $t('invoicing.sourceStock') }}</v-chip>
                <v-icon v-if="isLate(res)" size="14" color="error" class="ml-1" :title="$t('invoicing.lateDelivery')">mdi-clock-alert-outline</v-icon>
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
              <td>
                <v-btn
                  v-if="res.status === 'active' && !readonly"
                  icon="mdi-close"
                  size="x-small"
                  variant="text"
                  color="error"
                  :title="$t('invoicing.reservations.release')"
                  :aria-label="$t('invoicing.reservations.release')"
                  @click="emit('release', res)"
                />
                <v-btn
                  v-if="res.status === 'cancelled' && canReserve"
                  icon="mdi-restore"
                  size="x-small"
                  variant="text"
                  color="primary"
                  :loading="repeating === res._id"
                  :title="$t('invoicing.reservations.reserveAgain')"
                  :aria-label="$t('invoicing.reservations.reserveAgain')"
                  @click="emit('reserveAgain', res)"
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
 * The customer order's Reservations card: the coverage toolbox (reserve what is free, cover the shortages, a supplier
 * order for them) and every reservation of the order, each released or made again AT ONCE. Moved out of
 * `InternalOrderFormView` (FR-32.23).
 */
import { computed } from 'vue'
import EntityLink from 'ui-shared/components/EntityLink'
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import { resStatusColor } from '../../composables/order-form/shared'
import { orderLink } from '../../composables/order-form/customer-order'

const props = defineProps<{
  reservations: any[]
  readonly: boolean
  /** The order is confirmed (or partly delivered): stock can be reserved for it. */
  canReserve: boolean
  /** Reserve available is running. */
  reserving: boolean
  /** The reservation being made again, by id. */
  repeating: string
  orderNumbers: Record<string, string>
  warehouseName: (id: string) => string
  /** The description of the order's line a reservation serves. */
  lineDescription: (res: any) => string
  isLate: (res: any) => boolean
}>()
const emit = defineEmits<{ reserveAvailable: []; cover: []; generate: []; release: [res: any]; reserveAgain: [res: any] }>()

const activeReservations = computed(() => props.reservations.filter((r) => r.status !== 'cancelled'))
</script>
