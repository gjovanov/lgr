<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editOrder') : $t('invoicing.newOrder')"
    :subtitle="documentNumber"
    :status="statusDef"
    :actions="formActions"
    :loading="loading"
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
                  <!-- The article: the line's own search and picker, as they were. -->
                  <div v-if="node.kind === 'line'" class="d-flex align-center ga-1 flex-grow-1" style="min-width: 0">
                    <ProductLineDescription
                      :description="lineOf(node).description"
                      :product-id="lineOf(node).productId"
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
                  <div v-else-if="node.kind === 'reservation' && node.reservation" class="d-flex align-center flex-wrap column-gap-3 text-body-2" style="min-width: 0">
                    <span :class="node.reservation.cancelled ? 'text-decoration-line-through text-medium-emphasis' : ''" :title="node.label">{{ node.label }}</span>
                    <router-link v-if="node.reservation.number && node.reservation.resId" class="text-no-wrap flex-shrink-0" :to="{ name: 'invoicing.reservations.detail', params: { id: String(node.reservation.resId) } }">{{ node.reservation.number }}</router-link>
                    <router-link v-if="node.reservation.internalOrderId" class="text-no-wrap flex-shrink-0" :to="{ name: 'invoicing.internalOrders.edit', params: { id: node.reservation.internalOrderId } }">{{ internalOrderNumbers[node.reservation.internalOrderId] || '…' }}</router-link>
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
                      <div class="d-flex align-center ga-2 flex-wrap">
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
                      <v-autocomplete
                        v-if="node.kind === 'line'"
                        v-model="lineOf(node).unit"
                        :items="uomOptions"
                        item-title="title"
                        item-value="value"
                        density="compact"
                        hide-details
                        variant="underlined"
                        :aria-label="$t('invoicing.unit')"
                        :readonly="readonly"
                      >
                        <template #selection="{ item }">{{ item.raw.short }}</template>
                        <template #item="{ item, props: ip }">
                          <v-list-item v-bind="ip" :title="item.raw.short" :subtitle="item.raw.full" />
                        </template>
                      </v-autocomplete>
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
                      <div class="d-flex flex-wrap ga-1">
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

        <!-- Linked reservations (first-class RES- documents). The tree above shows them under their warehouse, so
             this flat list, which also holds the cancelled ones (and „reserve again"), starts closed (D-6). -->
        <CollapsiblePanel v-if="isEdit" screen="orders.edit" panel-id="reservations" :default-open="false" :summary="reservationsSummary" class="mt-4" data-testid="order-reservations">
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
                    <td>{{ allocLineDescription(res.allocationId) }}</td>
                    <td>{{ contactNames[res.contactId] || '—' }}</td>
                    <td class="text-no-wrap">
                      <router-link v-if="res.internalOrderId" :to="{ name: 'invoicing.internalOrders.edit', params: { id: res.internalOrderId } }">
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
                        :icon="staged.cancels.includes(res._id) ? 'mdi-undo' : 'mdi-close'"
                        size="x-small"
                        variant="text"
                        :color="staged.cancels.includes(res._id) ? undefined : 'error'"
                        :title="staged.cancels.includes(res._id) ? $t('invoicing.reservations.keep') : $t('invoicing.cancelReservation')"
                        :aria-label="staged.cancels.includes(res._id) ? $t('invoicing.reservations.keep') : $t('invoicing.cancelReservation')"
                        @click="toggleCancel(res._id)"
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
                        @click="stageRepeat(res)"
                      />
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>
          </v-card-text>
        </CollapsiblePanel>
        <OrderInvoicesCard v-if="isEdit" screen="orders.edit" :invoices="linkedInvoices" :contacts="contactNames" :currency="form.currency || baseCurrency" :locale-code="localeCode" />

        <!-- Notes / terms / tags -->
        <v-row class="mt-4">
          <v-col cols="12" md="6">
            <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="2" auto-grow :readonly="readonly" />
            <v-textarea v-model="form.terms" :label="$t('invoicing.terms')" rows="2" auto-grow :readonly="readonly" />
            <TagInput v-model="form.tags" type="order" :org-url="orgUrl()" class="mt-2" />
          </v-col>
          <v-col cols="12" md="6">
            <v-card variant="outlined">
              <v-card-text>
                <div class="d-flex justify-space-between mb-2">
                  <span>{{ $t('invoicing.orderedQty') }}</span>
                  <span class="font-weight-medium">{{ totalOrdered }}</span>
                </div>
                <div class="d-flex justify-space-between mb-2">
                  <span>{{ $t('invoicing.reservedQty') }}</span>
                  <span>{{ totalReserved }}</span>
                </div>
                <div v-if="isEdit" class="d-flex justify-space-between mb-2">
                  <span>{{ $t('invoicing.receivedQty') }}</span>
                  <span>{{ totalReceived }}</span>
                </div>
                <v-divider class="my-2" />
                <div class="d-flex justify-space-between text-h6">
                  <span>{{ $t('invoicing.estimatedTotal') }}</span>
                  <span>{{ fmtCurrency(estimatedTotal) }}</span>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <!-- Bottom action bar mirroring the shell's top actions. -->
        <template v-if="!readonly">
          <v-divider class="my-4" />
          <div class="d-flex justify-end ga-2 flex-wrap pb-2">
            <v-btn color="primary" variant="flat" prepend-icon="mdi-content-save" :loading="saving" @click="onSave">
              {{ $t('common.save') }}
            </v-btn>
          </div>
        </template>
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

    <!-- Reserve-for-client dialog (creates a RES- document on this allocation) -->
    <v-dialog v-model="reserveDialog.open" max-width="480">
      <v-card>
        <v-card-title>{{ $t('invoicing.reservations.changeClient') }}</v-card-title>
        <v-card-text>
          <div class="text-body-2 text-medium-emphasis mb-3">
            {{ reserveDialog.description }} · {{ warehouseName(reserveDialog.warehouseId) }} ·
            {{ $t('invoicing.freeQty') }}: {{ reserveDialog.free }}
          </div>
          <div class="d-flex align-center ga-1 mb-3">
            <v-autocomplete
              v-model="reserveDialog.contactId"
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
              @update:search="(s: string) => onContactSearch(s, 'client')"
            />
            <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.searchContact')" :aria-label="$t('invoicing.searchContact')" @click="openContactPicker({ kind: 'client' })" />
          </div>
          <v-text-field
            v-model.number="reserveDialog.quantity"
            type="number"
            min="0"
            :max="reserveDialog.free"
            :label="$t('invoicing.qty')"
            density="compact"
            variant="outlined"
            hide-details
          />
          <div class="text-caption text-medium-emphasis mt-2">{{ $t('invoicing.reservations.savedWithOrder') }}</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="reserveDialog.open = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!reserveDialog.contactId || !(reserveDialog.quantity > 0) || reserveDialog.quantity > reserveDialog.free"
            @click="submitReservation"
          >
            {{ $t('invoicing.reserve') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Convert-to-invoices dialog -->
    <v-dialog v-model="convertDialog" max-width="560">
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
          <v-btn @click="convertDialog = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { triggerBlobDownload } from 'ui-shared/composables/useInvoicingExport'
import { upsertAmountInWords } from 'config/amount-in-words'
import EntityFormShell, { type FormAction, type StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ProductDetailsButton from 'ui-shared/components/ProductDetailsButton.vue'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import ProductLineDescription from '../components/ProductLineDescription.vue'
import { useConversionFeedback } from '../composables/useConversionFeedback'
import { reservationErrorMessage } from '../composables/reservation-errors'
import { cascadeSummary } from '../composables/order-cascade'
import OrderCascadeDialog from '../components/OrderCascadeDialog.vue'
import OrderInvoicesCard from '../components/OrderInvoicesCard.vue'
import DocumentBanner from '../components/document-form/DocumentBanner.vue'
import CollapsiblePanel from 'ui-shared/components/CollapsiblePanel.vue'
import OrderTree from '../components/order-tree/OrderTree.vue'
import { buildSupplierOrderTree, createOrderFigures, lineNodeId } from '../composables/order-tree/supplier-order-tree'
import type { AddingRow, ReservationRow, StagedChanges, TreeActionType, TreeColumn, TreeNode } from '../composables/order-tree/types'

/** `_key` names an allocation before it is saved, so a reservation staged on it can point at it. */
interface AllocRow { _id?: string; _key?: string; warehouseId: string; quantity: number; receivedQuantity?: number }
interface LineRow {
  _id?: string
  /** A line not saved yet has only this: the tree tells it from the next one, and keeps what is open on it. */
  _key?: string
  productId?: string
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  taxRate?: number
  receivedQuantity?: number
  allocations: AllocRow[]
}
interface GroupRow { _id?: string; supplierId: string; reference?: string; notes?: string; lines: LineRow[] }

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const conversion = useConversionFeedback()
const { formatCurrency } = useCurrency()
const { uomOptions } = useProductUnits()

const isEdit = computed(() => !!route.params.id)
const formRef = ref<any>()
const loading = ref(false)
const orderStatus = ref('draft')
const orderNumber = ref('')
const peekedNumber = ref('')
const documentNumber = computed(() => orderNumber.value || peekedNumber.value)
const readonly = computed(() => ['completed', 'cancelled'].includes(orderStatus.value))

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => (({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[appStore.locale] || 'en-US'))
const currencyOptions = computed(() => [...new Set([baseCurrency.value, 'EUR', 'BGN', 'USD', 'GBP'])])
const rules = { required: (v: string) => !!v || t('validation.required') }

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function fmtCurrency(amount: number) { return formatCurrency(amount, form.currency || baseCurrency.value, localeCode.value) }

function newKey() {
  return globalThis.crypto?.randomUUID?.() || `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}
function emptyAllocation(): AllocRow { return { _key: newKey(), warehouseId: '', quantity: 0 } }
function emptyLine(): LineRow { return { _key: newKey(), description: '', quantity: 0, unit: 'pcs', allocations: [] } }
function emptyGroup(): GroupRow { return { supplierId: '', reference: '', lines: [emptyLine()] } }

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

// ── linked reservations (RES- documents, loaded with the order) ──
const reservations = ref<any[]>([])
const internalOrderNumbers = ref<Record<string, string>>({})
/** FR-22.36: the invoices against this order — supplier invoices and the sales invoices converted from it. */
const linkedInvoices = ref<Record<string, any>>({})
const activeReservations = computed(() => reservations.value.filter((r) => r.status !== 'cancelled'))
function resStatusColor(status: string) {
  return status === 'active' ? 'primary' : status === 'fulfilled' ? 'success' : 'error'
}

// ── contacts (server-searched pools) + warehouses ──
const supplierOptions = ref<any[]>([])
const clientOptions = ref<any[]>([])
const loadingContacts = ref(false)
const warehouses = ref<Array<{ _id: string; name: string }>>([])
const contactNames = ref<Record<string, string>>({})

let contactSearchTimer: ReturnType<typeof setTimeout> | null = null
function onContactSearch(text: string, pool: 'supplier' | 'client') {
  if (contactSearchTimer) clearTimeout(contactSearchTimer)
  contactSearchTimer = setTimeout(() => fetchContacts(pool, text || undefined), 300)
}

async function fetchContacts(pool: 'supplier' | 'client', search?: string) {
  loadingContacts.value = true
  try {
    const params: Record<string, any> = { size: 20 }
    if (pool === 'supplier') params.type = 'supplier'
    if (search) params.search = search
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params })
    const items = data.contacts || []
    // Keep already-selected ids resolvable by merging known entries in.
    const known = knownOptionEntries(pool)
    const merged = [...items]
    for (const k of known) if (!merged.some((c: any) => c._id === k._id)) merged.push(k)
    if (pool === 'supplier') supplierOptions.value = merged
    else clientOptions.value = merged
    for (const c of items) contactNames.value[c._id] = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')
  } catch { /* */ } finally {
    loadingContacts.value = false
  }
}

function knownOptionEntries(pool: 'supplier' | 'client') {
  const ids = new Set<string>()
  for (const g of form.supplierGroups) {
    if (pool === 'supplier' && g.supplierId) ids.add(g.supplierId)
  }
  if (pool === 'client') for (const r of reservations.value) if (r.contactId) ids.add(String(r.contactId))
  return [...ids].filter((id) => contactNames.value[id]).map((id) => ({ _id: id, companyName: contactNames.value[id] }))
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } })
    warehouses.value = data.warehouses || []
  } catch { /* */ }
}
function warehouseName(id: string) { return warehouses.value.find((w) => w._id === id)?.name || '—' }

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
/**
 * FR-28.28: several articles at once. The first goes on the line the dialog was opened from, as one pick would; each
 * of the others on the next free line of the same supplier, through the line's own after-pick logic.
 */
function onProductsPicked(ps: any[]) {
  const t = productPickerTarget.value
  if (!t || !ps.length) return
  let li = t.li
  ps.forEach((p, i) => {
    const lines = form.supplierGroups[t.gi]?.lines
    if (!lines) return
    if (i > 0) {
      li += 1
      const next = lines[li]
      if (!next || next.productId || next.description) lines.splice(li, 0, emptyLine())
    }
    const line = lines[li]
    if (!line) return
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
  const t = contactPickerTarget.value
  const id = c?._id || c?.id
  if (!t || !id) return
  const name = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')
  contactNames.value[id] = name
  const entry = { _id: id, companyName: name }
  if (t.kind === 'supplier') {
    if (!supplierOptions.value.some((o) => o._id === id)) supplierOptions.value = [entry, ...supplierOptions.value]
    const group = form.supplierGroups[t.gi]
    if (group) group.supplierId = id
  } else {
    if (!clientOptions.value.some((o) => o._id === id)) clientOptions.value = [entry, ...clientOptions.value]
    if (t.kind === 'draftClient') draft.contactId = id
    else reserveDialog.contactId = id
  }
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
 * handing focus back). Only while the cursor is still where the pick left it, on this line or nowhere: a user who
 * has already moved on to another field keeps it. The quantity field says which line it belongs to (`data-line-qty`).
 */
function focusLineQuantity(line: LineRow) {
  if (typeof document === 'undefined') return
  setTimeout(() => {
    const gi = form.supplierGroups.findIndex((g) => g.lines.includes(line))
    if (gi < 0) return
    const id = lineNodeId(line, gi, form.supplierGroups[gi].lines.indexOf(line))
    const input = document.querySelector<HTMLInputElement>(`[data-line-qty="${CSS.escape(id)}"] input`)
    if (!input || input.disabled || input.readOnly) return
    const active = document.activeElement
    if (active && active !== document.body && !input.closest('tr')?.contains(active)) return
    input.focus()
    try { input.select() } catch { /* a number input may refuse select() */ }
  }, 200)
}
// ── #203: client reservations staged in the form, saved with the order (`reservationChanges`) ──
const staged = reactive<StagedChanges>({
  creates: [],
  updates: {},
  cancels: [],
})
const hasStaged = computed(() => staged.creates.length > 0 || Object.keys(staged.updates).length > 0 || staged.cancels.length > 0)
function clearStaged() {
  staged.creates = []
  staged.updates = {}
  staged.cancels = []
}

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
function setRowQuantity(row: ReservationRow, q: number) {
  if (row.createKey) {
    const c = staged.creates.find(x => x.key === row.createKey)
    if (c) c.quantity = q
    return
  }
  const original = reservations.value.find((r) => r._id === row.resId)
  const u = { ...(staged.updates[row.resId!] || {}) }
  if (original && q === Number(original.quantity)) delete u.quantity
  else u.quantity = q
  if (Object.keys(u).length) staged.updates[row.resId!] = u
  else delete staged.updates[row.resId!]
}
/** A staged create goes; a saved reservation is marked to cancel on save, or unmarked. */
function removeRow(row: ReservationRow) {
  if (row.createKey) {
    staged.creates = staged.creates.filter(c => c.key !== row.createKey)
    return
  }
  toggleCancel(row.resId!)
}
function toggleCancel(resId: string) {
  if (staged.cancels.includes(resId)) staged.cancels = staged.cancels.filter(id => id !== resId)
  else {
    staged.cancels = [...staged.cancels, resId]
    delete staged.updates[resId]
  }
}
const stagedRepeat = (resId: string) => staged.creates.some(c => c.repeatOf === resId)
/** „Резервирай отново": the cancelled reservation, staged again on its allocation if the order still has it. */
function stageRepeat(res: any) {
  const alloc = allAllocations().find(a => String(a._id) === String(res.allocationId))
  if (!alloc) {
    showError(t('invoicing.reservations.allocationGone'))
    return
  }
  const free = allocFree(alloc)
  if (free <= 0) {
    showError(t('invoicing.reservations.noFreeQuantity'))
    return
  }
  staged.creates.push({ key: newKey(), alloc: { id: String(alloc._id) }, contactId: String(res.contactId), quantity: Math.min(Number(res.quantity) || 0, free), repeatOf: res._id })
}
function allAllocations(): AllocRow[] {
  return form.supplierGroups.flatMap(g => g.lines.flatMap(l => l.allocations))
}
function allocLineDescription(allocationId: string) {
  for (const g of form.supplierGroups) for (const l of g.lines) if (l.allocations.some(a => String(a._id) === String(allocationId))) return l.description
  return '—'
}
/** The staged changes as the order's PUT/POST carries them. */
function reservationChangesPayload() {
  if (!hasStaged.value) return undefined
  return {
    create: staged.creates.map(c => ({
      ...(c.alloc.id ? { allocationId: c.alloc.id } : { allocationKey: c.alloc.key }),
      contactId: c.contactId,
      quantity: c.quantity,
      ...(c.repeatOf ? { repeatOf: c.repeatOf } : {}),
    })),
    update: Object.entries(staged.updates).map(([id, u]) => ({ id, ...u })),
    cancel: staged.cancels.map(id => ({ id })),
  }
}
function addGroup() { form.supplierGroups.push(emptyGroup()) }
function removeGroup(gi: number) { form.supplierGroups.splice(gi, 1); adding.value = null }

// The Totals card reads the tree's own figures (FR-28.37): a reservation staged on the form counts here at
// once, as it does on its warehouse. It used to add up only what the server had.
const totalOrdered = computed(() => tree.value.totals.ordered)
const totalReceived = computed(() => tree.value.totals.received)
const totalReserved = computed(() => tree.value.totals.reserved)

// ── FR-28.43: what a folded card still says ──
/**
 * One supplier's card, folded: how many lines, how much is ordered and how much of it is reserved. The
 * tree's own figures, so it says what the open card adds up to, staged reservations included.
 */
function groupSummary(gi: number): string {
  const f = tree.value.groups[gi]?.figures
  if (!f) return ''
  return [t('invoicing.panels.lines', f.lines), t('invoicing.panels.ordered', { n: f.ordered }), t('invoicing.panels.reserved', { n: f.reserved })].join(' · ')
}
/** The Reservations card, folded: how many hold stock, for how many clients. */
const reservationsSummary = computed(() => {
  const clients = new Set(activeReservations.value.map((r) => String(r.contactId || '')).filter(Boolean))
  return [t('invoicing.panels.reservationsCount', activeReservations.value.length), t('invoicing.panels.clients', clients.size)].join(' · ')
})
const estimatedTotal = computed(() =>
  form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.quantity) || 0) * (Number(l.expectedUnitPrice) || 0), 0), 0),
)

// ── FR-28.39: the tree on screen ──
// The rows are the form's own objects (`lineOf`, `allocOf`), edited in place; the tree is rebuilt from them.
const treeColumns = computed<TreeColumn[]>(() => [
  { key: 'item', title: t('invoicing.tree.item') },
  { key: 'qty', title: t('invoicing.qty'), align: 'end', width: '64px' },
  { key: 'unit', title: t('invoicing.unit'), width: '68px' },
  { key: 'price', title: t('invoicing.tree.price'), align: 'end', width: '76px' },
  { key: 'reserved', title: t('invoicing.tree.reserved'), align: 'end', width: '80px' },
  { key: 'free', title: t('invoicing.freeQty'), hint: t('invoicing.tree.freeHint'), align: 'end', width: '56px' },
  ...(isEdit.value
    ? ([
        { key: 'received', title: t('invoicing.tree.received'), align: 'end', width: '82px' },
        { key: 'invoiced', title: t('invoicing.tree.invoiced'), align: 'end', width: '74px' },
        { key: 'dispatched', title: t('invoicing.tree.dispatched'), align: 'end', width: '90px', optional: true },
      ] as TreeColumn[])
    : []),
  { key: 'status', title: t('common.status'), width: '96px' },
  { key: 'actions', title: '', width: '144px' },
])

/** The tooltip of Invoiced while Dispatched has no column of its own (a narrow screen): both figures, so neither is lost. */
const invoicedAndDispatched = (f: { invoiced: number; dispatched: number }) =>
  `${t('invoicing.tree.invoiced')} ${f.invoiced} · ${t('invoicing.tree.dispatched')} ${f.dispatched}`

/** One tree per supplier, and the card around it: kept so a link can open the card and the row. */
const treeRefs: Record<number, any> = {}
function setTreeRef(gi: number, el: any) { if (el) treeRefs[gi] = el; else delete treeRefs[gi] }
const panelRefs: Record<number, any> = {}
function setPanelRef(gi: number, el: any) { if (el) panelRefs[gi] = el; else delete panelRefs[gi] }

const lineOf = (node: TreeNode): LineRow => form.supplierGroups[node.source.groupIndex].lines[node.source.lineIndex!]
const allocOf = (node: TreeNode): AllocRow => lineOf(node).allocations[node.source.allocationIndex!]

interface StatusChip { key: string; text: string; color?: string; variant?: 'tonal' | 'outlined'; label?: boolean }
/**
 * What a row says about itself. A reservation: its status, or that it is new, changed or cancelled on save. A
 * line or a warehouse: its own flags while open; closed, also what is flagged below it, so folding hides nothing.
 * (The chip over a closed parent says "unsaved", never "unsaved changes": that is the Reservations card's.)
 */
function statusChips(node: TreeNode, open: boolean): StatusChip[] {
  const out: StatusChip[] = []
  const r = node.reservation
  if (node.kind === 'reservation' && r) {
    if (r.cancelled) out.push({ key: 'cancel', text: t('invoicing.reservations.willCancel'), color: 'error' })
    else if (r.createKey) out.push({ key: 'new', text: t('invoicing.reservations.new'), color: 'success' })
    else {
      if (r.status) out.push({ key: 'status', text: t(`invoicing.status.${r.status}`), color: resStatusColor(r.status), label: true })
      if (r.changed) out.push({ key: 'changed', text: t('invoicing.tree.changed'), color: 'warning' })
    }
    return out
  }
  const flags = open ? node.flags : node.rolledFlags
  if (flags.includes('overAllocated')) out.push({ key: 'over', text: t('invoicing.tree.overAllocated'), color: 'error' })
  if (flags.includes('unallocated')) out.push({ key: 'unalloc', text: t('invoicing.tree.unallocated', { n: node.figures.free ?? 0 }), variant: 'outlined' })
  if (flags.some((f) => f === 'new' || f === 'changed' || f === 'cancelledOnSave')) out.push({ key: 'unsaved', text: t('invoicing.tree.unsaved'), color: 'warning' })
  return out
}

const actionText = (type: TreeActionType) => t(type === 'addWarehouse' ? 'invoicing.tree.addWarehouse' : 'invoicing.tree.addClient')
const actionIcon = (type: TreeActionType) => ({ remove: 'mdi-close', cancel: 'mdi-close', undo: 'mdi-undo', changeClient: 'mdi-account-switch-outline' } as Record<string, string>)[type]
const actionTitle = (type: TreeActionType) =>
  t(({ remove: 'common.remove', cancel: 'invoicing.cancelReservation', undo: 'invoicing.reservations.keep', changeClient: 'invoicing.reservations.changeClient' } as Record<string, string>)[type])

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

// ── FR-28.40: + Warehouse and + Client are rows, not dialogs ──
// A row appears under its parent with what it needs; Enter adds it (staged, marked new, the figures move) and
// Escape drops it. Nothing is sent until Save: a reservation is still staged and saved with the order.
const adding = ref<AddingRow | null>(null)
const draft = reactive({ warehouseId: '', contactId: '', quantity: 0, menu: false, showErrors: false })

function startAdding(node: TreeNode | undefined) {
  if (!node || (node.kind !== 'line' && node.kind !== 'allocation')) return
  const forWarehouse = node.kind === 'line'
  draft.warehouseId = ''
  draft.contactId = ''
  draft.showErrors = false
  draft.menu = false
  // It starts at what is left to place on the line, or to reserve on the warehouse.
  draft.quantity = forWarehouse ? (figures.value.line(lineOf(node)).figures.free ?? 0) : (figures.value.allocation(allocOf(node)).free ?? 0)
  adding.value = { parentId: node.id, kind: forWarehouse ? 'allocation' : 'reservation' }
  // The row opens its parent, and the parent stays open once the row has been added.
  treeRefs[node.source.groupIndex]?.setOpen(node.id, true)
  nextTick(() => {
    document.querySelector<HTMLInputElement>('[data-tree-editor] input')?.focus()
    draft.menu = true
  })
}

/** What is wrong with the row being added, by field: the checks of the dialog it replaces, and one more. */
const draftProblems = computed(() => {
  const out = { warehouse: '', client: '', qty: '' }
  const a = adding.value
  const parent = a ? tree.value.index.get(a.parentId) : undefined
  if (!a || !parent) return out
  const q = Number(draft.quantity) || 0
  if (a.kind === 'allocation') {
    if (!draft.warehouseId) out.warehouse = t('invoicing.tree.chooseWarehouse')
    const f = figures.value.line(lineOf(parent))
    if (!(q > 0)) out.qty = t('invoicing.tree.qtyAboveZero')
    else if (f.allocated + q > f.figures.quantity) out.qty = t('invoicing.overAllocated')
  } else {
    if (!draft.contactId) out.client = t('invoicing.tree.chooseClient')
    const free = figures.value.allocation(allocOf(parent)).free ?? 0
    if (!(q > 0)) out.qty = t('invoicing.tree.qtyAboveZero')
    else if (q > free) out.qty = t('invoicing.tree.exceedsFree', { free })
  }
  return out
})
/** Said beside the field, but only once the row has been tried: a row nobody has touched is not an error. */
const draftMessages = computed(() => ({
  warehouse: draft.showErrors && draftProblems.value.warehouse ? [draftProblems.value.warehouse] : [],
  client: draft.showErrors && draftProblems.value.client ? [draftProblems.value.client] : [],
  qty: draft.showErrors && draftProblems.value.qty ? [draftProblems.value.qty] : [],
}))

function commitAdding() {
  const a = adding.value
  const parent = a ? tree.value.index.get(a.parentId) : undefined
  if (!a || !parent) return
  const p = draftProblems.value
  if (p.warehouse || p.client || p.qty) {
    draft.showErrors = true
    return
  }
  const quantity = Number(draft.quantity)
  if (a.kind === 'allocation') {
    lineOf(parent).allocations.push({ _key: newKey(), warehouseId: draft.warehouseId, quantity })
  } else {
    const alloc = allocOf(parent)
    staged.creates.push({ key: newKey(), alloc: alloc._id ? { id: String(alloc._id) } : { key: alloc._key }, contactId: draft.contactId, quantity })
  }
  adding.value = null
}
function cancelAdding() { adding.value = null }

/**
 * Enter adds, Escape drops: unless a list is open, which answers both itself (Enter picks, Escape closes it).
 * Listened to in the CAPTURE phase, before the field sees the key: by the time a bubbling listener runs, the
 * field has already closed its list and Vue has already written that to `aria-expanded`, so the same Enter
 * that picked a warehouse would add the row with the quantity it started with.
 */
function onEditorKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== 'Escape') return
  if ((e.target as HTMLElement | null)?.getAttribute?.('aria-expanded') === 'true') return
  e.preventDefault()
  e.stopPropagation() // an Enter on a closed list would open it again
  if (e.key === 'Enter') commitAdding()
  else cancelAdding()
}
/** After a warehouse or a client is chosen the cursor is in the quantity, ready to be typed over. */
function focusDraftQuantity() {
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('[data-tree-editor-qty] input')
    input?.focus()
    input?.select()
  })
}

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
const statusDef = computed<StatusDef | undefined>(() => ({
  steps: ['invoicing.status.draft', 'invoicing.status.sent', 'invoicing.status.received', 'invoicing.status.completed'],
  current: `invoicing.status.${orderStatus.value === 'partially_received' ? 'sent' : orderStatus.value}`,
  colors: orderStatus.value === 'cancelled' ? { [`invoicing.status.cancelled`]: 'error' } : undefined,
}))

const saving = ref(false)
const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), icon: 'mdi-content-save', handler: onSave, loading: saving.value, show: !readonly.value },
  { label: t('invoicing.sendOrder'), icon: 'mdi-send', color: 'success', handler: sendOrder, show: isEdit.value && orderStatus.value === 'draft' },
  { label: t('invoicing.convertToInvoices'), icon: 'mdi-swap-horizontal', color: 'info', handler: () => { convertDialog.value = true }, show: isEdit.value && ['sent', 'partially_received', 'received'].includes(orderStatus.value) },
  { label: t('invoicing.completeOrder'), icon: 'mdi-check-all', variant: 'outlined', handler: completeOrder, show: isEdit.value && ['sent', 'partially_received', 'received'].includes(orderStatus.value) },
  { label: t('invoicing.cancelOrder'), icon: 'mdi-cancel', color: 'error', variant: 'outlined', handler: cancelOrder, show: isEdit.value && !readonly.value },
  { label: t('common.delete'), icon: 'mdi-delete', color: 'error', variant: 'text', handler: deleteOrder, show: isEdit.value && orderStatus.value === 'draft' },
])

// ── pending changes ──
const { markSaved, markClean, tryRestore, snapshot: snapshotPending } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'order',
  icon: 'mdi-clipboard-list-outline',
  // What is open is the tree's own state, not the form's: opening a row is looking, not editing.
  getFormData: () => JSON.parse(JSON.stringify({ ...form, _stagedReservations: staged })),
  getPreviewFields: () => [
    { label: 'Date', value: form.issueDate || '' },
    { label: 'Suppliers', value: String(form.supplierGroups.length) },
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
  return {
    issueDate: form.issueDate,
    expectedDate: form.expectedDate || undefined,
    currency: form.currency,
    exchangeRate: form.exchangeRate || 1,
    notes: form.notes || undefined,
    terms: form.terms || undefined,
    tags: form.tags,
    supplierGroups: form.supplierGroups
      .filter((g) => g.supplierId)
      .map((g) => ({
        ...(g._id ? { _id: g._id } : {}),
        supplierId: g.supplierId,
        reference: g.reference || undefined,
        notes: g.notes || undefined,
        lines: g.lines
          .filter((l) => l.productId || (l.description || '').trim())
          .map((l) => ({
            ...(l._id ? { _id: l._id } : {}),
            productId: l.productId || undefined,
            description: l.description,
            sku: l.sku || undefined,
            quantity: Number(l.quantity) || 0,
            unit: l.unit || 'pcs',
            expectedUnitPrice: l.expectedUnitPrice !== undefined && l.expectedUnitPrice !== null ? Number(l.expectedUnitPrice) : undefined,
            taxRate: l.taxRate,
            allocations: l.allocations
              .filter((a) => a.warehouseId)
              .map((a) => ({
                ...(a._id ? { _id: a._id } : { clientKey: a._key }),
                warehouseId: a.warehouseId,
                quantity: Number(a.quantity) || 0,
              })),
          })),
      })),
    reservationChanges: reservationChangesPayload(),
  }
}

async function onSave() {
  const { valid } = (await formRef.value?.validate()) || { valid: true }
  if (!valid) return
  saving.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoicing/orders/${route.params.id}`, buildPayload())
      adding.value = null
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      await loadOrder(undefined, { clearStaged: true })
      // It stays open on what it saved: an edit from here is unsaved again (FR-22.16, as the documents do).
      markClean()
    } else {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/orders`, buildPayload())
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      router.replace({ name: 'invoicing.orders.edit', params: { id: data.order._id } })
      orderNumber.value = data.order.orderNumber
      orderStatus.value = data.order.status
      await loadOrder(data.order._id, { clearStaged: true })
      markClean()
    }
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    saving.value = false
  }
}

/** True when it went through; a refusal goes to `onError` (the cascade dialog) or the snackbar. */
async function doAction(path: string, successKey: string, opts: { onError?: (message: string) => void } = {}): Promise<boolean> {
  loading.value = true
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/orders/${route.params.id}/${path}`)
    // FR-22.41: a cancelled order says whose client orders lost their reservations.
    const affected = (data?.affectedInternalOrders || []).map((o: any) => o.orderNumber).filter(Boolean)
    showSuccess(affected.length ? t('invoicing.cascade.cancelledReleased', { numbers: affected.join(', ') }) : t(successKey))
    // A completed or cancelled order is read-only, so what was staged on it can never be saved.
    // After Send the order stays open and the staged changes stay with it.
    await loadOrder(undefined, { clearStaged: path === 'complete' || path === 'cancel' })
    return true
  } catch (e: any) {
    const message = reservationErrorMessage(e, t)
    if (opts.onError) opts.onError(message)
    else showError(message)
    return false
  } finally {
    loading.value = false
  }
}
function sendOrder() { doAction('send', 'invoicing.orderSent') }

// ── FR-22.41: Cancel and Complete say what they release before they do it ──
const cascade = reactive({ open: false, action: 'cancel' as 'cancel' | 'complete', error: '', busy: false })
const cascadeNow = computed(() => cascadeSummary(reservations.value, 'supplier', internalOrderNumbers.value))
function openCascade(action: 'cancel' | 'complete') {
  cascade.action = action
  cascade.error = ''
  cascade.open = true
}
/**
 * Cancel always asks: it cannot be undone. Complete asks when it lets reservations go, or when
 * reservation changes are staged — a completed order is read-only, so they would be dropped.
 */
function cancelOrder() { openCascade('cancel') }
function completeOrder() {
  if (cascadeNow.value.count > 0 || hasStaged.value) openCascade('complete')
  else doAction('complete', 'invoicing.orderCompleted')
}
async function confirmCascade() {
  cascade.busy = true
  cascade.error = ''
  // Through doAction, so Cancel and Complete still drop the staged reservation changes.
  const ok = await doAction(cascade.action, cascade.action === 'cancel' ? 'invoicing.orderCancelled' : 'invoicing.orderCompleted', {
    onError: (message) => { cascade.error = message },
  })
  cascade.busy = false
  if (ok) cascade.open = false
}

async function deleteOrder() {
  if (!confirm(t('invoicing.deleteOrderConfirm'))) return
  try {
    await httpClient.delete(`${orgUrl()}/invoicing/orders/${route.params.id}`)
    showSuccess(t('common.deletedSuccessfully'))
    router.push({ name: 'invoicing.orders' })
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  }
}

// ── changing the client of a reservation ──
// A new reservation is a + Client row on the tree (FR-28.40); this dialog is what is left for "change client".
// #203: it stages; nothing is posted until the order is saved, and the form is never reloaded under the user's edits.
const reserveDialog = reactive({
  open: false,
  contactId: '',
  quantity: 0,
  description: '',
  free: 0,
  warehouseId: '',
  /** The row whose client the dialog changes: a saved reservation, or one staged to be made. */
  row: null as ReservationRow | null,
})

function openClientChange(row: ReservationRow, line: LineRow, alloc: AllocRow) {
  reserveDialog.row = row
  reserveDialog.contactId = row.contactId
  reserveDialog.quantity = row.quantity
  reserveDialog.description = line.description
  reserveDialog.free = allocFree(alloc) + row.quantity
  reserveDialog.warehouseId = alloc.warehouseId
  reserveDialog.open = true
}

function submitReservation() {
  const row = reserveDialog.row
  if (!row) {
    reserveDialog.open = false
    return
  }
  if (row.createKey) {
    const c = staged.creates.find(x => x.key === row.createKey)
    if (c) { c.contactId = reserveDialog.contactId; c.quantity = reserveDialog.quantity }
  } else {
    const original = reservations.value.find((r) => r._id === row.resId)
    const u: { quantity?: number; contactId?: string } = {}
    if (original && reserveDialog.contactId !== String(original.contactId)) u.contactId = reserveDialog.contactId
    if (original && reserveDialog.quantity !== Number(original.quantity)) u.quantity = reserveDialog.quantity
    if (Object.keys(u).length) staged.updates[row.resId!] = u
    else delete staged.updates[row.resId!]
  }
  reserveDialog.open = false
}

// ── conversion ──
const convertDialog = ref(false)
const convertingId = ref('')
const convertibleClients = computed(() => {
  const byClient = new Map<string, number>()
  for (const r of reservations.value) {
    if (r.status !== 'active') continue
    const open = (Number(r.quantity) || 0) - (Number(r.invoicedQuantity) || 0)
    if (r.contactId && open > 0) byClient.set(String(r.contactId), (byClient.get(String(r.contactId)) || 0) + open)
  }
  return [...byClient.entries()].map(([contactId, open]) => ({
    contactId,
    open,
    name: contactNames.value[contactId] || contactId,
  }))
})

async function convertFor(contactId: string) {
  convertingId.value = contactId
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/orders/${route.params.id}/convert`, { contactId })
    conversion.converted(data)
    await loadOrder()
  } catch (e: any) {
    conversion.failed(e)
  } finally {
    convertingId.value = ''
  }
}

// ── group exports (supplier / internal sheets) ──
async function exportGroup(group: GroupRow, variant: 'supplier' | 'internal', format: 'xlsx' | 'pdf') {
  try {
    const res = await httpClient.get(`${orgUrl()}/invoicing/orders/${route.params.id}/export`, {
      params: { groupId: group._id, variant, format, locale: appStore.locale },
      responseType: 'blob',
    })
    triggerBlobDownload(res.data, `${orderNumber.value || 'order'}-${variant}.${format}`)
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
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/orders/${id || route.params.id}`)
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
    form.supplierGroups = (o.supplierGroups || []).map((g: any) => ({
      _id: g._id,
      supplierId: g.supplierId,
      reference: g.reference || '',
      notes: g.notes || '',
      lines: (g.lines || []).map((l: any) => ({
        _id: l._id,
        productId: l.productId || undefined,
        description: l.description || '',
        sku: l.sku,
        quantity: l.quantity || 0,
        unit: l.unit || 'pcs',
        expectedUnitPrice: l.expectedUnitPrice,
        taxRate: l.taxRate,
        receivedQuantity: l.receivedQuantity || 0,
        allocations: (l.allocations || []).map((a: any) => ({
          _id: a._id,
          warehouseId: a.warehouseId,
          quantity: a.quantity || 0,
          receivedQuantity: a.receivedQuantity || 0,
        })),
      })),
    }))
    // First-class reservations + names come with the response.
    reservations.value = data.reservations || []
    linkedInvoices.value = data.lookup?.invoices || {}
    if (opts.clearStaged) clearStaged()
    if (data.lookup?.contacts) Object.assign(contactNames.value, data.lookup.contacts)
    if (data.lookup?.internalOrders) {
      for (const [iid, info] of Object.entries<any>(data.lookup.internalOrders)) {
        internalOrderNumbers.value[iid] = info.orderNumber
      }
    }
    // Refresh the option pools so selected ids render their names.
    supplierOptions.value = mergeKnown(supplierOptions.value, 'supplier')
    clientOptions.value = mergeKnown(clientOptions.value, 'client')
    // FR-22.13: what was just loaded is the clean state — not the 500 ms timer's guess, which a
    // slower load beat. Unless reservation changes are still staged (Send keeps them): those are
    // unsaved, and leaving must still ask.
    if (!hasStaged.value) snapshotPending()
  } catch {
    showError(t('common.operationFailed'))
  } finally {
    // The save itself succeeded: re-sending its staged creates would reserve twice.
    if (opts.clearStaged) clearStaged()
  }
}

function mergeKnown(list: any[], pool: 'supplier' | 'client') {
  const merged = [...list]
  for (const k of knownOptionEntries(pool)) if (!merged.some((c) => c._id === k._id)) merged.push(k)
  return merged
}

async function fetchPeekedNumber() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/orders/peek-next`)
    peekedNumber.value = data.next || ''
  } catch { /* */ }
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
