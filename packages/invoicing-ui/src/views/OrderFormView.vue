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
    <template #document-header>
      <div class="d-flex align-center justify-space-between px-4 py-3 ga-4 flex-wrap">
        <div class="d-flex align-center ga-3">
          <v-avatar size="36" color="primary" variant="tonal">
            <v-icon size="20">mdi-clipboard-list-outline</v-icon>
          </v-avatar>
          <div>
            <div class="text-overline text-medium-emphasis">{{ appStore.currentOrg?.name || '—' }}</div>
            <div class="text-subtitle-1 font-weight-bold">{{ isEdit ? $t('invoicing.editOrder') : $t('invoicing.newOrder') }}</div>
          </div>
        </div>
        <div class="text-end">
          <div class="text-h6 font-weight-bold">{{ documentNumber || '—' }}</div>
          <v-chip size="x-small" label color="primary" variant="tonal" class="mt-1">
            {{ $t(`invoicing.status.${orderStatus}`) }}
          </v-chip>
        </div>
      </div>
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
          <v-card variant="outlined" rounded="lg">
            <v-card-title class="d-flex align-center ga-2 py-2 flex-wrap">
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
              <v-spacer />
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
            </v-card-title>
            <v-divider />
            <v-card-text class="pa-2">
              <div style="overflow-x: auto">
                <v-table density="compact">
                  <thead>
                    <tr>
                      <th style="width:50%;min-width:50vw">{{ $t('common.description') }}</th>
                      <th class="text-end" style="width: 110px">{{ $t('invoicing.qty') }}</th>
                      <th style="width:110px;min-width:110px">{{ $t('invoicing.unit') }}</th>
                      <th class="text-end" style="width: 130px">{{ $t('invoicing.expectedPrice') }}</th>
                      <th v-if="isEdit" class="text-end" style="width: 100px">{{ $t('invoicing.receivedQty') }}</th>
                      <th style="min-width: 220px">{{ $t('invoicing.allocations') }}</th>
                      <th style="width: 40px"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(line, li) in group.lines" :key="line._id || li">
                      <tr>
                        <td style="min-width:160px">
                          <div class="d-flex align-center ga-1">
                            <ProductLineDescription
                              :description="line.description"
                              :product-id="line.productId"
                              price-field="purchasePrice"
                              class="flex-grow-1"
                              @update:description="line.description = $event"
                              @update:product-id="line.productId = $event"
                              @product-selected="onProductSelected(line, $event)"
                              @product-cleared="line.productId = undefined"
                            />
                            <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.browseProducts')" :aria-label="$t('invoicing.browseProducts')" @click="openProductPicker(gi, li)" />
                          </div>
                        </td>
                        <td>
                          <v-text-field v-model.number="line.quantity" type="number" min="0" density="compact" hide-details variant="underlined" style="min-width: 100px" :readonly="readonly" />
                        </td>
                        <td>
                          <v-autocomplete v-model="line.unit" :items="uomOptions" item-title="title" item-value="value" density="compact" hide-details variant="underlined" :readonly="readonly">
                            <template #selection="{ item }">{{ item.raw.short }}</template>
                            <template #item="{ item, props: ip }">
                              <v-list-item v-bind="ip" :title="item.raw.short" :subtitle="item.raw.full" />
                            </template>
                          </v-autocomplete>
                        </td>
                        <td>
                          <v-text-field v-model.number="line.expectedUnitPrice" type="number" step="0.0001" min="0" density="compact" hide-details variant="underlined" style="min-width: 110px" :readonly="readonly" />
                        </td>
                        <td v-if="isEdit" class="text-end" style="white-space: nowrap">
                          <span :class="(line.receivedQuantity || 0) >= line.quantity && line.quantity > 0 ? 'text-success' : ''">
                            {{ line.receivedQuantity || 0 }}
                          </span>
                        </td>
                        <td>
                          <div class="d-flex align-center ga-1 flex-wrap">
                            <v-chip
                              v-for="(alloc, ai) in line.allocations"
                              :key="ai"
                              size="x-small"
                              variant="tonal"
                              :color="allocReserved(alloc) > 0 ? 'primary' : undefined"
                              :title="allocClientSummary(alloc)"
                            >
                              {{ warehouseName(alloc.warehouseId) }}: {{ alloc.quantity }}<template v-if="allocReserved(alloc)"> ·<v-icon size="12" class="ms-1">mdi-account-lock-outline</v-icon>{{ allocReserved(alloc) }}</template>
                            </v-chip>
                            <v-chip v-if="unallocated(line) > 0" size="x-small" variant="outlined">+{{ unallocated(line) }}</v-chip>
                            <v-btn
                              :icon="line._expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                              size="x-small"
                              variant="text"
                              :title="$t('invoicing.allocations')"
                              :aria-label="$t('invoicing.allocations')"
                              @click="line._expanded = !line._expanded"
                            />
                          </div>
                        </td>
                        <td>
                          <v-btn v-if="!readonly" icon="mdi-close" size="x-small" variant="text" tabindex="-1" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="group.lines.splice(li, 1)" />
                        </td>
                      </tr>
                      <!-- Allocation editor -->
                      <tr v-if="line._expanded">
                        <td :colspan="isEdit ? 7 : 6" class="pa-0">
                          <v-sheet color="surface" class="pa-3" style="border-left: 3px solid rgb(var(--v-theme-primary))">
                            <div v-for="(alloc, ai) in line.allocations" :key="ai" class="mb-2">
                              <div class="d-flex align-center ga-2 flex-wrap">
                                <v-autocomplete
                                  v-model="alloc.warehouseId"
                                  :items="warehouses"
                                  item-title="name"
                                  item-value="_id"
                                  :label="$t('warehouse.warehouse')"
                                  density="compact"
                                  hide-details
                                  style="max-width: 220px; min-width: 180px"
                                  :readonly="readonly"
                                />
                                <v-text-field v-model.number="alloc.quantity" type="number" min="0" :label="$t('invoicing.qty')" density="compact" hide-details style="max-width: 110px" :readonly="readonly" />
                                <v-chip v-if="isEdit" size="x-small" variant="tonal" :color="(alloc.receivedQuantity || 0) > 0 ? 'success' : undefined">
                                  {{ $t('invoicing.receivedQty') }}: {{ alloc.receivedQuantity || 0 }}
                                </v-chip>
                                <v-chip size="x-small" variant="tonal">
                                  {{ $t('invoicing.freeQty') }}: {{ allocFree(alloc) }}
                                </v-chip>
                                <!-- #203: on every allocation — a new one too; it is saved with the order. -->
                                <v-btn
                                  v-if="!readonly && line.productId && alloc.warehouseId"
                                  size="x-small"
                                  variant="text"
                                  color="primary"
                                  prepend-icon="mdi-account-lock-outline"
                                  :disabled="allocFree(alloc) <= 0"
                                  @click="openReserveDialog(line, alloc)"
                                >
                                  {{ $t('invoicing.reserveForClient') }}
                                </v-btn>
                                <v-btn v-if="!readonly" icon="mdi-close" size="x-small" variant="text" color="error" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="line.allocations.splice(ai, 1)" />
                              </div>
                              <!-- #203: the allocation's client reservations, changed here and saved with the order. -->
                              <div v-for="row in allocRows(alloc)" :key="row.key" class="d-flex align-center flex-wrap ga-2 text-body-2 ps-4 mt-1">
                                <v-icon size="14" :color="row.cancelled ? 'error' : 'primary'">mdi-account-lock-outline</v-icon>
                                <span :class="row.cancelled ? 'text-decoration-line-through text-medium-emphasis' : ''">{{ contactNames[row.contactId] || '—' }}</span>
                                <router-link v-if="row.number && row.resId" :to="{ name: 'invoicing.reservations.detail', params: { id: String(row.resId) } }" class="text-caption">{{ row.number }}</router-link>
                                <v-chip v-else size="x-small" variant="tonal" color="success">{{ $t('invoicing.reservations.new') }}</v-chip>
                                <router-link v-if="row.internalOrderId" :to="{ name: 'invoicing.internalOrders.edit', params: { id: row.internalOrderId } }" class="text-caption">
                                  {{ internalOrderNumbers[row.internalOrderId] || '…' }}
                                </router-link>
                                <v-text-field
                                  v-if="row.editable"
                                  :model-value="row.quantity"
                                  type="number"
                                  :min="row.consumed"
                                  density="compact"
                                  hide-details
                                  variant="underlined"
                                  style="max-width: 90px"
                                  :aria-label="row.number ? `${$t('invoicing.qty')} ${row.number}` : $t('invoicing.qty')"
                                  @update:model-value="(v: any) => setRowQuantity(row, Number(v))"
                                />
                                <span v-else>{{ row.quantity }}</span>
                                <span v-if="row.consumed > 0" class="text-caption text-medium-emphasis">({{ $t('invoicing.invoicedQty') }} {{ row.invoiced }} · {{ $t('invoicing.dispatchedQty') }} {{ row.dispatched }})</span>
                                <v-chip v-if="row.cancelled" size="x-small" variant="tonal" color="error">{{ $t('invoicing.reservations.willCancel') }}</v-chip>
                                <v-btn v-if="row.editable && row.canChangeClient" icon="mdi-account-switch-outline" size="x-small" variant="text" :title="$t('invoicing.reservations.changeClient')" :aria-label="$t('invoicing.reservations.changeClient')" @click="openClientChange(row, line, alloc)" />
                                <v-btn v-if="!readonly && !row.cancelled && row.cancellable" icon="mdi-close" size="x-small" variant="text" color="error" :title="$t('invoicing.cancelReservation')" :aria-label="$t('invoicing.cancelReservation')" @click="removeRow(row)" />
                                <v-btn v-if="!readonly && row.cancelled" icon="mdi-undo" size="x-small" variant="text" :title="$t('invoicing.reservations.keep')" :aria-label="$t('invoicing.reservations.keep')" @click="removeRow(row)" />
                              </div>
                            </div>
                            <v-btn v-if="!readonly" size="small" variant="outlined" prepend-icon="mdi-warehouse" @click="line.allocations.push(emptyAllocation())">
                              {{ $t('invoicing.addAllocation') }}
                            </v-btn>
                            <span v-if="overAllocated(line)" class="text-error text-caption ml-2">{{ $t('invoicing.overAllocated') }}</span>
                          </v-sheet>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </v-table>
              </div>
              <v-btn v-if="!readonly" color="primary" variant="text" size="small" prepend-icon="mdi-plus" class="mt-1" @click="group.lines.push(emptyLine())">
                {{ $t('invoicing.addLine') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </div>

        <v-btn v-if="!readonly" color="primary" variant="outlined" prepend-icon="mdi-factory" class="mt-4" @click="addGroup">
          {{ $t('invoicing.addSupplier') }}
        </v-btn>

        <!-- Linked reservations (first-class RES- documents) -->
        <v-card v-if="isEdit" variant="outlined" rounded="lg" class="mt-4">
          <v-card-title class="d-flex align-center ga-2 py-2">
            <v-icon size="20" color="primary">mdi-lock-clock</v-icon>
            {{ $t('nav.reservations') }}
            <v-chip size="x-small" variant="tonal">{{ activeReservations.length }}</v-chip>
            <v-chip v-if="hasStaged" size="x-small" variant="tonal" color="warning">{{ $t('invoicing.reservations.unsaved') }}</v-chip>
          </v-card-title>
          <v-divider />
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
                      <router-link v-if="res.internalOrderId" :to="`/internal-orders/${res.internalOrderId}/edit`">
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
        </v-card>

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

    <ProductPickerDialog v-model="productPickerOpen" :org-url="orgUrl()" :base-currency="baseCurrency" :locale="localeCode" @select="onProductPicked" />
    <ContactPickerDialog v-model="contactPickerOpen" :org-url="orgUrl()" :type="contactPickerTarget?.kind === 'supplier' ? 'supplier' : 'customer'" @select="onContactPicked" />

    <!-- Reserve-for-client dialog (creates a RES- document on this allocation) -->
    <v-dialog v-model="reserveDialog.open" max-width="480">
      <v-card>
        <v-card-title>{{ reserveDialog.row ? $t('invoicing.reservations.changeClient') : $t('invoicing.reserveForClient') }}</v-card-title>
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
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
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
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import ProductLineDescription from '../components/ProductLineDescription.vue'
import { useConversionFeedback } from '../composables/useConversionFeedback'

/** `_key` names an allocation before it is saved, so a reservation staged on it can point at it. */
interface AllocRow { _id?: string; _key?: string; warehouseId: string; quantity: number; receivedQuantity?: number }
interface LineRow {
  _id?: string
  productId?: string
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  taxRate?: number
  receivedQuantity?: number
  allocations: AllocRow[]
  _expanded?: boolean
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
function emptyLine(): LineRow { return { description: '', quantity: 0, unit: 'pcs', allocations: [], _expanded: false } }
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
const activeReservations = computed(() => reservations.value.filter((r) => r.status !== 'cancelled'))
const resByAlloc = computed(() => {
  const m = new Map<string, any[]>()
  for (const r of activeReservations.value) {
    const k = String(r.allocationId || '')
    if (!k) continue
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(r)
  }
  return m
})
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
function openProductPicker(gi: number, li: number) {
  productPickerTarget.value = { gi, li }
  productPickerOpen.value = true
}
function onProductPicked(p: any) {
  const t = productPickerTarget.value
  const line = t ? form.supplierGroups[t.gi]?.lines[t.li] : undefined
  if (!line) return
  line.productId = p._id
  line.description = p.name
  onProductSelected(line, p)
}

type ContactPickTarget = { kind: 'supplier'; gi: number } | { kind: 'client' }
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
    reserveDialog.contactId = id
  }
}

// ── line helpers ──
function onProductSelected(line: LineRow, product: any) {
  line.unit = product.unit || line.unit
  line.sku = product.sku
  if (!line.expectedUnitPrice) line.expectedUnitPrice = product.purchasePrice || undefined
  if (!line.quantity) line.quantity = 1
}
// ── #203: client reservations staged in the form, saved with the order (`reservationChanges`) ──
interface StagedCreate { key: string; alloc: { id?: string; key?: string }; contactId: string; quantity: number; repeatOf?: string }
const staged = reactive({
  creates: [] as StagedCreate[],
  updates: {} as Record<string, { quantity?: number; contactId?: string }>,
  cancels: [] as string[],
})
const hasStaged = computed(() => staged.creates.length > 0 || Object.keys(staged.updates).length > 0 || staged.cancels.length > 0)
function clearStaged() {
  staged.creates = []
  staged.updates = {}
  staged.cancels = []
}
const isOn = (ref: { id?: string; key?: string }, alloc: AllocRow) =>
  (!!ref.id && !!alloc._id && String(ref.id) === String(alloc._id)) || (!!ref.key && ref.key === alloc._key)

interface ResRow {
  key: string; resId?: string; createKey?: string; number?: string; contactId: string; quantity: number
  invoiced: number; dispatched: number; consumed: number; internalOrderId?: string
  cancelled: boolean; editable: boolean; cancellable: boolean; canChangeClient: boolean
}
/** An allocation's reservations as the form now has them: saved ones with their staged changes, then the new ones. */
function allocRows(alloc: AllocRow): ResRow[] {
  const rows: ResRow[] = []
  if (alloc._id) {
    for (const r of resByAlloc.value.get(String(alloc._id)) || []) {
      const u = staged.updates[r._id] || {}
      const cancelled = staged.cancels.includes(r._id)
      const invoiced = Number(r.invoicedQuantity) || 0
      const dispatched = Number(r.dispatchedQuantity) || 0
      const consumed = Math.max(invoiced, dispatched)
      rows.push({
        key: r._id, resId: r._id, number: r.reservationNumber, contactId: String(u.contactId ?? r.contactId),
        quantity: u.quantity ?? Number(r.quantity) ?? 0, invoiced, dispatched, consumed,
        internalOrderId: r.internalOrderId ? String(r.internalOrderId) : undefined,
        cancelled, editable: !readonly.value && !cancelled && r.status === 'active',
        cancellable: r.status === 'active',
        canChangeClient: consumed <= 0 && !r.internalOrderId,
      })
    }
  }
  for (const c of staged.creates) {
    if (!isOn(c.alloc, alloc)) continue
    rows.push({
      key: c.key, createKey: c.key, contactId: c.contactId, quantity: c.quantity, invoiced: 0, dispatched: 0, consumed: 0,
      cancelled: false, editable: !readonly.value, cancellable: true, canChangeClient: true,
    })
  }
  return rows
}
function allocReserved(alloc: AllocRow) {
  return allocRows(alloc).reduce((s, r) => s + (r.cancelled ? r.consumed : Number(r.quantity) || 0), 0)
}
function allocFree(alloc: AllocRow) { return Math.max(0, (Number(alloc.quantity) || 0) - allocReserved(alloc)) }
function allocClientSummary(alloc: AllocRow) {
  return allocRows(alloc).filter(r => !r.cancelled).map(r => `${contactNames.value[r.contactId] || '—'} ${r.quantity}`).join(', ')
}
function setRowQuantity(row: ResRow, q: number) {
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
function removeRow(row: ResRow) {
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
function allocatedQty(line: LineRow) { return line.allocations.reduce((s, a) => s + (Number(a.quantity) || 0), 0) }
function unallocated(line: LineRow) { return Math.max(0, (Number(line.quantity) || 0) - allocatedQty(line)) }
function overAllocated(line: LineRow) { return allocatedQty(line) > (Number(line.quantity) || 0) }

function addGroup() { form.supplierGroups.push(emptyGroup()) }
function removeGroup(gi: number) { form.supplierGroups.splice(gi, 1) }

const totalOrdered = computed(() => form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.quantity) || 0), 0), 0))
const totalReceived = computed(() => form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.receivedQuantity) || 0), 0), 0))
const totalReserved = computed(() => activeReservations.value.reduce((s, r) => s + (Number(r.quantity) || 0), 0))
const estimatedTotal = computed(() =>
  form.supplierGroups.reduce((s, g) => s + g.lines.reduce((ls, l) => ls + (Number(l.quantity) || 0) * (Number(l.expectedUnitPrice) || 0), 0), 0),
)

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
const { markSaved, tryRestore } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'order',
  icon: 'mdi-clipboard-list-outline',
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
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      await loadOrder(undefined, { clearStaged: true })
    } else {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/orders`, buildPayload())
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      router.replace({ name: 'invoicing.orders.edit', params: { id: data.order._id } })
      orderNumber.value = data.order.orderNumber
      orderStatus.value = data.order.status
      await loadOrder(data.order._id, { clearStaged: true })
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function doAction(path: string, successKey: string) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoicing/orders/${route.params.id}/${path}`)
    showSuccess(t(successKey))
    // A completed or cancelled order is read-only, so what was staged on it can never be saved.
    // After Send the order stays open and the staged changes stay with it.
    await loadOrder(undefined, { clearStaged: path === 'complete' || path === 'cancel' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}
function sendOrder() { doAction('send', 'invoicing.orderSent') }
function completeOrder() { doAction('complete', 'invoicing.orderCompleted') }
function cancelOrder() { doAction('cancel', 'invoicing.orderCancelled') }

async function deleteOrder() {
  if (!confirm(t('invoicing.deleteOrderConfirm'))) return
  try {
    await httpClient.delete(`${orgUrl()}/invoicing/orders/${route.params.id}`)
    showSuccess(t('common.deletedSuccessfully'))
    router.push({ name: 'invoicing.orders' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

// ── reservations (create / cancel RES- documents) ──
// #203: the dialog stages; nothing is posted until the order is saved, and the form is never reloaded
// under the user's edits.
const reserveDialog = reactive({
  open: false,
  contactId: '',
  quantity: 0,
  description: '',
  free: 0,
  warehouseId: '',
  alloc: { id: undefined as string | undefined, key: undefined as string | undefined },
  /** Set when the dialog changes the client of an existing or staged row. */
  row: null as ResRow | null,
})

function openReserveDialog(line: LineRow, alloc: AllocRow) {
  reserveDialog.row = null
  reserveDialog.contactId = ''
  reserveDialog.quantity = allocFree(alloc)
  reserveDialog.description = line.description
  reserveDialog.free = allocFree(alloc)
  reserveDialog.warehouseId = alloc.warehouseId
  reserveDialog.alloc = alloc._id ? { id: String(alloc._id), key: undefined } : { id: undefined, key: alloc._key }
  reserveDialog.open = true
}

function openClientChange(row: ResRow, line: LineRow, alloc: AllocRow) {
  reserveDialog.row = row
  reserveDialog.contactId = row.contactId
  reserveDialog.quantity = row.quantity
  reserveDialog.description = line.description
  reserveDialog.free = allocFree(alloc) + row.quantity
  reserveDialog.warehouseId = alloc.warehouseId
  reserveDialog.alloc = alloc._id ? { id: String(alloc._id), key: undefined } : { id: undefined, key: alloc._key }
  reserveDialog.open = true
}

function submitReservation() {
  const row = reserveDialog.row
  if (!row) {
    staged.creates.push({ key: newKey(), alloc: { ...reserveDialog.alloc }, contactId: reserveDialog.contactId, quantity: reserveDialog.quantity })
  } else if (row.createKey) {
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
        // #203: a line whose allocations carry reservations opens, so they are seen, not hidden.
        _expanded: (data.reservations || []).some((r: any) => r.status !== 'cancelled' && String(r.lineId) === String(l._id)),
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
  if (isEdit.value) await loadOrder()
  else fetchPeekedNumber()
})
</script>
