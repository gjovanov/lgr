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
    <!-- FR-28.32 (D-14): the same banner as the documents', without the organization's name and the title. -->
    <template #document-header>
      <DocumentBanner
        :number="res?.reservationNumber"
        :status="res ? $t(`invoicing.status.${res.status}`) : ''"
        :status-color="res ? statusColor(res.status) : undefined"
        number-test-id="reservation-number"
      />
    </template>

    <div v-if="notFound" class="text-medium-emphasis pa-4">{{ $t('common.noData') }}</div>
    <template v-else-if="res">
      <!-- FR-28.45: five panels, stacked at full width (a supply tree is too wide for half a row). Each says what it
           holds in a line while it is folded, so closing one loses nothing a glance needs. -->

      <!-- Who, what, how much -->
      <CollapsiblePanel screen="reservations.detail" panel-id="who" :summary="whoSummary" class="mb-3" data-testid="reservation-panel-who">
        <template #title>
          <v-icon size="20" color="primary">mdi-account-outline</v-icon>
          {{ $t('invoicing.reservations.page.who') }}
        </template>
        <v-card-text>
          <div class="d-flex flex-wrap gc-8 gr-3">
            <div>
              <div class="text-caption text-medium-emphasis">{{ $t('invoicing.customer') }}</div>
              <div class="text-body-1">
                <EntityLink :label="res.contactName || '—'" :to="{ name: 'invoicing.contacts.edit', params: { id: String(res.contactId) } }" />
              </div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">{{ $t('invoicing.product') }}</div>
              <div class="text-body-1">
                <EntityLink v-if="res.productId" :label="res.productName || '—'" :href="appHref('inventory', `/inventory/products/${res.productId}/stock`)" />
                <span v-else>—</span>
                <span v-if="res.productSku" class="text-caption text-medium-emphasis ms-2">{{ res.productSku }}</span>
              </div>
            </div>
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
      </CollapsiblePanel>

      <!-- Where the goods come from, and who else has reserved them -->
      <CollapsiblePanel screen="reservations.detail" panel-id="source" :summary="sourceSummary" :flag="sourceFlag" class="mb-3" data-testid="reservation-panel-source">
        <template #title>
          <v-icon size="20" color="primary">{{ res.source === 'order' ? 'mdi-truck-outline' : 'mdi-warehouse' }}</v-icon>
          {{ $t('invoicing.reservations.sourceLabel') }}
        </template>
        <v-card-text>
          <template v-if="res.source === 'order'">
            <div class="d-flex align-center flex-wrap ga-2 text-body-1">
              <v-icon size="18">mdi-truck-outline</v-icon>
              <EntityLink
                v-if="detail?.order"
                :label="detail.order.orderNumber"
                :to="{ name: 'invoicing.orders.edit', params: { id: detail.order._id }, query: orderLineQuery(res) }"
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

          <!-- FR-28.45: where it sits. The supply the goods come from, and everyone who has reserved a share of it;
               this reservation is the shaded row. Read-only: the other reservations open on their own pages. -->
          <div v-if="supply && supplyTree" class="mt-4" data-testid="reservation-supply">
            <v-divider class="mb-3" />
            <div class="text-subtitle-2">{{ $t('invoicing.reservations.page.supplyTitle') }}</div>
            <div class="text-caption text-medium-emphasis mb-2">{{ $t(supply.kind === 'order' ? 'invoicing.reservations.page.supplyHintOrder' : 'invoicing.reservations.page.supplyHintStock') }}</div>
            <OrderTree :nodes="supplyTree.nodes" :columns="treeColumns" :row-class="supplyRowClass">
              <template #item="{ node }">
                <!-- The supplier order's line. -->
                <span v-if="node.kind === 'line'" class="text-body-2 font-weight-medium" :title="node.label">{{ node.label }}</span>
                <!-- A warehouse: what it was given, or what is on its shelf. -->
                <template v-else-if="node.kind === 'allocation'">
                  <v-icon size="16" color="medium-emphasis" class="me-2 flex-shrink-0">mdi-warehouse</v-icon>
                  <span class="text-body-2" :title="node.label">{{ node.label }}</span>
                </template>
                <!-- A client's reservation: who, its number (a link to its page, except this one's own) and the customer order it serves. -->
                <div v-else-if="node.kind === 'reservation' && node.reservation" class="d-flex align-center flex-wrap gc-3 text-body-2" style="min-width: 0">
                  <span :class="node.reservation.status === 'cancelled' ? 'text-decoration-line-through text-medium-emphasis' : ''" :title="node.label">{{ node.label }}</span>
                  <span v-if="isThis(node)" class="text-no-wrap flex-shrink-0">{{ node.reservation.number }}</span>
                  <EntityLink v-else-if="node.reservation.number && node.reservation.resId" class="text-no-wrap flex-shrink-0" :label="node.reservation.number" :to="{ name: 'invoicing.reservations.detail', params: { id: String(node.reservation.resId) } }" />
                  <span v-if="orderNumberOf(node)" class="text-no-wrap flex-shrink-0 text-medium-emphasis" :title="$t('invoicing.internalOrder')">{{ orderNumberOf(node) }}</span>
                  <v-chip v-if="isThis(node)" size="x-small" label color="primary" variant="flat" data-testid="reservation-this">{{ $t('invoicing.reservations.page.thisReservation') }}</v-chip>
                </div>
                <!-- A warehouse nobody has reserved on. -->
                <span v-else class="text-caption text-medium-emphasis ps-1">{{ $t('invoicing.tree.noClients') }}</span>
              </template>

              <template #cells="{ node, open, hidden, span }">
                <td v-if="node.kind === 'placeholder'" :colspan="span - 1" />
                <template v-else>
                  <td class="text-end" data-col="qty">
                    <span :class="node.reservation?.status === 'cancelled' ? 'text-decoration-line-through text-medium-emphasis' : ''">{{ node.figures.quantity }}</span>
                  </td>
                  <td class="text-end" data-col="reserved">{{ node.kind === 'reservation' ? '' : node.figures.reserved }}</td>
                  <td class="text-end" data-col="free">{{ node.figures.free ?? '' }}</td>
                  <td v-if="supply.kind === 'order'" class="text-end" data-col="received">
                    <span v-if="node.figures.received !== null">{{ node.figures.received }}</span>
                  </td>
                  <!-- Dispatched is a column of its own while there is room; when there is not, its figure is the tooltip of Invoiced. -->
                  <td class="text-end" data-col="invoiced" :title="hidden.has('dispatched') ? invoicedAndDispatched(node.figures) : undefined">{{ node.figures.invoiced }}</td>
                  <td v-if="!hidden.has('dispatched')" class="text-end" data-col="dispatched">{{ node.figures.dispatched }}</td>
                  <td data-col="status">
                    <div class="d-flex flex-wrap ga-1">
                      <v-chip v-for="c in statusChips(node, open)" :key="c.key" size="x-small" :label="c.label" :variant="c.variant || 'tonal'" :color="c.color" :title="c.text">{{ c.text }}</v-chip>
                    </div>
                  </td>
                </template>
              </template>
            </OrderTree>
            <div v-if="supply.truncated" class="text-caption text-medium-emphasis mt-1" data-testid="reservation-supply-truncated">
              {{ $t('invoicing.reservations.page.truncated', { shown: supply.reservations.length, total: supply.total }) }}
            </div>
          </div>
        </v-card-text>
      </CollapsiblePanel>

      <!-- The client order it serves -->
      <CollapsiblePanel screen="reservations.detail" panel-id="order" :summary="orderSummary" class="mb-3" data-testid="reservation-panel-order">
        <template #title>
          <v-icon size="20" color="primary">mdi-clipboard-text-outline</v-icon>
          {{ $t('invoicing.internalOrder') }}
        </template>
        <v-card-text>
          <template v-if="res.internalOrderId">
            <div class="d-flex align-center flex-wrap ga-2 text-body-1">
              <EntityLink
                :label="detail?.internalOrder?.orderNumber || res.internalOrderNumber || '…'"
                :to="{ name: 'invoicing.internalOrders.edit', params: { id: String(res.internalOrderId) }, query: internalOrderLineQuery(res) }"
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
      </CollapsiblePanel>

      <!-- The invoices that take it -->
      <CollapsiblePanel screen="reservations.detail" panel-id="invoices" :summary="invoicesSummary" class="mb-3" data-testid="reservation-panel-invoices">
        <template #title>
          <v-icon size="20" color="primary">mdi-file-document-outline</v-icon>
          {{ $t('invoicing.invoices') }}
        </template>
        <v-card-text>
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
      </CollapsiblePanel>

      <!-- What happened to it, and the reservations it is linked to -->
      <CollapsiblePanel screen="reservations.detail" panel-id="history" :summary="historySummary" data-testid="reservation-panel-history">
        <template #title>
          <v-icon size="20" color="primary">mdi-history</v-icon>
          {{ $t('invoicing.reservations.page.historyAndLinks') }}
        </template>
        <v-card-text>
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
      </CollapsiblePanel>
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
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import { useAppStore } from '../store/app.store'
import ReservationQuantityDialog from '../components/ReservationQuantityDialog.vue'
import ReservationReleaseDialog from '../components/ReservationReleaseDialog.vue'
import ReservationCreateDialog from '../components/ReservationCreateDialog.vue'
import DocumentBanner from '../components/document-form/DocumentBanner.vue'
import { reservationHistory, type HistoryTone } from '../composables/reservation-history'
import { isShortage, reservationErrorMessage } from '../composables/reservation-errors'
import OrderTree from '../components/order-tree/OrderTree.vue'
import { internalOrderLineQuery, orderLineQuery } from '../composables/order-tree/links'
import { buildSupplyTree } from '../composables/order-tree/supply-tree'
import type { SupplyInput, TreeColumn, TreeNode } from '../composables/order-tree/types'

/**
 * FR-22.37: a reservation's own page — `/reservations/:id`. Who it is for, what and how much, where
 * the goods come from, the client order it serves, the invoices that take it, and what happened to
 * it. Every number is a link; a page in another app (the product) is reached through `appHref`.
 * Its actions are the list's: change the quantity, release it (or part of it), reserve it again.
 *
 * FR-28.45: five collapsible panels, and in the Source panel the supply tree — the supplier order's line
 * and its warehouses, or the stock of the warehouse, with every reservation on it and this one shaded.
 * Its links to the supplier order and to the customer order open the LINE (`?line=`, FR-28.46).
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

// ── FR-28.45: the panels' one-line summaries, and what the Source panel draws ──
const plural = (key: string, n: number) => t(key, n)

const whoSummary = computed(() => {
  const r = res.value
  if (!r) return ''
  return t('invoicing.reservations.page.summaryWho', {
    client: r.contactName || '—',
    product: r.productName || '—',
    quantity: r.quantity,
    invoiced: r.invoicedQuantity || 0,
    dispatched: r.dispatchedQuantity || 0,
  })
})

/** The supply the goods come from, with every reservation on it (null: the allocation is gone, or there is none to draw). */
const supply = computed<(SupplyInput & { truncated?: boolean; total?: number }) | null>(() => detail.value?.supply || null)
const supplyTree = computed(() => (supply.value && res.value ? buildSupplyTree(supply.value, { contactName: () => '', thisId: String(res.value._id) }) : null))

const sourceSummary = computed(() => {
  const r = res.value
  if (!r) return ''
  const parts: string[] = r.source === 'order'
    ? [detail.value?.order?.orderNumber || r.orderNumber || '', detail.value?.allocation?.warehouseName || r.warehouseName || '']
    : [t('invoicing.sourceStock'), r.warehouseName || '']
  if (supply.value) parts.push(plural('invoicing.panels.reservationsCount', supply.value.total ?? supply.value.reservations.length))
  return parts.filter(Boolean).join(' · ')
})
/** What stays in view when the panel is folded: a hold with nothing under it, or one that will come too late. */
const sourceFlag = computed(() => {
  const r = res.value
  if (!r) return undefined
  if (r.source === 'order' && !detail.value?.allocation) return t('invoicing.reservations.page.allocationGoneShort')
  return r.late ? t('invoicing.reservations.page.lateShort') : undefined
})

const orderSummary = computed(() => {
  const r = res.value
  if (!r) return ''
  if (!r.internalOrderId) return t('invoicing.reservations.notForOrder')
  const number = detail.value?.internalOrder?.orderNumber || r.internalOrderNumber || ''
  const line = detail.value?.internalOrderLine
  return [number, line ? t('invoicing.reservations.lineFigures', { quantity: line.quantity, reserved: line.reservedQuantity, delivered: line.deliveredQuantity }) : ''].filter(Boolean).join(' · ')
})

const invoicesSummary = computed(() => {
  const n = detail.value?.invoices?.length || 0
  return n ? plural('invoicing.panels.invoices', n) : t('invoicing.reservations.notInvoiced')
})

const historySummary = computed(() => [
  plural('invoicing.reservations.page.events', history.value.length),
  links.value.length ? t('invoicing.reservations.page.linkedCount', { n: links.value.length }) : '',
].filter(Boolean).join(' · '))

// ── the supply tree ──
/** The columns of the supplier order's tree, without what only an editor needs (unit, price, actions). */
const treeColumns = computed<TreeColumn[]>(() => {
  const order = supply.value?.kind === 'order'
  return [
    { key: 'item', title: t(order ? 'invoicing.tree.item' : 'invoicing.reservations.page.supplyItemStock') },
    { key: 'qty', title: t('invoicing.qty'), hint: t(order ? 'invoicing.reservations.page.orderQtyHint' : 'invoicing.reservations.page.stockQtyHint'), align: 'end', width: '64px' },
    { key: 'reserved', title: t('invoicing.tree.reserved'), align: 'end', width: '80px' },
    { key: 'free', title: t('invoicing.freeQty'), hint: t(order ? 'invoicing.tree.freeHint' : 'invoicing.reservations.page.stockFreeHint'), align: 'end', width: '56px' },
    ...(order ? ([{ key: 'received', title: t('invoicing.tree.received'), align: 'end', width: '82px' }] as TreeColumn[]) : []),
    { key: 'invoiced', title: t('invoicing.tree.invoiced'), align: 'end', width: '74px' },
    { key: 'dispatched', title: t('invoicing.tree.dispatched'), align: 'end', width: '90px', optional: true },
    { key: 'status', title: t('common.status'), width: '110px' },
  ]
})

/** The tooltip of Invoiced while Dispatched has no column of its own (a narrow screen): both figures, so neither is lost. */
const invoicedAndDispatched = (f: { invoiced: number; dispatched: number }) =>
  `${t('invoicing.tree.invoiced')} ${f.invoiced} · ${t('invoicing.tree.dispatched')} ${f.dispatched}`

const isThis = (node: TreeNode) => !!supplyTree.value && node.id === supplyTree.value.thisNodeId
const supplyRowClass = (node: TreeNode) => (isThis(node) ? 'order-tree__row--self' : undefined)

/** The customer order each reservation on the supply serves, by number: plain text here (the page's own link is the one above). */
const orderNumbers = computed(() => new Map((supply.value?.reservations || []).map((r: any) => [String(r._id), String(r.internalOrderNumber || '')])))
const orderNumberOf = (node: TreeNode) => (node.reservation?.resId ? orderNumbers.value.get(node.reservation.resId) || '' : '')

interface StatusChip { key: string; text: string; color?: string; variant?: 'tonal' | 'outlined'; label?: boolean }
/** A reservation row: its status. A line or a warehouse: what is wrong with it, while open; closed, also what is below it. */
function statusChips(node: TreeNode, open: boolean): StatusChip[] {
  const out: StatusChip[] = []
  const r = node.reservation
  if (node.kind === 'reservation' && r) {
    if (r.status) out.push({ key: 'status', text: t(`invoicing.status.${r.status}`), color: statusColor(r.status), label: true })
    return out
  }
  const flags = open ? node.flags : node.rolledFlags
  if (flags.includes('overAllocated')) out.push({ key: 'over', text: t('invoicing.tree.overAllocated'), color: 'error' })
  if (flags.includes('unallocated')) out.push({ key: 'unalloc', text: t('invoicing.tree.unallocated', { n: node.figures.free ?? 0 }), variant: 'outlined' })
  return out
}

const formActions = computed<FormAction[]>(() => {
  const r = res.value
  if (!r) return []
  return [
    { label: t('invoicing.reservations.changeQuantity'), icon: 'mdi-pencil', variant: 'outlined', handler: () => { editDialog.value = true }, show: r.status === 'active', cap: ['orders.create', 'orders.edit'] },
    { label: t('invoicing.reservations.release'), icon: 'mdi-lock-open-variant-outline', color: 'error', variant: 'outlined', handler: () => { releaseDialog.value = true }, show: r.status === 'active' && (r.releasable || 0) > 0, cap: ['orders.edit', 'orders.delete'] },
    { label: t('invoicing.reservations.reserveAgain'), icon: 'mdi-restore', handler: reserveAgain, loading: repeating.value, show: r.status === 'cancelled' && !detail.value?.repeatedAs, cap: 'orders.create' },
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
