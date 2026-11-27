<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editOrder') : $t('invoicing.newOrder')"
    :subtitle="documentNumber"
    :status="statusDef"
    :actions="formActions"
    :loading="loading"
    :load-error="loadError"
    :refusal="refusal"
    @retry="loadOrder()"
    @dismiss-refusal="dismissRefusal"
    back-to="/orders"
    :back-label="$t('nav.externalOrders')"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
  >
    <!-- FR-28.32 (D-14): the same banner as the documents', without the organization's name and the
         title the shell's <h1> already carries. -->
    <template #document-header>
      <DocumentBanner :number="documentNumber" :status="$t(`invoicing.status.${orderStatus}`)" />
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
          <v-col cols="6" sm="3" md="2">
            <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :readonly="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-text-field v-model="form.expectedDate" :label="$t('invoicing.expectedDate')" type="date" clearable :readonly="readonly" />
          </v-col>
          <v-col cols="6" sm="3" md="2">
            <v-select v-model="form.currency" :label="$t('common.currency')" :items="currencyOptions" :readonly="readonly" />
          </v-col>
        </v-row>

        <!-- Supplier groups -->
        <div v-for="(group, gi) in form.supplierGroups" :key="group._id || gi" class="mt-4">
          <!-- FR-28.43: a supplier's card folds away, and says what it holds while it is folded. A group
               with no supplier chosen keeps a flag on its header, so closing it cannot hide why a save
               is refused. -->
          <CollapsiblePanel
            :ref="(el: any) => setPanelRef(gi, el)"
            screen="orders.edit"
            :panel-id="`group-${group._id || `new${gi}`}`"
            :summary="groupSummary(gi)"
            :flag="group.supplierId ? undefined : $t('invoicing.panels.supplierMissing')"
            data-testid="order-group"
          >
            <template #title>
              <v-icon size="20" color="primary">mdi-factory</v-icon>
              <div style="min-width: 260px; max-width: 380px" class="flex-grow-1 d-flex align-center ga-1">
                <v-autocomplete
                  v-model="group.supplierId"
                  :items="supplierOptions"
                  item-title="companyName"
                  item-value="_id"
                  :label="$t('invoicing.supplier')"
                  :rules="[rules.required]"
                  no-filter
                  hide-details
                  class="flex-grow-1"
                  :readonly="readonly"
                  :loading="loadingContacts"
                  @update:search="(s: string) => onContactSearch(s, 'supplier')"
                />
                <v-btn v-if="!readonly" icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.searchContact')" :aria-label="$t('invoicing.searchContact')" @click="openContactPicker({ kind: 'supplier', gi })" />
              </div>
              <v-text-field v-model="group.reference" :label="$t('invoicing.reference')" hide-details style="max-width: 200px" :readonly="readonly" />
            </template>
            <template #actions>
              <!-- FR-28.42: open or close every row of this supplier at once. -->
              <v-btn size="x-small" variant="text" icon="mdi-unfold-more-horizontal" :title="$t('invoicing.tree.expandAll')" :aria-label="$t('invoicing.tree.expandAll')" data-testid="tree-expand-all" @click="treeRefs[gi]?.expandAll()" />
              <v-btn size="x-small" variant="text" icon="mdi-unfold-less-horizontal" :title="$t('invoicing.tree.collapseAll')" :aria-label="$t('invoicing.tree.collapseAll')" data-testid="tree-collapse-all" @click="treeRefs[gi]?.collapseAll()" />
              <v-menu v-if="isEdit && group._id">
                <template #activator="{ props: mp }">
                  <v-btn v-bind="mp" size="small" variant="outlined" prepend-icon="mdi-download">{{ $t('common.export') }}</v-btn>
                </template>
                <v-list density="compact">
                  <v-list-subheader>{{ $t('invoicing.exportSupplierSheet') }}</v-list-subheader>
                  <v-list-item prepend-icon="mdi-file-excel" title="Excel" @click="exportGroup(group, 'supplier', 'xlsx')" />
                  <v-list-item prepend-icon="mdi-file-pdf-box" title="PDF" @click="exportGroup(group, 'supplier', 'pdf')" />
                  <v-divider />
                  <v-list-subheader>{{ $t('invoicing.exportInternalSheet') }}</v-list-subheader>
                  <v-list-item prepend-icon="mdi-file-excel" title="Excel" @click="exportGroup(group, 'internal', 'xlsx')" />
                  <v-list-item prepend-icon="mdi-file-pdf-box" title="PDF" @click="exportGroup(group, 'internal', 'pdf')" />
                </v-list>
              </v-menu>
              <v-btn v-if="!readonly" icon="mdi-close" size="small" variant="text" color="error" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="removeGroup(gi)" />
            </template>
            <v-card-text class="pa-2">
              <!-- FR-28.39: the supplier's lines as one tree — line, warehouse, client reservation — in one set of
                   columns, a parent carrying what its children add up to, so folding a level loses nothing. The
                   rows say what they say here (the editors are the form's own fields); what they are, what they
                   add up to and what opens by itself is the node model's (`composables/order-tree`). -->
              <OrderTree
                :ref="(el: any) => setTreeRef(gi, el)"
                :nodes="tree.groups[gi]?.nodes || []"
                :columns="treeColumns"
              >
                <template #item="{ node }">
                  <!-- The article: the line's own search and picker, as they were. From the top: the button stays
                       beside the field, not beside the field and its chip. -->
                  <div v-if="node.kind === 'line'" class="d-flex align-start ga-1 flex-grow-1" style="min-width: 0">
                    <ProductLineDescription
                      :description="lineOf(node).description"
                      :product-id="lineOf(node).productId"
                      :known="knownOf(lineOf(node).productId)"
                      price-field="purchasePrice"
                      class="flex-grow-1"
                      style="min-width: 0"
                      @update:description="lineOf(node).description = $event"
                      @update:product-id="lineOf(node).productId = $event"
                      @product-selected="onProductSelected(lineOf(node), $event)"
                      @product-cleared="lineOf(node).productId = undefined"
                      @details="openProductPicker(node.source.groupIndex, node.source.lineIndex!, $event)"
                    />
                    <ProductDetailsButton @click="openProductPicker(node.source.groupIndex, node.source.lineIndex!)" />
                  </div>
                  <!-- A warehouse the line is allocated to. -->
                  <template v-else-if="node.kind === 'allocation'">
                    <v-icon size="16" color="medium-emphasis" class="me-2 flex-shrink-0">mdi-warehouse</v-icon>
                    <v-autocomplete
                      v-if="!readonly"
                      v-model="allocOf(node).warehouseId"
                      :items="warehouses"
                      item-title="name"
                      item-value="_id"
                      :aria-label="$t('warehouse.warehouse')"
                      density="compact"
                      variant="underlined"
                      hide-details
                    />
                    <span v-else class="text-body-2">{{ node.label }}</span>
                  </template>
                  <!-- A client's reservation: who, its number and the customer order it serves, as links. -->
                  <div v-else-if="node.kind === 'reservation' && node.reservation" class="d-flex align-center flex-wrap gc-3 text-body-2" style="min-width: 0">
                    <span :class="node.reservation.cancelled ? 'text-decoration-line-through text-medium-emphasis' : ''" :title="node.label">{{ node.label }}</span>
                    <EntityLink v-if="node.reservation.number && node.reservation.resId" class="text-no-wrap flex-shrink-0" :label="node.reservation.number" :to="{ name: 'invoicing.reservations.detail', params: { id: String(node.reservation.resId) } }" />
                    <EntityLink v-if="node.reservation.internalOrderId" class="text-no-wrap flex-shrink-0" :label="internalOrderNumbers[node.reservation.internalOrderId] || '…'" :to="{ name: 'invoicing.internalOrders.edit', params: { id: node.reservation.internalOrderId }, query: internalOrderLineQuery(node.reservation) }" />
                  </div>
                  <!-- The row being added (FR-28.40): Enter adds it, Escape drops it. -->
                  <div v-else-if="node.editing" data-tree-editor class="d-flex align-center ga-1 flex-grow-1" style="min-width: 0" @keydown.capture="onEditorKeydown">
                    <v-autocomplete
                      v-if="node.placeholderOf === 'allocation'"
                      v-model="draft.warehouseId"
                      v-model:menu="draft.menu"
                      :items="warehouses"
                      item-title="name"
                      item-value="_id"
                      :label="$t('warehouse.warehouse')"
                      density="compact"
                      variant="underlined"
                      hide-details="auto"
                      auto-select-first
                      :error-messages="draftMessages.warehouse"
                      @update:model-value="focusDraftQuantity"
                    />
                    <template v-else>
                      <v-autocomplete
                        v-model="draft.contactId"
                        v-model:menu="draft.menu"
                        :items="clientOptions"
                        item-title="companyName"
                        item-value="_id"
                        :label="$t('invoicing.customer')"
                        density="compact"
                        variant="underlined"
                        hide-details="auto"
                        no-filter
                        auto-select-first
                        :loading="loadingContacts"
                        :error-messages="draftMessages.client"
                        @update:search="(s: string) => onContactSearch(s, 'client')"
                        @update:model-value="focusDraftQuantity"
                      />
                      <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.searchContact')" :aria-label="$t('invoicing.searchContact')" @click="openContactPicker({ kind: 'draftClient' })" />
                    </template>
                  </div>
                  <!-- Nothing below this row yet. -->
                  <span v-else class="text-caption text-medium-emphasis ps-1">{{ $t(node.placeholderOf === 'allocation' ? 'invoicing.tree.noWarehouse' : 'invoicing.tree.noClients') }}</span>
                </template>

                <template #cells="{ node, open, hidden, span }">
                  <!-- An empty parent: one cell, with its +. -->
                  <template v-if="node.kind === 'placeholder' && !node.editing">
                    <td :colspan="span - 1" class="text-end">
                      <v-btn
                        v-for="a in node.actions"
                        :key="a.type"
                        size="x-small"
                        variant="text"
                        color="primary"
                        :disabled="a.disabled"
                        :data-testid="`tree-${a.type}`"
                        @click="onAction(node, a.type)"
                      >{{ actionText(a.type) }}</v-btn>
                    </td>
                  </template>
                  <!-- The row being added: its quantity under Qty, and what it needs beside it. -->
                  <template v-else-if="node.kind === 'placeholder'">
                    <td data-col="qty" @keydown.capture="onEditorKeydown">
                      <v-text-field
                        v-model.number="draft.quantity"
                        type="number"
                        min="0"
                        density="compact"
                        variant="underlined"
                        hide-details="auto"
                        data-tree-editor-qty
                        class="order-tree__num"
                        :aria-label="$t('invoicing.qty')"
                        :error-messages="draftMessages.qty"
                      />
                    </td>
                    <td :colspan="span - 2" @keydown.capture="onEditorKeydown">
                      <div class="d-flex align-center ga-2 flex-wrap line-grid__line">
                        <v-btn size="x-small" color="primary" variant="flat" data-testid="tree-add" @click="commitAdding">{{ $t('common.add') }}</v-btn>
                        <v-btn size="x-small" variant="text" data-testid="tree-add-cancel" @click="cancelAdding">{{ $t('common.cancel') }}</v-btn>
                        <span class="text-caption text-medium-emphasis">{{ $t('invoicing.tree.enterAdds') }}</span>
                      </div>
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
                      <v-text-field
                        v-else-if="node.kind === 'allocation'"
                        v-model.number="allocOf(node).quantity"
                        type="number"
                        min="0"
                        class="order-tree__num"
                        density="compact"
                        hide-details
                        variant="underlined"
                        :aria-label="$t('invoicing.qty')"
                        :readonly="readonly"
                      />
                      <template v-else-if="node.reservation">
                        <v-text-field
                          v-if="node.reservation.editable"
                          :model-value="node.reservation.quantity"
                          type="number"
                          :min="node.reservation.consumed"
                          class="order-tree__num"
                          density="compact"
                          hide-details
                          variant="underlined"
                          :aria-label="node.reservation.number ? `${$t('invoicing.qty')} ${node.reservation.number}` : $t('invoicing.qty')"
                          @update:model-value="(v: any) => setRowQuantity(node.reservation!, Number(v))"
                        />
                        <span v-else class="d-block text-end" :class="node.reservation.cancelled ? 'text-decoration-line-through text-medium-emphasis' : ''">{{ node.reservation.quantity }}</span>
                      </template>
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
                      <v-text-field
                        v-if="node.kind === 'line'"
                        v-model.number="lineOf(node).expectedUnitPrice"
                        type="number"
                        step="0.0001"
                        min="0"
                        class="order-tree__num"
                        density="compact"
                        hide-details
                        variant="underlined"
                        :aria-label="$t('invoicing.expectedPrice')"
                        :readonly="readonly"
                      />
                    </td>
                    <td class="text-end" data-col="reserved">{{ node.kind === 'reservation' ? '' : node.figures.reserved }}</td>
                    <td class="text-end" data-col="free">{{ node.figures.free ?? '' }}</td>
                    <template v-if="isEdit">
                      <td class="text-end" data-col="received">
                        <span v-if="node.figures.received !== null" :class="node.kind === 'line' && node.figures.received >= node.figures.quantity && node.figures.quantity > 0 ? 'text-success' : ''">{{ node.figures.received }}</span>
                      </td>
                      <!-- Dispatched is a column of its own while there is room; when there is not, its figure is the tooltip of Invoiced. -->
                      <td class="text-end" data-col="invoiced" :title="hidden.has('dispatched') ? invoicedAndDispatched(node.figures) : undefined">{{ node.figures.invoiced }}</td>
                      <td v-if="!hidden.has('dispatched')" class="text-end" data-col="dispatched">{{ node.figures.dispatched }}</td>
                    </template>
                    <td data-col="status">
                      <div class="d-flex flex-wrap align-center ga-1 line-grid__line">
                        <v-chip v-for="c in statusChips(node, open)" :key="c.key" size="x-small" :label="c.label" :variant="c.variant || 'tonal'" :color="c.color" :title="c.text">{{ c.text }}</v-chip>
                      </div>
                    </td>
                    <td class="text-no-wrap text-end" data-col="actions">
                      <template v-for="a in node.actions" :key="a.type">
                        <v-btn
                          v-if="a.type === 'addWarehouse' || a.type === 'addClient'"
                          size="x-small"
                          variant="text"
                          color="primary"
                          :disabled="a.disabled"
                          :data-testid="`tree-${a.type}`"
                          @click="onAction(node, a.type)"
                        >{{ actionText(a.type) }}</v-btn>
                        <v-btn
                          v-else
                          size="x-small"
                          variant="text"
                          :icon="actionIcon(a.type)"
                          :color="a.type === 'changeClient' || a.type === 'undo' ? undefined : 'error'"
                          :title="actionTitle(a.type)"
                          :aria-label="actionTitle(a.type)"
                          :data-testid="`tree-${a.type}`"
                          @click="onAction(node, a.type)"
                        />
                      </template>
                    </td>
                  </template>
                </template>

                <!-- This supplier's totals, in the columns above. -->
                <template #totals="{ hidden }">
                  <td data-col="item">{{ $t('invoicing.tree.totalsOf') }}</td>
                  <td class="text-end" data-col="qty">{{ tree.groups[gi]?.figures.ordered }}</td>
                  <td data-col="unit"></td>
                  <td data-col="price"></td>
                  <td class="text-end" data-col="reserved">{{ tree.groups[gi]?.figures.reserved }}</td>
                  <td data-col="free"></td>
                  <template v-if="isEdit">
                    <td class="text-end" data-col="received">{{ tree.groups[gi]?.figures.received }}</td>
                    <td class="text-end" data-col="invoiced" :title="hidden.has('dispatched') && tree.groups[gi] ? invoicedAndDispatched(tree.groups[gi].figures) : undefined">{{ tree.groups[gi]?.figures.invoiced }}</td>
                    <td v-if="!hidden.has('dispatched')" class="text-end" data-col="dispatched">{{ tree.groups[gi]?.figures.dispatched }}</td>
                  </template>
                  <td data-col="status"></td>
                  <td data-col="actions"></td>
                </template>
              </OrderTree>
              <v-btn v-if="!readonly" color="primary" variant="text" size="small" prepend-icon="mdi-plus" class="mt-1" @click="group.lines.push(emptyLine())">
                {{ $t('invoicing.addLine') }}
              </v-btn>
            </v-card-text>
          </CollapsiblePanel>
        </div>

        <v-btn v-if="!readonly" color="primary" variant="outlined" prepend-icon="mdi-factory" class="mt-4" @click="addGroup">
          {{ $t('invoicing.addSupplier') }}
        </v-btn>

        <SupplierReservationsCard
          v-if="isEdit"
          :reservations="reservations"
          :cancels="staged.cancels"
          :has-staged="hasStaged"
          :readonly="readonly"
          :contact-names="contactNames"
          :internal-order-numbers="internalOrderNumbers"
          :warehouse-name="warehouseName"
          :line-description="allocLineDescription"
          :staged-repeat="stagedRepeat"
          @toggle-cancel="toggleCancel"
          @stage-repeat="stageRepeat"
        />
        <OrderInvoicesCard v-if="isEdit" screen="orders.edit" :invoices="linkedInvoices" :contacts="contactNames" :currency="form.currency || baseCurrency" :locale-code="localeCode" />

        <OrderFormFooter
          v-model:notes="form.notes"
          v-model:terms="form.terms"
          v-model:tags="form.tags"
          tag-type="order"
          :org-url="orgUrl()"
          :readonly="readonly"
          :is-edit="isEdit"
          :saving="saving"
          :ordered="totalOrdered"
          :reserved="totalReserved"
          moved-label="invoicing.receivedQty"
          :moved="totalReceived"
          :total="fmtCurrency(estimatedTotal)"
          @save="onSave"
        />
      </v-defaults-provider>
    </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="order" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ProductPickerDialog
      v-model="productPickerOpen"
      :org-url="orgUrl()"
      :base-currency="baseCurrency"
      :locale="localeCode"
      multiple
      price-field="purchasePrice"
      :existing-product-ids="existingProductIds"
      :initial-search="productPickerText"
      @select-many="onProductsPicked"
    />
    <ContactPickerDialog v-model="contactPickerOpen" :org-url="orgUrl()" :type="contactPickerTarget?.kind === 'supplier' ? 'supplier' : 'customer'" @select="onContactPicked" />

    <ClientChangeDialog
      :state="reserveDialog"
      :client-options="clientOptions"
      :loading-contacts="loadingContacts"
      :warehouse-name="warehouseName"
      @search="(s: string) => onContactSearch(s, 'client')"
      @find="openContactPicker({ kind: 'client' })"
      @submit="submitReservation"
    />
    <ConvertToInvoicesDialog v-model="convertDialog" :reservations="reservations" :contact-names="contactNames" :order-id="route.params.id as string" :reload="() => loadOrder()" />

    <!-- FR-22.41: what Cancel or Complete releases, asked before it happens. -->
    <OrderCascadeDialog
      v-model="cascade.open"
      side="supplier"
      :title="$t(cascade.action === 'cancel' ? 'invoicing.cascade.cancelSupplierTitle' : 'invoicing.cascade.completeSupplierTitle', { number: documentNumber })"
      :summary="cascadeNow"
      :confirm-label="cascade.action === 'cancel' ? $t('invoicing.cancelOrder') : $t('invoicing.completeOrder')"
      :confirm-color="cascade.action === 'cancel' ? 'error' : 'primary'"
      :loading="cascade.busy"
      :error="cascade.error"
      :staged-lost="hasStaged"
      @confirm="confirmCascade"
    />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { createOrder, exportOrderGroup, getOrder, supplierOrderRoutes, updateOrder } from '../api/orders'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { cursorWherePickLeft } from 'ui-shared/composables/pick-cursor'
import { triggerBlobDownload } from 'ui-shared/composables/useInvoicingExport'
import { upsertAmountInWords } from 'config/amount-in-words'
import EntityFormShell, { type FormAction, type StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ProductDetailsButton from 'ui-shared/components/ProductDetailsButton.vue'
import LineUnitSelect from 'ui-shared/components/LineUnitSelect.vue'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import ProductLineDescription from '../components/ProductLineDescription.vue'
import OrderCascadeDialog from '../components/OrderCascadeDialog.vue'
import OrderInvoicesCard from '../components/OrderInvoicesCard.vue'
import DocumentBanner from '../components/document-form/DocumentBanner.vue'
import OrderTree from '../components/order-tree/OrderTree.vue'
import OrderFormFooter from '../components/order-form/OrderFormFooter.vue'
import SupplierReservationsCard from '../components/order-form/SupplierReservationsCard.vue'
import ClientChangeDialog from '../components/order-form/ClientChangeDialog.vue'
import ConvertToInvoicesDialog from '../components/order-form/ConvertToInvoicesDialog.vue'
import { reservationErrorMessage } from '../composables/reservation-errors'
import { internalOrderLineQuery } from '../composables/order-tree/links'
import { buildSupplierOrderTree, createOrderFigures, lineNodeId } from '../composables/order-tree/supplier-order-tree'
import type { TreeActionType, TreeNode } from '../composables/order-tree/types'
import { useOrderFormBase } from '../composables/order-form/useOrderFormBase'
import { fillPickedLines, orderStatusDef } from '../composables/order-form/shared'
import { emptyGroup, emptyLine, supplierGroupsFrom, supplierOrderBody, type AllocRow, type GroupRow, type LineRow } from '../composables/order-form/supplier-order'
import { useStagedReservations } from '../composables/order-form/useStagedReservations'
import { useAddingRow } from '../composables/order-form/useAddingRow'
import {
  invoicedAndDispatched as invoicedAndDispatchedOf, supplierActionIcon, supplierActionText, supplierActionTitle, supplierStatusChips, supplierTreeColumns,
} from '../composables/order-form/supplier-tree-view'

// The supplier order (ORDO). What it shares with the customer order's form is `useOrderFormBase` and
// `components/order-form` (FR-32.23); what is its own is here and in `composables/order-form`.
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const {
  loadError, refusal, loadStarted, loadFailed, refused, succeeded, dismissRefusal, showSuccess, showError, uomOptions,
  isEdit, formRef, loading, saving, orderStatus, orderNumber, documentNumber, readonly, baseCurrency, localeCode, rules, orgUrl, fmtCurrency,
  reservations, linkedInvoices, linkedOrderNumbers: internalOrderNumbers, clientOptions, supplierOptions, loadingContacts, contactNames,
  knownProducts, knownOf, onContactSearch, fetchContacts, withKnown, adoptContact, warehouses, fetchWarehouses, warehouseName,
  createAttempt, fetchPeekedNumber, deleteOrder, doAction, cascade, cascadeNow, cancelOrder, completeOrder, confirmCascade,
} = useOrderFormBase({
  routes: supplierOrderRoutes,
  listRoute: 'invoicing.orders',
  side: 'supplier',
  deleteConfirmKey: 'invoicing.deleteOrderConfirm',
  readonlyStatuses: ['completed', 'cancelled'],
  currency: () => form.currency,
  knownContactIds: (pool) => pool === 'supplier'
    ? form.supplierGroups.map((g) => g.supplierId)
    : reservations.value.map((r) => (r.contactId ? String(r.contactId) : '')),
  // A completed or cancelled order is read-only, so what was staged on it can never be saved.
  // After Send the order stays open and the staged changes stay with it.
  reload: (path) => loadOrder(undefined, { clearStaged: path === 'complete' || path === 'cancel' }),
  // FR-22.41: a cancelled order says whose client orders lost their reservations.
  actionSaid: (data) => {
    const affected = (data?.affectedInternalOrders || []).map((o: any) => o.orderNumber).filter(Boolean)
    return affected.length ? t('invoicing.cascade.cancelledReleased', { numbers: affected.join(', ') }) : undefined
  },
  // Complete asks also when reservation changes are staged: a completed order is read-only, so they would be dropped.
  completeAsks: () => hasStaged.value,
})

const currencyOptions = computed(() => [...new Set([baseCurrency.value, 'EUR', 'BGN', 'USD', 'GBP'])])

const form = reactive({
  issueDate: new Date().toISOString().split('T')[0],
  expectedDate: '',
  currency: baseCurrency.value,
  exchangeRate: 1,
  notes: '',
  terms: '',
  tags: [] as string[],
  supplierGroups: [emptyGroup()] as GroupRow[],
})

// ── picker dialogs (wide server-searched tables, same pattern as the invoice forms) ──
const productPickerOpen = ref(false)
const productPickerTarget = ref<{ gi: number; li: number } | null>(null)
/** FR-28.25: what the user had typed in the line's field when they asked for Details (F4, "Show all N results"). */
const productPickerText = ref('')
/** FR-28.28: the articles already on the order are marked in the dialog, not hidden from it. */
const existingProductIds = computed(() => form.supplierGroups.flatMap((g) => g.lines.map((l) => String(l.productId || ''))).filter(Boolean))
function openProductPicker(gi: number, li: number, text = '') {
  productPickerTarget.value = { gi, li }
  productPickerText.value = text
  productPickerOpen.value = true
}
/** FR-28.28: several articles at once, from the line the dialog was opened from, on the lines of the same supplier. */
function onProductsPicked(ps: any[]) {
  const at = productPickerTarget.value
  if (!at || !ps.length) return
  const lines = form.supplierGroups[at.gi]?.lines
  if (!lines) return
  fillPickedLines(lines, at.li, ps, emptyLine, (line, p) => {
    line.productId = p._id
    line.description = p.name
    onProductSelected(line, p)
  })
}

type ContactPickTarget = { kind: 'supplier'; gi: number } | { kind: 'client' } | { kind: 'draftClient' }
const contactPickerOpen = ref(false)
const contactPickerTarget = ref<ContactPickTarget | null>(null)
function openContactPicker(target: ContactPickTarget) {
  contactPickerTarget.value = target
  contactPickerOpen.value = true
}
function onContactPicked(c: any) {
  const at = contactPickerTarget.value
  if (!at) return
  const id = adoptContact(c, at.kind === 'supplier' ? 'supplier' : 'client')
  if (!id) return
  if (at.kind === 'supplier') {
    const group = form.supplierGroups[at.gi]
    if (group) group.supplierId = id
  } else if (at.kind === 'draftClient') draft.contactId = id
  else reserveDialog.contactId = id
}

// ── line helpers ──
function onProductSelected(line: LineRow, product: any) {
  line.unit = product.unit || line.unit
  line.sku = product.sku
  if (!line.expectedUnitPrice) line.expectedUnitPrice = product.purchasePrice || undefined
  if (!line.quantity) line.quantity = 1
  focusLineQuantity(line)
}
/**
 * FR-28.27: after a pick the cursor goes to the line's quantity, deferred past the search closing (and a dialog
 * handing focus back). Only while the cursor is still where the pick left it (`ui-shared` `pick-cursor.ts`): on this
 * line's row, nowhere, or in Details while it leaves (#974). A user who has already moved on to another field keeps
 * it. The quantity field says which line it belongs to (`data-line-qty`).
 */
function focusLineQuantity(line: LineRow) {
  if (typeof document === 'undefined') return
  setTimeout(() => {
    const gi = form.supplierGroups.findIndex((g) => g.lines.includes(line))
    if (gi < 0) return
    const id = lineNodeId(line, gi, form.supplierGroups[gi].lines.indexOf(line))
    const input = document.querySelector<HTMLInputElement>(`[data-line-qty="${CSS.escape(id)}"] input`)
    if (!input || input.disabled || input.readOnly) return
    const row = input.closest('tr')
    if (!cursorWherePickLeft(document.activeElement, document.body, (el) => !!row?.contains(el))) return
    input.focus()
    try { input.select() } catch { /* a number input may refuse select() */ }
  }, 200)
}

// ── #203: client reservations staged in the form, saved with the order (`reservationChanges`) ──
const {
  staged, hasStaged, clearStaged, setRowQuantity, removeRow, toggleCancel, stagedRepeat, stageRepeat, reservationChangesPayload,
  reserveDialog, openClientChange, submitReservation,
} = useStagedReservations({ reservations, allocations: allAllocations, allocFree, showError, t })

// ── FR-28.37: ONE set of figures, and the tree built from it ──
/**
 * Every number on this screen — a row's Reserved and Free, a supplier's summary, the Totals card — comes
 * from here, over the lines and allocations as edited, the reservations the server returned and what is
 * staged. The Totals card used to add up only the server's reservations while each allocation's Free
 * counted the staged ones too, so the two disagreed from the first reservation staged until Save.
 */
const figures = computed(() => createOrderFigures({ reservations: reservations.value, staged, readonly: readonly.value }))
const tree = computed(() => buildSupplierOrderTree(form.supplierGroups, {
  figures: figures.value,
  labels: { warehouse: (id: string) => warehouseName(id), contact: (id: string) => contactNames.value[id] || '—' },
  readonly: readonly.value,
  adding: adding.value,
}))
function allocFree(alloc: AllocRow) { return figures.value.allocation(alloc).free ?? 0 }
function allAllocations(): AllocRow[] {
  return form.supplierGroups.flatMap(g => g.lines.flatMap(l => l.allocations))
}
function allocLineDescription(allocationId: string) {
  for (const g of form.supplierGroups) for (const l of g.lines) if (l.allocations.some(a => String(a._id) === String(allocationId))) return l.description
  return '—'
}
function addGroup() { form.supplierGroups.push(emptyGroup()) }
function removeGroup(gi: number) { form.supplierGroups.splice(gi, 1); adding.value = null }

// The Totals card reads the tree's own figures (FR-28.37): a reservation staged on the form counts here at
// once, as it does on its warehouse. It used to add up only what the server had.
const totalOrdered = computed(() => tree.value.totals.ordered)
const totalReceived = computed(() => tree.value.totals.received)
const totalReserved = computed(() => tree.value.totals.reserved)

/**
 * FR-28.43: one supplier's card, folded: how many lines, how much is ordered and how much of it is reserved. The
 * tree's own figures, so it says what the open card adds up to, staged reservations included.
 */
function groupSummary(gi: number): string {
  const f = tree.value.groups[gi]?.figures
  if (!f) return ''
  return [t('invoicing.panels.lines', f.lines), t('invoicing.panels.ordered', { n: f.ordered }), t('invoicing.panels.reserved', { n: f.reserved })].join(' · ')
}
const estimatedTotal = computed(() =>
  form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.quantity) || 0) * (Number(l.expectedUnitPrice) || 0), 0), 0),
)

// ── FR-28.39: the tree on screen ──
// The rows are the form's own objects (`lineOf`, `allocOf`), edited in place; the tree is rebuilt from them.
// What the cells say is `composables/order-form/supplier-tree-view.ts`.
const treeColumns = computed(() => supplierTreeColumns(t, isEdit.value))
const invoicedAndDispatched = (f: { invoiced: number; dispatched: number }) => invoicedAndDispatchedOf(t, f)
const statusChips = (node: TreeNode, open: boolean) => supplierStatusChips(t, node, open)
const actionText = (type: TreeActionType) => supplierActionText(t, type)
const actionIcon = supplierActionIcon
const actionTitle = (type: TreeActionType) => supplierActionTitle(t, type)

/** One tree per supplier, and the card around it: kept so a link can open the card and the row. */
const treeRefs: Record<number, any> = {}
function setTreeRef(gi: number, el: any) { if (el) treeRefs[gi] = el; else delete treeRefs[gi] }
const panelRefs: Record<number, any> = {}
function setPanelRef(gi: number, el: any) { if (el) panelRefs[gi] = el; else delete panelRefs[gi] }

const lineOf = (node: TreeNode): LineRow => form.supplierGroups[node.source.groupIndex].lines[node.source.lineIndex!]
const allocOf = (node: TreeNode): AllocRow => lineOf(node).allocations[node.source.allocationIndex!]

function onAction(node: TreeNode, type: TreeActionType) {
  switch (type) {
    case 'addWarehouse':
    case 'addClient':
      // An empty parent's placeholder carries the same + as its parent.
      startAdding(node.kind === 'placeholder' ? tree.value.index.get(node.parentId || '') : node)
      break
    case 'remove':
      if (node.kind === 'line') form.supplierGroups[node.source.groupIndex].lines.splice(node.source.lineIndex!, 1)
      else lineOf(node).allocations.splice(node.source.allocationIndex!, 1)
      adding.value = null
      break
    case 'changeClient':
      if (node.reservation) openClientChange(node.reservation, lineOf(node), allocOf(node))
      break
    case 'cancel':
    case 'undo':
      if (node.reservation) removeRow(node.reservation)
      break
  }
}

// ── FR-28.40: + Warehouse and + Client are rows, not dialogs (`useAddingRow`) ──
const { adding, draft, draftMessages, startAdding, commitAdding, cancelAdding, onEditorKeydown, focusDraftQuantity } = useAddingRow({
  tree: () => tree.value,
  figures: () => figures.value,
  lineOf,
  allocOf,
  staged,
  openRow: (node) => treeRefs[node.source.groupIndex]?.setOpen(node.id, true),
  t,
})

// ── FR-28.46: a link can name the line, and the warehouse ──
// `?line=<lineId>&allocation=<allocationId>` opens the card, the line (and the warehouse), scrolls to it and marks
// it for a moment. An id that matches nothing opens the form as usual.
async function applyDeepLink() {
  const lineId = String(route.query.line || '')
  if (!lineId) return
  const lineNode = tree.value.index.get(`l:${lineId}`)
  if (!lineNode) return
  const gi = lineNode.source.groupIndex
  const allocId = String(route.query.allocation || '')
  const allocNode = allocId ? tree.value.index.get(`a:${allocId}`) : undefined
  panelRefs[gi]?.setOpen(true)
  await nextTick()
  await treeRefs[gi]?.reveal(lineNode.id, { openSelf: true, highlight: !allocNode })
  if (allocNode) await treeRefs[gi]?.reveal(allocNode.id, { openSelf: true, highlight: true })
}
watch(() => [route.query.line, route.query.allocation], () => { applyDeepLink() })

// ── status pipeline + actions ──
const statusDef = computed<StatusDef | undefined>(() =>
  orderStatusDef(['draft', 'sent', 'received', 'completed'], orderStatus.value === 'partially_received' ? 'sent' : orderStatus.value, orderStatus.value))

const convertDialog = ref(false)
const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), icon: 'mdi-content-save', handler: onSave, loading: saving.value, show: !readonly.value, cap: isEdit.value ? ['orders.create', 'orders.edit'] : 'orders.create' },
  { label: t('invoicing.sendOrder'), icon: 'mdi-send', color: 'success', handler: sendOrder, show: isEdit.value && orderStatus.value === 'draft', cap: ['orders.create', 'orders.edit'] },
  { label: t('invoicing.convertToInvoices'), icon: 'mdi-swap-horizontal', color: 'info', handler: () => { convertDialog.value = true }, show: isEdit.value && ['sent', 'partially_received', 'received'].includes(orderStatus.value), cap: 'sales-docs.create' },
  { label: t('invoicing.completeOrder'), icon: 'mdi-check-all', variant: 'outlined', handler: completeOrder, show: isEdit.value && ['sent', 'partially_received', 'received'].includes(orderStatus.value), cap: ['orders.create', 'orders.edit'] },
  { label: t('invoicing.cancelOrder'), icon: 'mdi-cancel', color: 'error', variant: 'outlined', handler: cancelOrder, show: isEdit.value && !readonly.value, cap: ['orders.create', 'orders.edit'] },
  { label: t('common.delete'), icon: 'mdi-delete', color: 'error', variant: 'text', handler: deleteOrder, show: isEdit.value && orderStatus.value === 'draft', cap: 'orders.delete' },
])

// ── pending changes ──
const { markSaved, markClean, tryRestore, snapshot: snapshotPending } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'order',
  icon: 'mdi-clipboard-list-outline',
  // What is open is the tree's own state, not the form's: opening a row is looking, not editing.
  getFormData: () => JSON.parse(JSON.stringify({ ...form, _stagedReservations: staged })),
  getPreviewFields: () => [
    { label: t('common.date'), value: form.issueDate || '' },
    { label: t('invoicing.suppliers'), value: String(form.supplierGroups.length) },
  ],
  setFormData: (data) => {
    const { _stagedReservations, ...rest } = data as any
    Object.assign(form, rest)
    if (_stagedReservations) Object.assign(staged, _stagedReservations)
  },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

// ── persistence ──
function buildPayload() {
  // Auto amount-in-words on the estimated order value, in the user's UI language.
  form.notes = upsertAmountInWords(form.notes || '', estimatedTotal.value, estimatedTotal.value, form.currency, appStore.locale)
  return supplierOrderBody(form, reservationChangesPayload())
}

async function onSave() {
  const { valid } = (await formRef.value?.validate()) || { valid: true }
  if (!valid) return
  saving.value = true
  try {
    if (isEdit.value) {
      await updateOrder(route.params.id as string, buildPayload())
      adding.value = null
      succeeded()
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      await loadOrder(undefined, { clearStaged: true })
      // It stays open on what it saved: an edit from here is unsaved again (FR-22.16, as the documents do).
      markClean()
    } else {
      const payload = buildPayload()
      const { order } = await createAttempt.run(payload, headers => createOrder(payload, headers))
      succeeded()
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      router.replace({ name: 'invoicing.orders.edit', params: { id: order._id } })
      orderNumber.value = order.orderNumber
      orderStatus.value = order.status
      await loadOrder(order._id, { clearStaged: true })
      markClean()
    }
  } catch (e: any) {
    refused(reservationErrorMessage(e, t))
  } finally {
    saving.value = false
  }
}

function sendOrder() { doAction('send', 'invoicing.orderSent') }

// ── group exports (supplier / internal sheets) ──
async function exportGroup(group: GroupRow, variant: 'supplier' | 'internal', format: 'xlsx' | 'pdf') {
  try {
    const blob = await exportOrderGroup(route.params.id as string, { groupId: group._id, variant, format, locale: appStore.locale })
    triggerBlobDownload(blob, `${orderNumber.value || 'order'}-${variant}.${format}`)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('export.failed'))
  }
}

// ── loading ──
/**
 * `clearStaged`: the reload follows a save (or closes the order), so the staged reservation changes
 * go — in the same tick the loaded reservations arrive. Clearing them before the request left the
 * allocation showing neither while the order reloaded, and anything typed in that window was lost.
 */
async function loadOrder(id?: string, opts: { clearStaged?: boolean } = {}) {
  loadStarted()
  try {
    const data = await getOrder(id || (route.params.id as string))
    const o = data.order
    orderStatus.value = o.status
    orderNumber.value = o.orderNumber
    form.issueDate = o.issueDate?.split('T')[0] || ''
    form.expectedDate = o.expectedDate?.split('T')[0] || ''
    form.currency = o.currency || baseCurrency.value
    form.exchangeRate = o.exchangeRate || 1
    form.notes = o.notes || ''
    form.terms = o.terms || ''
    form.tags = o.tags || []
    // What the user opened or closed stays so across this reload: the tree keeps it, by the id of each row.
    form.supplierGroups = supplierGroupsFrom(o.supplierGroups)
    // First-class reservations + names come with the response.
    reservations.value = data.reservations
    linkedInvoices.value = data.lookup.invoices
    if (opts.clearStaged) clearStaged()
    Object.assign(contactNames.value, data.lookup.contacts)
    knownProducts.value = data.lookup.products
    for (const [iid, info] of Object.entries(data.lookup.internalOrders)) internalOrderNumbers.value[iid] = info.orderNumber
    // Refresh the option pools so selected ids render their names.
    supplierOptions.value = withKnown(supplierOptions.value, 'supplier')
    clientOptions.value = withKnown(clientOptions.value, 'client')
    // FR-22.13: what was just loaded is the clean state — not the 500 ms timer's guess, which a
    // slower load beat. Unless reservation changes are still staged (Send keeps them): those are
    // unsaved, and leaving must still ask.
    if (!hasStaged.value) snapshotPending()
  } catch (e) {
    loadFailed(e)
  } finally {
    // The save itself succeeded: re-sending its staged creates would reserve twice.
    if (opts.clearStaged) clearStaged()
  }
}

onMounted(async () => {
  await Promise.all([fetchContacts('supplier'), fetchContacts('client'), fetchWarehouses()])
  if (tryRestore()) return
  if (isEdit.value) {
    await loadOrder()
    await nextTick()
    await applyDeepLink()
  } else fetchPeekedNumber()
})
</script>
