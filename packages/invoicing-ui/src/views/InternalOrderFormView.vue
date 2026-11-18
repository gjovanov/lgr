<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editInternalOrder') : $t('invoicing.newInternalOrder')"
    :subtitle="documentNumber"
    :status="statusDef"
    :actions="formActions"
    :loading="loading"
    :load-error="loadError"
    :refusal="refusal"
    @retry="loadOrder()"
    @dismiss-refusal="dismissRefusal"
    back-to="/internal-orders"
    :back-label="$t('nav.internalOrders')"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
  >
    <!-- FR-28.32 (D-14): the same banner as the documents'. The coverage chip stays beside the status. -->
    <template #document-header>
      <DocumentBanner :number="documentNumber" :status="$t(`invoicing.status.${orderStatus}`)">
        <template #chips>
          <v-chip v-if="isEdit" size="x-small" label variant="tonal" :color="coverageColor(coverage)">
            {{ $t(`invoicing.coverage.${coverage}`) }}
          </v-chip>
        </template>
      </DocumentBanner>
    </template>

    <v-form ref="formRef" @submit.prevent="onSave">
      <v-defaults-provider :defaults="{
        VTextField: { density: 'compact', variant: 'outlined' },
        VSelect: { density: 'compact', variant: 'outlined' },
        VAutocomplete: { density: 'compact', variant: 'outlined' },
        VTextarea: { density: 'compact', variant: 'outlined' },
      }">
        <!-- Header fields -->
        <v-row dense>
          <v-col cols="12" sm="6" md="4">
            <div class="d-flex align-center ga-1">
              <v-autocomplete
                v-model="form.contactId"
                :items="clientOptions"
                item-title="companyName"
                item-value="_id"
                :label="$t('invoicing.customer')"
                :rules="[rules.required]"
                no-filter
                class="flex-grow-1"
                :readonly="readonly"
                :loading="loadingContacts"
                @update:search="(s: string) => onContactSearch(s, 'client')"
              />
              <v-btn v-if="!readonly" icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.searchContact')" :aria-label="$t('invoicing.searchContact')" @click="openContactPicker({ kind: 'client' })" />
            </div>
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :readonly="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-text-field v-model="form.requestedDeliveryDate" :label="$t('invoicing.requestedDeliveryDate')" type="date" :rules="[rules.required]" :readonly="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-select v-model="form.priority" :label="$t('invoicing.priority.label')" :items="priorityOptions" item-title="title" item-value="value" :readonly="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-autocomplete v-model="form.warehouseId" :items="warehouses" item-title="name" item-value="_id" :label="$t('warehouse.warehouse')" clearable :readonly="readonly" />
          </v-col>
        </v-row>

        <!-- Lines. FR-28.43: a panel; folded, it still says how many lines, how much is needed and how much is reserved.
             FR-28.44: the lines are a tree of two levels, a line and the reservations that cover it, in the supplier
             order's columns and drawn by the same component. A reservation is still made, changed and released AT ONCE,
             each with its own dialog: nothing here is staged. What a row is and what it adds up to is the node model's
             (`composables/order-tree/customer-order-tree.ts`); the cells say it. -->
        <CollapsiblePanel ref="linesPanelRef" screen="internal-orders.edit" panel-id="lines" :summary="linesSummary" class="mt-2" data-testid="internal-order-lines">
          <template #title>
            <v-icon size="20" color="primary">mdi-format-list-bulleted</v-icon>
            {{ $t('invoicing.lineItems') }}
          </template>
          <template v-if="isEdit" #actions>
            <!-- FR-28.42: open or close every line at once. -->
            <v-btn size="x-small" variant="text" icon="mdi-unfold-more-horizontal" :title="$t('invoicing.tree.expandAll')" :aria-label="$t('invoicing.tree.expandAll')" data-testid="tree-expand-all" @click="treeRef?.expandAll()" />
            <v-btn size="x-small" variant="text" icon="mdi-unfold-less-horizontal" :title="$t('invoicing.tree.collapseAll')" :aria-label="$t('invoicing.tree.collapseAll')" data-testid="tree-collapse-all" @click="treeRef?.collapseAll()" />
          </template>
          <v-card-text class="pa-2">
            <div ref="linesRef">
              <OrderTree ref="treeRef" :nodes="shownNodes" :columns="treeColumns">
                <template #item="{ node }">
                  <!-- The article: the line's own search and picker, as they were. From the top: the button stays
                       beside the field, not beside the field and its chip. -->
                  <div v-if="node.kind === 'line'" class="d-flex align-start ga-1 flex-grow-1" style="min-width: 0">
                    <ProductLineDescription
                      :description="lineOf(node).description"
                      :product-id="lineOf(node).productId"
                      :known="knownOf(lineOf(node).productId)"
                      price-field="sellingPrice"
                      class="flex-grow-1"
                      style="min-width: 0"
                      :stock-warehouse-id="form.warehouseId || undefined"
                      @update:description="lineOf(node).description = $event"
                      @update:product-id="setLineArticle(lineOf(node), $event)"
                      @product-selected="onProductSelected(lineOf(node), $event)"
                      @product-cleared="setLineArticle(lineOf(node), undefined)"
                      @details="openProductPicker(node.source.lineIndex!, $event)"
                    />
                    <ProductDetailsButton @click="openProductPicker(node.source.lineIndex!)" />
                  </div>
                  <!-- A reservation of the line (#203): its number, where the goods come from, and the warehouse. -->
                  <div v-else-if="node.kind === 'reservation' && node.reservation" class="d-flex align-center flex-wrap text-body-2" style="min-width: 0; column-gap: 8px">
                    <EntityLink
                      :label="node.reservation.number || ''"
                      :to="{ name: 'invoicing.reservations.detail', params: { id: String(node.reservation.resId) } }"
                      class="text-no-wrap"
                    />
                    <!-- FR-28.46: the supplier order opens on the line (and the warehouse) the reservation is on. -->
                    <v-chip
                      size="x-small"
                      variant="tonal"
                      :color="node.reservation.source === 'order' ? 'info' : undefined"
                      :to="rowOrderLink(node.reservation)"
                    >
                      {{ node.reservation.source === 'order' ? (orderNumbers[String(node.reservation.orderId)] || 'ORDO') : $t('invoicing.sourceStock') }}
                    </v-chip>
                    <span class="text-medium-emphasis">{{ warehouseName(node.reservation.warehouseId || '') }}</span>
                  </div>
                  <!-- Nothing reserved for the line yet. -->
                  <span v-else class="text-caption text-medium-emphasis ps-1">{{ $t('invoicing.tree.noReservations') }}</span>
                </template>

                <template #cells="{ node, open, hidden, span }">
                  <!-- A line with nothing reserved: one cell, with the same + Reserve as the line's own. -->
                  <template v-if="node.kind === 'placeholder'">
                    <td :colspan="span - 1" class="text-end">
                      <ReserveMenu :disabled="node.actions[0]?.disabled" @pick="onReservePick(node, $event)" />
                    </td>
                  </template>
                  <template v-else>
                    <td data-col="qty">
                      <v-text-field
                        v-if="node.kind === 'line'"
                        v-model.number="lineOf(node).quantity"
                        type="number"
                        min="0"
                        class="order-tree__num"
                        density="compact"
                        hide-details
                        variant="underlined"
                        :aria-label="$t('invoicing.qty')"
                        :data-line-qty="node.id"
                        :readonly="readonly"
                      />
                      <span v-else class="d-block text-end" :class="node.status === 'cancelled' ? 'text-decoration-line-through text-medium-emphasis' : ''">{{ node.figures.quantity }}</span>
                    </td>
                    <td data-col="unit">
                      <LineUnitSelect
                        v-if="node.kind === 'line'"
                        v-model="lineOf(node).unit"
                        :items="uomOptions"
                        :aria-label="$t('invoicing.unit')"
                        :readonly="readonly"
                      />
                    </td>
                    <td data-col="price">
                      <!-- The article's prices for this client, as on an invoice line („Select price"): the selling
                           price and every named one. A price that is picked, or typed, is the order's own: the line
                           is pinned (`config/order-line-price`), the button says so, and the order's invoice charges
                           it. Until then the figure is an indication and the invoice is priced for the client. -->
                      <div v-if="node.kind === 'line'" class="order-tree__num-group">
                        <!-- Only while the order can still be saved, and by this person: a price that cannot be stored
                             must not look chosen. -->
                        <PriceSelectButton
                          v-if="canSaveOrder()"
                          density="comfortable"
                          :product-id="lineOf(node).productId"
                          :contact-id="form.contactId || undefined"
                          :quantity="Number(lineOf(node).quantity) || 1"
                          :org-url="orgUrl()"
                          :currency="form.currency || baseCurrency"
                          :pinned="!!lineOf(node).pricePinned"
                          :pinned-title="$t('invoicing.orderPriceChosen')"
                          :release-label="$t('invoicing.orderPriceAuto')"
                          @select="pickLinePrice(lineOf(node), $event.price)"
                          @release="releaseLinePrice(lineOf(node), $event)"
                        />
                        <!-- A price typed here is the invoice's (#695), so it is the role's to give (FR-27
                             `sales-docs.manual-price`); without it the line takes a price picked with Select price. -->
                        <v-text-field
                          v-model.number="lineOf(node).expectedUnitPrice"
                          type="number"
                          step="0.0001"
                          min="0"
                          class="order-tree__num"
                          density="compact"
                          hide-details
                          variant="underlined"
                          :aria-label="$t('invoicing.expectedPrice')"
                          :readonly="readonly || !typesPrice"
                          :title="typesPrice ? undefined : $t('invoicing.pricePickOnly')"
                          data-testid="order-line-price"
                          @update:model-value="typeLinePrice(lineOf(node), $event)"
                        />
                      </div>
                    </td>
                    <template v-if="isEdit">
                      <td class="text-end" data-col="reserved">{{ figureOf(node, node.figures.reserved) }}</td>
                      <td class="text-end" data-col="free">{{ figureOf(node, node.figures.free) }}</td>
                      <!-- Delivered is a column of its own while there is room; when there is not, its figure is the tooltip of Invoiced. -->
                      <td class="text-end" data-col="invoiced" :title="hidden.has('dispatched') ? invoicedAndDelivered(node.figures) : undefined">{{ figureOf(node, node.figures.invoiced, true) }}</td>
                      <td v-if="!hidden.has('dispatched')" class="text-end" data-col="dispatched">{{ figureOf(node, node.figures.dispatched, true) }}</td>
                      <td data-col="status">
                        <div class="d-flex flex-wrap align-center ga-1 line-grid__line">
                          <v-chip v-for="c in statusChips(node, open)" :key="c.key" size="x-small" variant="tonal" :label="c.label" :color="c.color" :prepend-icon="c.icon" :title="c.title || c.text">{{ c.text }}</v-chip>
                        </div>
                      </td>
                    </template>
                    <td class="text-no-wrap text-end" data-col="actions">
                      <template v-for="a in node.actions" :key="a.type">
                        <ReserveMenu v-if="a.type === 'reserve'" :disabled="a.disabled" @pick="onReservePick(node, $event)" />
                        <v-btn
                          v-else
                          size="x-small"
                          variant="text"
                          :icon="actionIcon(a.type)"
                          :color="actionColor(a.type)"
                          :loading="a.type === 'reserveAgain' && repeating === node.reservation?.resId"
                          :tabindex="a.type === 'remove' ? -1 : undefined"
                          :title="actionTitle(a.type)"
                          :aria-label="actionTitle(a.type)"
                          :data-testid="`tree-${a.type}`"
                          @click="onAction(node, a.type)"
                        />
                      </template>
                    </td>
                  </template>
                </template>

                <!-- What the lines add up to, in the columns above. -->
                <template #totals="{ hidden }">
                  <td data-col="item">{{ $t('invoicing.tree.totalsOrder') }}</td>
                  <td class="text-end" data-col="qty">{{ tree.totals.ordered }}</td>
                  <td data-col="unit"></td>
                  <td data-col="price"></td>
                  <template v-if="isEdit">
                    <td class="text-end" data-col="reserved">{{ tree.totals.reserved }}</td>
                    <td class="text-end" data-col="free">{{ tree.totals.short }}</td>
                    <td class="text-end" data-col="invoiced" :title="hidden.has('dispatched') ? invoicedAndDelivered({ invoiced: tree.totals.invoiced, dispatched: tree.totals.delivered }) : undefined">{{ tree.totals.invoiced }}</td>
                    <td v-if="!hidden.has('dispatched')" class="text-end" data-col="dispatched">{{ tree.totals.delivered }}</td>
                    <td data-col="status"></td>
                  </template>
                  <td data-col="actions"></td>
                </template>
              </OrderTree>
            </div>
            <v-btn v-if="!readonly" color="primary" variant="text" size="small" prepend-icon="mdi-plus" class="mt-1" @click="form.lines.push(emptyLine())">
              {{ $t('invoicing.addLine') }}
            </v-btn>
          </v-card-text>
        </CollapsiblePanel>

        <!-- Coverage toolbox + linked reservations. The order-wide buttons stay on the header, folded or
             not: they act on the whole order, not on what the panel shows. -->
        <CustomerReservationsCard
          v-if="isEdit"
          :reservations="reservations"
          :readonly="readonly"
          :can-reserve="canReserve"
          :reserving="reserving"
          :repeating="repeating"
          :order-numbers="orderNumbers"
          :warehouse-name="warehouseName"
          :line-description="lineDescription"
          :is-late="isLate"
          @reserve-available="reserveAvailable"
          @cover="shortages?.openCoverDialog()"
          @generate="shortages?.openGenerateDialog()"
          @release="openRelease"
          @reserve-again="reserveAgain"
        />
        <OrderInvoicesCard v-if="isEdit" screen="internal-orders.edit" :invoices="linkedInvoices" :contacts="contactNames" :currency="form.currency || baseCurrency" :locale-code="localeCode" />
        <ReservationQuantityDialog
          v-model="resEditDialog"
          :reservation="resEditing"
          :subtitle="resEditing ? lineDescription(resEditing) : ''"
          @saved="refreshReservations"
        />
        <!-- FR-22.37: the Reservations list's release dialog — all of it, or part. -->
        <ReservationReleaseDialog
          v-model="releaseDialog"
          :reservation="releasing"
          :subtitle="releasing ? lineDescription(releasing) : ''"
          @released="refreshReservations"
        />

        <OrderFormFooter
          v-model:notes="form.notes"
          v-model:terms="form.terms"
          v-model:tags="form.tags"
          tag-type="internal_order"
          :org-url="orgUrl()"
          :readonly="readonly"
          :is-edit="isEdit"
          :saving="saving"
          :ordered="totalOrdered"
          :reserved="totalReserved"
          moved-label="invoicing.deliveredQty"
          :moved="totalDelivered"
          :total="fmtCurrency(estimatedTotal)"
          @save="onSave"
        />
      </v-defaults-provider>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="internal_order" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ProductPickerDialog
      v-model="productPickerOpen"
      :org-url="orgUrl()"
      :base-currency="baseCurrency"
      :locale="localeCode"
      multiple
      :stock-warehouse-id="form.warehouseId || undefined"
      price-field="sellingPrice"
      :existing-product-ids="existingProductIds"
      :initial-search="productPickerText"
      @select-many="onProductsPicked"
    />
    <ContactPickerDialog v-model="contactPickerOpen" :org-url="orgUrl()" :type="contactPickerTarget?.kind === 'supplier' ? 'supplier' : 'customer'" @select="onContactPicked" />

    <!-- Cover shortages, and a supplier order for them: opened from the Reservations card and from a line's + Reserve. -->
    <ShortageDialogs
      ref="shortages"
      :org-url="orgUrl()"
      :warehouse-id="form.warehouseId"
      :warehouses="warehouses"
      :supplier-options="supplierOptions"
      :loading-contacts="loadingContacts"
      :refresh="refreshReservations"
      @search-suppliers="(s: string) => onContactSearch(s, 'supplier')"
      @known-supplier="keepSupplier"
    />

    <!-- FR-22.41: what Cancel or Complete releases, asked before it happens. -->
    <OrderCascadeDialog
      v-model="cascade.open"
      side="client"
      :title="$t(cascade.action === 'cancel' ? 'invoicing.cascade.cancelClientTitle' : 'invoicing.cascade.completeClientTitle', { number: documentNumber })"
      :summary="cascadeNow"
      :confirm-label="cascade.action === 'cancel' ? $t('invoicing.cancelOrder') : $t('invoicing.completeOrder')"
      :confirm-color="cascade.action === 'cancel' ? 'error' : 'primary'"
      :loading="cascade.busy"
      :error="cascade.error"
      @confirm="confirmCascade"
    />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useAccess } from 'ui-shared/access/useAccess'
import EntityFormShell, { type FormAction, type StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ProductDetailsButton from 'ui-shared/components/ProductDetailsButton.vue'
import LineUnitSelect from 'ui-shared/components/LineUnitSelect.vue'
import PriceSelectButton from 'ui-shared/components/PriceSelectButton'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import EntityLink from 'ui-shared/components/EntityLink'
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import ProductLineDescription from '../components/ProductLineDescription.vue'
import ReservationQuantityDialog from '../components/ReservationQuantityDialog.vue'
import ReservationReleaseDialog from '../components/ReservationReleaseDialog.vue'
import OrderCascadeDialog from '../components/OrderCascadeDialog.vue'
import OrderInvoicesCard from '../components/OrderInvoicesCard.vue'
import DocumentBanner from '../components/document-form/DocumentBanner.vue'
import OrderTree from '../components/order-tree/OrderTree.vue'
import ReserveMenu from '../components/order-tree/ReserveMenu.vue'
import OrderFormFooter from '../components/order-form/OrderFormFooter.vue'
import CustomerReservationsCard from '../components/order-form/CustomerReservationsCard.vue'
import ShortageDialogs from '../components/order-form/ShortageDialogs.vue'
import { useCustomerOrderPrint } from '../composables/useCustomerOrderPrint'
import { COLLAPSE } from '../composables/document-form/form-actions'
import { reservationErrorMessage } from '../composables/reservation-errors'
import { orderCoverage } from 'config/order-coverage'
import { pickLinePrice, releaseLinePrice, setLineArticle, typeLinePrice } from 'config/order-line-price'
import { buildCustomerOrderTree, customerLineNodeId } from '../composables/order-tree/customer-order-tree'
import { isLateReservation } from '../composables/order-tree/figures'
import type { TreeActionType, TreeNode } from '../composables/order-tree/types'
import { useOrderFormBase } from '../composables/order-form/useOrderFormBase'
import { fillPickedLines, orderStatusDef } from '../composables/order-form/shared'
import {
  NO_FIGURES, coverageColor, customerLinesFrom, customerOrderBody, emptyLine, figuresByLine, rowOrderLink, type LineFigures, type LineRow,
} from '../composables/order-form/customer-order'
import {
  customerActionColor, customerActionIcon, customerActionTitle, customerStatusChips, customerTreeColumns, figureOf, invoicedAndDelivered as invoicedAndDeliveredOf,
} from '../composables/order-form/customer-tree-view'

// The customer order (ORDI). What it shares with the supplier order's form is `useOrderFormBase` and
// `components/order-form` (FR-32.23); what is its own is here and in `composables/order-form`.
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const {
  loadError, refusal, loadStarted, loadFailed, refused, succeeded, dismissRefusal, showSuccess, showError, showSnackbar, conversion, uomOptions,
  isEdit, formRef, loading, saving, orderStatus, orderNumber, documentNumber, readonly, baseCurrency, localeCode, rules, orgUrl, fmtCurrency,
  reservations, linkedInvoices, linkedOrderNumbers: orderNumbers, clientOptions, supplierOptions, loadingContacts,
  contactNames, knownProducts, knownOf, onContactSearch, fetchContacts, adoptContact, warehouses, fetchWarehouses, warehouseName,
  createAttempt, fetchPeekedNumber, deleteOrder, doAction, cascade, cascadeNow, cancelOrder, completeOrder, confirmCascade,
} = useOrderFormBase({
  api: 'internal-orders',
  listRoute: 'invoicing.internalOrders',
  side: 'client',
  deleteConfirmKey: 'invoicing.deleteInternalOrderConfirm',
  readonlyStatuses: ['completed', 'cancelled', 'delivered'],
  currency: () => form.currency,
  knownContactIds: (pool) => (pool === 'client' ? [form.contactId] : []),
  reload: () => loadOrder(),
})
const canReserve = computed(() => ['confirmed', 'partially_delivered'].includes(orderStatus.value))

const form = reactive({
  contactId: '',
  issueDate: new Date().toISOString().split('T')[0],
  requestedDeliveryDate: '',
  priority: 'normal',
  warehouseId: '' as string | undefined,
  currency: baseCurrency.value,
  exchangeRate: 1,
  notes: '',
  terms: '',
  tags: [] as string[],
  lines: [emptyLine()] as LineRow[],
})

const priorityOptions = computed(() => (['low', 'normal', 'high', 'urgent'] as const).map((p) => ({ value: p, title: t(`invoicing.priority.${p}`) })))

// ── reservations ──
function lineDescription(res: any) {
  return form.lines.find((l: any) => String(l._id) === String(res.internalOrderLineId))?.description || '—'
}
const resEditDialog = ref(false)
const resEditing = ref<any>(null)
function openResEdit(res: any) {
  resEditing.value = res
  resEditDialog.value = true
}
const repeating = ref('')
async function reserveAgain(res: any) {
  repeating.value = res._id
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/reservations/${res._id}/repeat`, {})
    showSuccess(data.created
      ? t('invoicing.reservations.reservedAgain', { number: data.reservation.reservationNumber })
      : t('invoicing.reservations.alreadyReservedAgain', { number: data.reservation.reservationNumber }))
    await refreshReservations()
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    repeating.value = ''
  }
}

/**
 * What the server derives per saved line, by line id. Kept apart from `form` on purpose: the
 * pending-changes snapshot is the form, and a reservation action or Convert changes these figures
 * without the user editing anything — inside the form they made an untouched order read as
 * „Незапазени промени" (the P7-chain flake).
 */
const lineFigures = ref<Record<string, LineFigures>>({})
function figuresOf(line: LineRow): LineFigures {
  return (line._id && lineFigures.value[String(line._id)]) || NO_FIGURES
}
/** The reservations, their orders' numbers and the names, as GET /internal-orders/:id answers them. */
function takeReservations(data: any) {
  reservations.value = data.reservations || []
  linkedInvoices.value = data.lookup?.invoices || {}
  if (data.lookup?.contacts) Object.assign(contactNames.value, data.lookup.contacts)
  if (data.lookup?.products) knownProducts.value = data.lookup.products
  if (data.lookup?.orders) {
    for (const [oid, info] of Object.entries<any>(data.lookup.orders)) orderNumbers.value[oid] = info.orderNumber
  }
}

/**
 * After a reservation action: the reservations and what the server derives from them (each line's
 * reserved / invoiced / delivered, the status) — never the fields the user may be editing. The
 * whole-form reload used here before threw unsaved line edits away.
 */
async function refreshReservations() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/internal-orders/${route.params.id}`)
    orderStatus.value = data.internalOrder.status
    lineFigures.value = figuresByLine(data.internalOrder.lines)
    takeReservations(data)
  } catch {
    showError(t('common.operationFailed'))
  }
}

/** One rule for "late" on the tree and on the flat card (`figures.ts`): a reservation still waiting for goods that a supplier order brings after the day asked for. */
function isLate(res: any) {
  return isLateReservation({ status: res.status, expectedDate: res.expectedDate }, form.requestedDeliveryDate)
}
/** FR-22.44: covered on stock (`full`), or partly only by a supplier order not sent yet (`ordered`). */
function coverageInput(line: LineRow) {
  const f = figuresOf(line)
  return { quantity: line.quantity, reserved: f.reserved, onUnsentOrder: f.onUnsentOrder }
}
const coverage = computed(() => orderCoverage(form.lines.map(coverageInput)).status)

// ── pickers ──
const productPickerOpen = ref(false)
const productPickerTarget = ref<number | null>(null)
/** FR-28.25: what the user had typed in the line's field when they asked for Details (F4, "Show all N results"). */
const productPickerText = ref('')
/** FR-28.28: the articles already on the order are marked in the dialog, not hidden from it. */
const existingProductIds = computed(() => form.lines.map((l) => String(l.productId || '')).filter(Boolean))
function openProductPicker(li: number, text = '') {
  productPickerTarget.value = li
  productPickerText.value = text
  productPickerOpen.value = true
}
/** FR-28.28: several articles at once, from the line the dialog was opened from. */
function onProductsPicked(ps: any[]) {
  if (productPickerTarget.value === null || !ps.length) return
  fillPickedLines(form.lines, productPickerTarget.value, ps, emptyLine, (line, p) => {
    setLineArticle(line, p._id)
    line.description = p.name
    onProductSelected(line, p)
  })
}

type ContactPickTarget = { kind: 'client' } | { kind: 'supplier' }
const contactPickerOpen = ref(false)
const contactPickerTarget = ref<ContactPickTarget | null>(null)
function openContactPicker(target: ContactPickTarget) {
  contactPickerTarget.value = target
  contactPickerOpen.value = true
}
function onContactPicked(c: any) {
  const supplier = contactPickerTarget.value?.kind === 'supplier'
  const id = adoptContact(c, supplier ? 'supplier' : 'client')
  if (id && !supplier) form.contactId = id
}
/** A supplier the shortage suggestions name, among the options so its name shows. */
function keepSupplier(entry: { _id: string; companyName: string }) {
  if (!supplierOptions.value.some((o) => o._id === entry._id)) supplierOptions.value = [entry, ...supplierOptions.value]
}

function onProductSelected(line: LineRow, product: any) {
  line.unit = product.unit || line.unit
  line.sku = product.sku
  if (!line.expectedUnitPrice) line.expectedUnitPrice = product.sellingPrice || undefined
  if (!line.quantity) line.quantity = 1
  // FR-22.43: an article on the last line opens the next one, as on the receipt and the invoices;
  // the quantity is what the line needs next, so the cursor goes there.
  const idx = form.lines.indexOf(line)
  if (idx === form.lines.length - 1 && canAddLines.value) form.lines.push(emptyLine())
  focusLineQuantity(idx)
}

/** Lines can still be added and saved: a draft or a confirmed order. */
const canAddLines = computed(() => !readonly.value && ['draft', 'confirmed'].includes(orderStatus.value))

const linesRef = ref<HTMLElement>()
/** Deferred past the article search closing (and a picker dialog handing focus back). */
function focusLineQuantity(idx: number) {
  setTimeout(() => {
    const line = form.lines[idx]
    if (!line) return
    const input = linesRef.value?.querySelector<HTMLInputElement>(`[data-line-qty="${CSS.escape(customerLineNodeId(line, idx))}"] input`)
    if (!input || input.readOnly) return
    input.focus()
    try { input.select() } catch { /* a number input may refuse select() */ }
  }, 200)
}

// ── the lines as a tree (FR-28.44) ──
// What a row is and what a line adds up to is the node model's (`composables/order-tree/customer-order-tree.ts`), rebuilt
// from the form's lines, the reservations and what the server derives per saved line; what its cells say is
// `composables/order-form/customer-tree-view.ts`. Nothing here is staged: a reservation is made, changed and released
// AT ONCE, each with its own dialog.
const linesPanelRef = ref<any>(null)
const treeRef = ref<any>(null)
/** The cover and generate dialogs (`ShortageDialogs`). */
const shortages = ref<{ openCoverDialog(): void; openCoverFor(lineId: string, section: 'stock' | 'order'): void; openGenerateDialog(lineId?: string): Promise<void> } | null>(null)

const tree = computed(() => buildCustomerOrderTree(form.lines, reservations.value, {
  readonly: readonly.value,
  canReserve: canReserve.value,
  requestedDeliveryDate: form.requestedDeliveryDate,
  server: lineFigures.value,
}))
/** A closed order shows no blank line waiting for an article. */
const shownNodes = computed(() => readonly.value
  ? tree.value.nodes.filter((n) => { const l = form.lines[n.source.lineIndex!]; return !!(l?.productId || l?.description) })
  : tree.value.nodes)
function lineOf(node: TreeNode): LineRow { return form.lines[node.source.lineIndex!] }

const treeColumns = computed(() => customerTreeColumns(t, isEdit.value))
const invoicedAndDelivered = (f: { invoiced: number; dispatched: number }) => invoicedAndDeliveredOf(t, f)
const statusChips = (node: TreeNode, open: boolean) => customerStatusChips(t, node, open)
const actionIcon = customerActionIcon
const actionColor = customerActionColor
const actionTitle = (type: TreeActionType) => customerActionTitle(t, type)

/** The reservation the way the server has it: the dialogs and the repeat call take that, not the row. */
function rawReservation(node: TreeNode) {
  return reservations.value.find((r) => String(r._id) === node.reservation?.resId)
}
function onAction(node: TreeNode, type: TreeActionType) {
  if (type === 'remove') { form.lines.splice(node.source.lineIndex!, 1); return }
  const raw = rawReservation(node)
  if (!raw) return
  if (type === 'editQuantity') openResEdit(raw)
  else if (type === 'release') openRelease(raw)
  else if (type === 'reserveAgain') reserveAgain(raw)
}
/** + Reserve on a line: where the goods come from. Each source opens the dialog that already made that reservation, for this line. */
function onReservePick(node: TreeNode, source: 'stock' | 'order' | 'generate') {
  const lineId = String(lineOf(node)?._id || '')
  if (!lineId) return
  if (source === 'generate') shortages.value?.openGenerateDialog(lineId)
  else shortages.value?.openCoverFor(lineId, source)
}

// ── FR-28.46: a link can name the line ──
// `…/internal-orders/:id/edit?line=<lineId>` opens the card and the line, scrolls to it and marks it for a moment.
// An id that matches nothing opens the form as usual.
async function applyDeepLink() {
  const lineId = String(route.query.line || '')
  if (!lineId) return
  const node = tree.value.index.get(`l:${lineId}`)
  if (!node) return
  linesPanelRef.value?.setOpen(true)
  await nextTick()
  await treeRef.value?.reveal(node.id, { openSelf: true, highlight: true })
}
watch(() => route.query.line, () => { applyDeepLink() })

const totalOrdered = computed(() => tree.value.totals.ordered)
const totalReserved = computed(() => tree.value.totals.reserved)
const totalDelivered = computed(() => tree.value.totals.delivered)
/** FR-28.43: the lines card, folded — how many lines, how much is needed, how much is reserved. */
const linesSummary = computed(() => {
  const totals = tree.value.totals
  return [t('invoicing.panels.lines', totals.lines), t('invoicing.panels.needed', { n: totals.ordered }), t('invoicing.panels.reserved', { n: totals.reserved })].join(' · ')
})
const estimatedTotal = computed(() => form.lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.expectedUnitPrice) || 0), 0))

// ── status pipeline + actions ──
const statusDef = computed<StatusDef | undefined>(() =>
  orderStatusDef(['draft', 'confirmed', 'delivered', 'completed'], orderStatus.value === 'partially_delivered' ? 'confirmed' : orderStatus.value, orderStatus.value))

const { printingId, printOrder } = useCustomerOrderPrint()
const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), icon: 'mdi-content-save', handler: onSave, loading: saving.value, show: !readonly.value && ['draft', 'confirmed'].includes(orderStatus.value), cap: isEdit.value ? ['orders.create', 'orders.edit'] : 'orders.create' },
  { label: t('invoicing.confirmOrder'), icon: 'mdi-check', color: 'success', handler: confirmOrder, show: isEdit.value && orderStatus.value === 'draft', cap: ['orders.create', 'orders.edit'] },
  { label: t('invoicing.convertToInvoice'), icon: 'mdi-swap-horizontal', color: 'info', handler: convertOrder, show: isEdit.value && ['confirmed', 'partially_delivered', 'delivered'].includes(orderStatus.value), cap: 'sales-docs.create' },
  { label: t('invoicing.completeOrder'), icon: 'mdi-check-all', variant: 'outlined', handler: completeOrder, show: isEdit.value && ['confirmed', 'partially_delivered', 'delivered'].includes(orderStatus.value), cap: ['orders.create', 'orders.edit'] },
  // The order's sheet for the client: any saved order, in any status, to whoever may export (the route's own gate).
  // After the order's own steps, as on a document; the one label given up where the bar would otherwise wrap.
  { key: 'print', label: t('common.print'), icon: 'mdi-printer', color: '', variant: 'outlined', handler: printSheet, loading: printingId.value !== '', show: isEdit.value, cap: 'sales-docs.export', testId: 'print-order', collapse: COLLAPSE.print },
  { label: t('invoicing.cancelOrder'), icon: 'mdi-cancel', color: 'error', variant: 'outlined', handler: cancelOrder, show: isEdit.value && ['draft', 'confirmed'].includes(orderStatus.value), cap: ['orders.create', 'orders.edit'] },
  { label: t('common.delete'), icon: 'mdi-delete', color: 'error', variant: 'text', handler: deleteOrder, show: isEdit.value && orderStatus.value === 'draft', cap: 'orders.delete' },
])

// ── pending changes ──
const { markSaved, markClean, tryRestore, isDirty, snapshot: snapshotPending } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'internal_order',
  icon: 'mdi-account-clock-outline',
  getFormData: () => JSON.parse(JSON.stringify(form)),
  getPreviewFields: () => [
    { label: t('common.date'), value: form.issueDate || '' },
    { label: t('invoicing.lineItems'), value: String(form.lines.length) },
  ],
  setFormData: (data) => Object.assign(form, data),
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

// ── persistence ──
function onSave() { return save() }

/** True when the order is stored as the form shows it. `quiet`: no toast of its own (an action follows and says its own). */
async function save(quiet = false): Promise<boolean> {
  const { valid } = (await formRef.value?.validate()) || { valid: true }
  if (!valid) return false
  if (!form.lines.some((l) => l.productId && (Number(l.quantity) || 0) > 0)) {
    refused(t('invoicing.linesRequired'))
    return false
  }
  saving.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoicing/internal-orders/${route.params.id}`, customerOrderBody(form))
      succeeded()
      if (!quiet) showSuccess(t('common.savedSuccessfully'))
      markSaved()
      await loadOrder()
      // It stays open on what it saved: an edit from here is unsaved again (FR-22.16, as the documents do).
      markClean()
    } else {
      const payload = customerOrderBody(form)
      const { data } = await createAttempt.run(payload, headers => httpClient.post(`${orgUrl()}/invoicing/internal-orders`, payload, { headers }))
      succeeded()
      if (!quiet) showSuccess(t('common.savedSuccessfully'))
      markSaved()
      router.replace({ name: 'invoicing.internalOrders.edit', params: { id: data.internalOrder._id } })
      orderNumber.value = data.internalOrder.orderNumber
      orderStatus.value = data.internalOrder.status
      await loadOrder(data.internalOrder._id)
      markClean()
    }
    return true
  } catch (e: any) {
    refused(reservationErrorMessage(e, t))
    return false
  } finally {
    saving.value = false
  }
}

const access = useAccess()
/** FR-27 `sales-docs.manual-price`: may this person TYPE a line's price (the invoice charges it, #695), or only pick one? */
const typesPrice = computed(() => access.can('sales-docs.manual-price'))
/** The order can still be saved, and by this person: the rule of the Save button (its status, and its capability). */
function canSaveOrder(): boolean {
  return canAddLines.value && access.can(isEdit.value ? ['orders.create', 'orders.edit'] : 'orders.create')
}

/**
 * What the form shows is what Confirm and Convert act on: an edit not saved yet (a price just chosen, a quantity) is
 * saved first, as Issue does on a document. Before, both acted on the stored order and the reload after them dropped
 * the edit without a word, so a price picked and converted at once was not the invoice's. False when the save was
 * refused: the action then does not run. An order that can no longer be edited, or that this person may not edit,
 * has nothing to save: the action runs on the stored order, as it always did.
 */
async function saveIfNeeded(): Promise<boolean> {
  if (!canSaveOrder() || !isDirty()) return true
  return save(true)
}

async function confirmOrder() {
  if (await saveIfNeeded()) await doAction('confirm', 'invoicing.orderConfirmed')
}

// ── „Печат": the order's sheet ──
/** The sheet prints what is stored, so an unsaved edit is saved first, as the documents' „Печат" does. */
async function printSheet() {
  if (!(await saveIfNeeded())) return
  await printOrder({ _id: route.params.id as string, number: orderNumber.value })
}

async function convertOrder() {
  if (!(await saveIfNeeded())) return
  loading.value = true
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/internal-orders/${route.params.id}/convert`)
    // The message says what stays reserved on supplier orders; it outlives the move.
    conversion.converted(data)
    // FR-22.35: the user lands on the new draft invoice, which issues and prints from its own form.
    await router.push({ name: 'invoicing.sales.edit', params: { id: String(data.invoice._id || data.invoice.id) } })
  } catch (e: any) {
    conversion.failed(e)
  } finally {
    loading.value = false
  }
}

// ── reservations toolbox ──
const reserving = ref(false)
async function reserveAvailable() {
  reserving.value = true
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/internal-orders/${route.params.id}/reserve-available`, {})
    // FR-22.43: what stock could not cover is named, line by line — „no shortages" was the answer
    // even when nothing at all was free.
    const created = data.created?.length || 0
    const lines = (data.short || []).map((s: any) => t('invoicing.shortLine', {
      name: form.lines.find((l) => String(l._id) === String(s.lineId))?.description || '—',
      missing: s.missing,
    })).join(', ')
    if (lines) showSnackbar(created ? t('invoicing.reservedFromStockShort', { count: created, lines }) : t('invoicing.nothingFreeFor', { lines }), 'warning', 8000)
    else if (created) showSuccess(t('invoicing.reservedFromStock', { count: created }))
    else showSuccess(t('invoicing.noShortages'))
    await refreshReservations()
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    reserving.value = false
  }
}

// A release goes through the list's dialog — „Не" / „Освободи резервацията", all or part of it —
// never a browser confirm() whose „OK" / „Отказ" both read as cancelling.
const releaseDialog = ref(false)
const releasing = ref<any>(null)
function openRelease(res: any) {
  releasing.value = res
  releaseDialog.value = true
}

// ── loading ──
async function loadOrder(id?: string) {
  loadStarted()
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/internal-orders/${id || route.params.id}`)
    const o = data.internalOrder
    orderStatus.value = o.status
    orderNumber.value = o.orderNumber
    form.contactId = String(o.contactId || '')
    form.issueDate = o.issueDate?.split('T')[0] || ''
    form.requestedDeliveryDate = o.requestedDeliveryDate?.split('T')[0] || ''
    form.priority = o.priority || 'normal'
    form.warehouseId = o.warehouseId ? String(o.warehouseId) : ''
    form.currency = o.currency || baseCurrency.value
    form.exchangeRate = o.exchangeRate || 1
    form.notes = o.notes || ''
    form.terms = o.terms || ''
    form.tags = o.tags || []
    form.lines = customerLinesFrom(o.lines)
    // FR-22.43: a blank line waits for the next article while lines can still be added.
    if (canAddLines.value) form.lines.push(emptyLine())
    lineFigures.value = figuresByLine(o.lines)
    takeReservations(data)
    if (form.contactId && contactNames.value[form.contactId] && !clientOptions.value.some((c: any) => c._id === form.contactId)) {
      clientOptions.value = [{ _id: form.contactId, companyName: contactNames.value[form.contactId] }, ...clientOptions.value]
    }
    // FR-22.13: what was just loaded is the clean state. The composable's own snapshot ran on a
    // 500 ms timer from mount (until FR-31.2), so a slower load counted as an edit, and so did every reload after
    // Confirm, Complete or Convert: leaving an untouched order asked to keep „Незапазени промени".
    snapshotPending()
  } catch (e) {
    loadFailed(e)
  }
}

onMounted(async () => {
  await Promise.all([fetchContacts('client'), fetchWarehouses()])
  if (tryRestore()) return
  if (isEdit.value) {
    await loadOrder()
    await nextTick()
    await applyDeepLink()
  } else fetchPeekedNumber()
})
</script>
