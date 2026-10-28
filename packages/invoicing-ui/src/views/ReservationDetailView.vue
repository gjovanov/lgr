<template>
  <EntityFormShell
    :title="$t('invoicing.reservations.title')"
    :subtitle="res?.reservationNumber || ''"
    :status="statusDef"
    :actions="formActions"
    :loading="loading"
    back-to="/reservations"
    :back-label="$t('nav.reservations')"
    :entity-id="res?._id"
  >
    <template #document-header>
      <div class="d-flex align-center justify-space-between px-4 py-3 ga-4 flex-wrap">
        <div class="d-flex align-center ga-3">
          <v-avatar size="36" color="primary" variant="tonal">
            <v-icon size="20">mdi-lock-clock</v-icon>
          </v-avatar>
          <div>
            <div class="text-overline text-medium-emphasis">{{ appStore.currentOrg?.name || '—' }}</div>
            <div class="text-subtitle-1 font-weight-bold">{{ $t('invoicing.reservations.title') }}</div>
          </div>
        </div>
        <div class="text-end">
          <div class="text-h6 font-weight-bold" data-testid="reservation-number">{{ res?.reservationNumber || '—' }}</div>
          <div v-if="res" class="d-flex ga-1 justify-end mt-1">
            <v-chip size="x-small" label variant="tonal" :color="statusColor(res.status)">{{ $t(`invoicing.status.${res.status}`) }}</v-chip>
          </div>
        </div>
      </div>
    </template>

    <div v-if="notFound" class="text-medium-emphasis pa-4">{{ $t('common.noData') }}</div>
    <template v-else-if="res">
      <v-row dense>
        <!-- Who, what, how much -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" rounded="lg" class="h-100">
            <v-card-text>
              <div class="text-caption text-medium-emphasis">{{ $t('invoicing.customer') }}</div>
              <div class="text-body-1 mb-3">
                <EntityLink :label="res.contactName || '—'" :to="{ name: 'invoicing.contacts.edit', params: { id: String(res.contactId) } }" />
              </div>
              <div class="text-caption text-medium-emphasis">{{ $t('invoicing.product') }}</div>
              <div class="text-body-1 mb-3">
                <EntityLink v-if="res.productId" :label="res.productName || '—'" :href="appHref('inventory', `/inventory/products/${res.productId}/stock`)" />
                <span v-else>—</span>
                <span v-if="res.productSku" class="text-caption text-medium-emphasis ms-2">{{ res.productSku }}</span>
              </div>
              <div class="d-flex flex-wrap ga-4">
                <div>
                  <div class="text-caption text-medium-emphasis">{{ $t('invoicing.qty') }}</div>
                  <div class="text-h6" data-testid="reservation-quantity">{{ res.quantity }} <span class="text-body-2">{{ unitLabel(res.productUnit) }}</span></div>
                </div>
                <div>
                  <div class="text-caption text-medium-emphasis">{{ $t('invoicing.invoicedQty') }}</div>
                  <div class="text-h6">{{ res.invoicedQuantity || 0 }}</div>
                </div>
                <div>
                  <div class="text-caption text-medium-emphasis">{{ $t('invoicing.dispatchedQty') }}</div>
                  <div class="text-h6">{{ res.dispatchedQuantity || 0 }}</div>
                </div>
                <div v-if="res.status !== 'cancelled'">
                  <div class="text-caption text-medium-emphasis">{{ $t('invoicing.releasableQty') }}</div>
                  <div class="text-h6">{{ res.releasable || 0 }}</div>
                </div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- Where the goods come from -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" rounded="lg" class="h-100">
            <v-card-text>
              <div class="text-caption text-medium-emphasis">{{ $t('invoicing.source') }}</div>
              <template v-if="res.source === 'order'">
                <div class="d-flex align-center flex-wrap ga-2 text-body-1">
                  <v-icon size="18">mdi-truck-outline</v-icon>
                  <EntityLink
                    v-if="detail?.order"
                    :label="detail.order.orderNumber"
                    :to="{ name: 'invoicing.orders.edit', params: { id: detail.order._id } }"
                  />
                  <span v-else>{{ res.orderNumber || '—' }}</span>
                  <v-chip v-if="detail?.order" size="x-small" label variant="tonal">{{ $t(`invoicing.status.${detail.order.status}`) }}</v-chip>
                </div>
                <div class="text-body-2 text-medium-emphasis mt-1">
                  {{ $t('invoicing.reservations.fromOutgoingOrder') }}<template v-if="detail?.order?.supplierName"> · {{ detail.order.supplierName }}</template>
                  <template v-if="detail?.order?.expectedDate"> · {{ $t('invoicing.expectedDate') }} {{ fmtDate(detail.order.expectedDate) }}</template>
                </div>
                <div v-if="detail?.allocation" class="text-body-2 mt-2">
                  {{ $t('invoicing.reservations.allocationFigures', { warehouse: detail.allocation.warehouseName || res.warehouseName, quantity: detail.allocation.quantity, received: detail.allocation.receivedQuantity }) }}
                </div>
                <div v-else class="text-body-2 text-warning mt-2">{{ $t('invoicing.reservations.allocationGone') }}</div>
              </template>
              <template v-else>
                <div class="d-flex align-center ga-2 text-body-1">
                  <v-icon size="18">mdi-warehouse</v-icon>
                  <span>{{ $t('invoicing.sourceStock') }}: {{ res.warehouseName || '—' }}</span>
                </div>
              </template>
              <div v-if="res.expectedDate || res.requestedDeliveryDate" class="text-body-2 mt-3">
                <div v-if="res.requestedDeliveryDate">{{ $t('invoicing.requestedDeliveryDate') }}: {{ fmtDate(res.requestedDeliveryDate) }}</div>
                <div v-if="res.late" class="text-error">
                  <v-icon size="14" color="error">mdi-clock-alert-outline</v-icon> {{ $t('invoicing.lateDelivery') }}
                </div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- The client order it serves -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" rounded="lg" class="h-100">
            <v-card-text>
              <div class="text-caption text-medium-emphasis">{{ $t('invoicing.internalOrder') }}</div>
              <template v-if="res.internalOrderId">
                <div class="d-flex align-center flex-wrap ga-2 text-body-1">
                  <EntityLink
                    :label="detail?.internalOrder?.orderNumber || res.internalOrderNumber || '…'"
                    :to="{ name: 'invoicing.internalOrders.edit', params: { id: String(res.internalOrderId) } }"
                  />
                  <v-chip v-if="detail?.internalOrder" size="x-small" label variant="tonal">{{ $t(`invoicing.status.${detail.internalOrder.status}`) }}</v-chip>
                  <v-chip v-if="detail?.internalOrder?.priority && detail.internalOrder.priority !== 'normal'" size="x-small" label variant="tonal" color="warning">
                    {{ $t(`invoicing.priority.${detail.internalOrder.priority}`) }}
                  </v-chip>
                </div>
                <div v-if="detail?.internalOrderLine" class="text-body-2 mt-2">
                  <div>{{ detail.internalOrderLine.description }}</div>
                  <div class="text-medium-emphasis">
                    {{ $t('invoicing.reservations.lineFigures', { quantity: detail.internalOrderLine.quantity, reserved: detail.internalOrderLine.reservedQuantity, delivered: detail.internalOrderLine.deliveredQuantity }) }}
                  </div>
                </div>
              </template>
              <div v-else class="text-body-2 text-medium-emphasis">{{ $t('invoicing.reservations.notForOrder') }}</div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- The invoices that take it -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" rounded="lg" class="h-100">
            <v-card-text>
              <div class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.invoices') }}</div>
              <v-table v-if="detail?.invoices?.length" density="compact" data-testid="reservation-invoices">
                <tbody>
                  <tr v-for="inv in detail.invoices" :key="inv._id">
                    <td class="text-no-wrap"><EntityLink :label="inv.invoiceNumber" :to="{ name: 'invoicing.sales.edit', params: { id: inv._id } }" /></td>
                    <td class="text-no-wrap">{{ fmtDate(inv.issueDate) }}</td>
                    <td><v-chip size="x-small" label variant="tonal">{{ $t(`invoicing.status.${inv.status}`) }}</v-chip></td>
                    <td class="text-end text-no-wrap">{{ inv.quantity }} {{ unitLabel(res.productUnit) }}</td>
                  </tr>
                </tbody>
              </v-table>
              <div v-else class="text-body-2 text-medium-emphasis">{{ $t('invoicing.reservations.notInvoiced') }}</div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- What happened to it -->
        <v-col cols="12">
          <v-card variant="outlined" rounded="lg">
            <v-card-text>
              <div class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.reservations.historyTitle') }}</div>
              <v-timeline density="compact" side="end" truncate-line="both" data-testid="reservation-history">
                <v-timeline-item v-for="(h, i) in history" :key="i" :dot-color="toneColor(h.tone)" size="x-small">
                  <div class="text-body-2">{{ $t(h.key, h.params) }}</div>
                  <div class="text-caption text-medium-emphasis">
                    {{ fmtDateTime(h.at) }}<template v-if="h.by && detail?.users?.[h.by]"> · {{ detail.users[h.by] }}</template>
                  </div>
                </v-timeline-item>
              </v-timeline>
              <template v-if="links.length">
                <div class="text-caption text-medium-emphasis mt-2 mb-1">{{ $t('invoicing.reservations.linked') }}</div>
                <div v-for="l in links" :key="`${l.label}-${l.id}`" class="d-flex align-center flex-wrap ga-2 text-body-2" data-testid="reservation-link">
                  <span class="text-medium-emphasis">{{ l.label }}:</span>
                  <EntityLink :label="l.number" :to="{ name: 'invoicing.reservations.detail', params: { id: l.id } }" />
                  <v-chip size="x-small" label variant="tonal" :color="statusColor(l.status)">{{ $t(`invoicing.status.${l.status}`) }}</v-chip>
                  <span v-if="l.extra" class="text-medium-emphasis">{{ l.extra }}</span>
                </div>
              </template>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </template>

    <template #sidebar>
      <EntityNotesPanel :org-url="appStore.orgUrl()" entity-type="reservation" :entity-id="res?._id" />
    </template>

    <ReservationQuantityDialog
      v-model="editDialog"
      :reservation="res"
      :subtitle="res ? `${res.productName || ''} · ${res.contactName || ''}` : ''"
      @saved="load"
    />
    <ReservationReleaseDialog
      v-model="releaseDialog"
      :reservation="res"
      :subtitle="res ? `${res.productName || ''} · ${res.contactName || ''}` : ''"
      on-page
      @released="load"
    />
    <ReservationCreateDialog v-model="againDialog" :repeat="res" :repeat-error="repeatError" @created="onRepeated" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { appHref } from 'ui-shared/nav/navigate'
import EntityFormShell, { type FormAction, type StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import { useAppStore } from '../store/app.store'
import ReservationQuantityDialog from '../components/ReservationQuantityDialog.vue'
import ReservationReleaseDialog from '../components/ReservationReleaseDialog.vue'
import ReservationCreateDialog from '../components/ReservationCreateDialog.vue'
import { reservationHistory, type HistoryTone } from '../composables/reservation-history'
import { isShortage, reservationErrorMessage } from '../composables/reservation-errors'

/**
 * FR-22.37: a reservation's own page — `/reservations/:id`. Who it is for, what and how much, where
 * the goods come from, the client order it serves, the invoices that take it, and what happened to
 * it. Every number is a link; a page in another app (the product) is reached through `appHref`.
 * Its actions are the list's: change the quantity, release it (or part of it), reserve it again.
 */
const route = useRoute()
const router = useRouter()
const { t, te, locale } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const unitLabel = (u?: string) => (u && te(`warehouse.uomShort.${u}`) ? t(`warehouse.uomShort.${u}`) : u || '')

const res = ref<any>(null)
const detail = ref<any>(null)
const loading = ref(false)
const notFound = ref(false)
const editDialog = ref(false)
const releaseDialog = ref(false)
const againDialog = ref(false)
const repeatError = ref('')
const repeating = ref(false)

const localeCode = computed(() => (({ en: 'en-GB', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[String(locale.value)] || 'en-GB'))
function fmtDate(d: string | Date | null | undefined) {
  if (!d) return ''
  const date = new Date(d)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(localeCode.value)
}
function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return ''
  const date = new Date(d)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(localeCode.value)
}
function statusColor(s: string) {
  return ({ active: 'primary', fulfilled: 'success', cancelled: 'error' } as Record<string, string>)[s] || 'grey'
}
function toneColor(tone: HistoryTone) {
  return ({ created: 'primary', changed: 'info', released: 'warning', cancelled: 'error', fulfilled: 'success', other: 'grey' } as Record<HistoryTone, string>)[tone]
}

const statusDef = computed<StatusDef | undefined>(() => {
  if (!res.value) return undefined
  if (res.value.status === 'cancelled') {
    return { steps: ['invoicing.status.active', 'invoicing.status.cancelled'], current: 'invoicing.status.cancelled', colors: { 'invoicing.status.cancelled': 'error' } }
  }
  return { steps: ['invoicing.status.active', 'invoicing.status.fulfilled'], current: `invoicing.status.${res.value.status}` }
})

const history = computed(() => reservationHistory(res.value?.statusHistory, {
  repeatOfNumber: detail.value?.repeatOf?.reservationNumber,
  cancelReason: res.value?.cancelReason,
}))

/** The reservations this one is linked to: what it repeats, what repeats it, what a preemption moved. */
const links = computed(() => {
  const d = detail.value
  if (!d) return []
  const out: Array<{ label: string; id: string; number: string; status: string; extra?: string }> = []
  if (d.repeatOf) out.push({ label: t('invoicing.reservations.repeatsLabel'), id: d.repeatOf._id, number: d.repeatOf.reservationNumber, status: d.repeatOf.status })
  if (d.repeatedAs) out.push({ label: t('invoicing.reservations.repeatedAsLabel'), id: d.repeatedAs._id, number: d.repeatedAs.reservationNumber, status: d.repeatedAs.status })
  if (d.preemptedFrom) out.push({ label: t('invoicing.reservations.takenFromLabel'), id: d.preemptedFrom._id, number: d.preemptedFrom.reservationNumber, status: d.preemptedFrom.status })
  for (const p of d.preemptedTo || []) {
    out.push({
      label: t('invoicing.reservations.givenToLabel'),
      id: p._id,
      number: p.reservationNumber,
      status: p.status,
      extra: [p.internalOrderNumber, `${t('invoicing.qty')} ${p.quantity}`].filter(Boolean).join(' · '),
    })
  }
  return out
})

const formActions = computed<FormAction[]>(() => {
  const r = res.value
  if (!r) return []
  return [
    { label: t('invoicing.reservations.changeQuantity'), icon: 'mdi-pencil', variant: 'outlined', handler: () => { editDialog.value = true }, show: r.status === 'active' },
    { label: t('invoicing.reservations.release'), icon: 'mdi-lock-open-variant-outline', color: 'error', variant: 'outlined', handler: () => { releaseDialog.value = true }, show: r.status === 'active' && (r.releasable || 0) > 0 },
    { label: t('invoicing.reservations.reserveAgain'), icon: 'mdi-restore', handler: reserveAgain, loading: repeating.value, show: r.status === 'cancelled' && !detail.value?.repeatedAs },
  ]
})

async function load() {
  const id = String(route.params.id || '')
  if (!id) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/reservations/${id}`)
    res.value = data.reservation
    detail.value = data.detail
    notFound.value = false
  } catch (e: any) {
    if (e?.response?.status === 404) {
      notFound.value = true
      res.value = null
      detail.value = null
    } else {
      showError(reservationErrorMessage(e, t))
    }
  } finally {
    loading.value = false
  }
}

/** „Резервирай отново": as it was; when its source has run dry, the dialog with the shortage named (§5.7). */
async function reserveAgain() {
  if (!res.value) return
  repeating.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoicing/reservations/${res.value._id}/repeat`, {})
    onRepeated(data.reservation, data.created !== false)
  } catch (e: any) {
    if (isShortage(e)) {
      repeatError.value = reservationErrorMessage(e, t)
      againDialog.value = true
    } else {
      showError(reservationErrorMessage(e, t))
    }
  } finally {
    repeating.value = false
  }
}

function onRepeated(reservation: any, created: boolean) {
  const number = reservation?.reservationNumber
  showSuccess(created
    ? t('invoicing.reservations.reservedAgain', { number })
    : t('invoicing.reservations.alreadyReservedAgain', { number }))
  router.push({ name: 'invoicing.reservations.detail', params: { id: String(reservation._id) } })
}

// The same view serves the next reservation (a repeat, a linked one): load whenever the id changes.
watch(() => route.params.id, () => {
  if (route.name === 'invoicing.reservations.detail') load()
}, { immediate: true })
</script>
