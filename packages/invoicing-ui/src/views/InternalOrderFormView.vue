<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editInternalOrder') : $t('invoicing.newInternalOrder')"
    :subtitle="documentNumber"
    :status="statusDef"
    :actions="formActions"
    :loading="loading"
    back-to="/internal-orders"
    :back-label="$t('nav.internalOrders')"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
  >
    <template #document-header>
      <div class="d-flex align-center justify-space-between px-4 py-3 ga-4 flex-wrap">
        <div class="d-flex align-center ga-3">
          <v-avatar size="36" color="primary" variant="tonal">
            <v-icon size="20">mdi-account-clock-outline</v-icon>
          </v-avatar>
          <div>
            <div class="text-overline text-medium-emphasis">{{ appStore.currentOrg?.name || '—' }}</div>
            <div class="text-subtitle-1 font-weight-bold">{{ isEdit ? $t('invoicing.editInternalOrder') : $t('invoicing.newInternalOrder') }}</div>
          </div>
        </div>
        <div class="text-end">
          <div class="text-h6 font-weight-bold">{{ documentNumber || '—' }}</div>
          <div class="d-flex ga-1 justify-end mt-1">
            <v-chip size="x-small" label color="primary" variant="tonal">
              {{ $t(`invoicing.status.${orderStatus}`) }}
            </v-chip>
            <v-chip v-if="isEdit" size="x-small" label variant="tonal" :color="coverageColor(coverage)">
              {{ $t(`invoicing.coverage.${coverage}`) }}
            </v-chip>
          </div>
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

        <!-- Lines -->
        <v-card variant="outlined" rounded="lg" class="mt-2">
          <v-card-text class="pa-2">
            <div ref="linesRef" style="overflow-x: auto">
              <v-table density="compact">
                <thead>
                  <tr>
                    <th style="width:45%;min-width:45vw">{{ $t('common.description') }}</th>
                    <th class="text-end" style="width: 110px">{{ $t('invoicing.qty') }}</th>
                    <th style="width:110px;min-width:110px">{{ $t('invoicing.unit') }}</th>
                    <th class="text-end" style="width: 130px">{{ $t('invoicing.expectedPrice') }}</th>
                    <th v-if="isEdit" style="min-width: 180px">{{ $t('invoicing.coverage.label') }}</th>
                    <th style="width: 40px"></th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="(line, li) in form.lines" :key="line._id || li">
                  <!-- The blank line waiting for the next article (FR-22.43) is not shown once nothing can be added. -->
                  <tr v-if="!readonly || line.productId || line.description">
                    <td style="min-width:160px">
                      <div class="d-flex align-center ga-1">
                        <ProductLineDescription
                          :description="line.description"
                          :product-id="line.productId"
                          price-field="sellingPrice"
                          class="flex-grow-1"
                          @update:description="line.description = $event"
                          @update:product-id="line.productId = $event"
                          @product-selected="onProductSelected(line, $event)"
                          @product-cleared="line.productId = undefined"
                        />
                        <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.browseProducts')" :aria-label="$t('invoicing.browseProducts')" @click="openProductPicker(li)" />
                      </div>
                    </td>
                    <td>
                      <v-text-field v-model.number="line.quantity" type="number" min="0" density="compact" hide-details variant="underlined" style="min-width: 100px" :readonly="readonly" :data-line-qty="li" :aria-label="$t('invoicing.qty')" />
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
                    <td v-if="isEdit">
                      <div v-if="line._id" class="d-flex align-center ga-1 flex-wrap">
                        <!-- FR-22.44: a line whose cover waits on a supplier order not sent yet reads „Поръчана". -->
                        <v-chip
                          size="x-small"
                          variant="tonal"
                          :color="lineCoverageColor(line)"
                          :title="figuresOf(line).onUnsentOrder > 0 ? $t('invoicing.onUnsentOrder', { count: figuresOf(line).onUnsentOrder }) : undefined"
                        >
                          {{ lineCoverageOf(line).status === 'ordered' ? $t('invoicing.coverage.ordered') : $t('invoicing.reservedQty') }}: {{ figuresOf(line).reserved }}/{{ line.quantity || 0 }}
                        </v-chip>
                        <v-chip v-if="figuresOf(line).delivered > 0" size="x-small" variant="tonal" color="success">
                          {{ $t('invoicing.deliveredQty') }}: {{ figuresOf(line).delivered }}
                        </v-chip>
                      </div>
                    </td>
                    <td>
                      <v-btn v-if="!readonly" icon="mdi-close" size="x-small" variant="text" tabindex="-1" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="form.lines.splice(li, 1)" />
                    </td>
                  </tr>
                  <!-- #203: the line's reservations, where the line is — changed, cancelled or made again here. -->
                  <tr v-if="isEdit && line._id && lineReservations(line).length">
                    <td :colspan="6" class="pt-0 pb-2">
                      <div v-for="res in lineReservations(line)" :key="res._id" class="d-flex align-center flex-wrap ga-2 text-body-2 ps-2">
                        <v-icon size="14" :color="resStatusColor(res.status)">mdi-lock-clock</v-icon>
                        <EntityLink :label="res.reservationNumber" :to="{ name: 'invoicing.reservations.detail', params: { id: String(res._id) } }" />
                        <v-chip
                          size="x-small"
                          variant="tonal"
                          :color="res.source === 'order' ? 'info' : undefined"
                          :to="res.source === 'order' && res.orderId ? { name: 'invoicing.orders.edit', params: { id: String(res.orderId) } } : undefined"
                        >
                          {{ res.source === 'order' ? (orderNumbers[String(res.orderId)] || 'ORDO') : $t('invoicing.sourceStock') }}
                        </v-chip>
                        <span class="text-medium-emphasis">{{ warehouseName(res.warehouseId) }}</span>
                        <span>{{ $t('invoicing.qty') }}: {{ res.quantity }}</span>
                        <span v-if="res.invoicedQuantity || res.dispatchedQuantity" class="text-medium-emphasis">
                          ({{ $t('invoicing.invoicedQty') }} {{ res.invoicedQuantity || 0 }} · {{ $t('invoicing.dispatchedQty') }} {{ res.dispatchedQuantity || 0 }})
                        </span>
                        <v-chip size="x-small" label variant="tonal" :color="resStatusColor(res.status)">{{ $t(`invoicing.status.${res.status}`) }}</v-chip>
                        <v-btn v-if="res.status === 'active' && !readonly" icon="mdi-pencil" size="x-small" variant="text" :title="$t('invoicing.reservations.changeQuantity')" :aria-label="$t('invoicing.reservations.changeQuantity')" @click="openResEdit(res)" />
                        <v-btn v-if="res.status === 'active' && !readonly" icon="mdi-close" size="x-small" variant="text" color="error" :title="$t('invoicing.reservations.release')" :aria-label="$t('invoicing.reservations.release')" @click="openRelease(res)" />
                        <v-btn v-if="res.status === 'cancelled' && canReserve" icon="mdi-restore" size="x-small" variant="text" color="primary" :loading="repeating === res._id" :title="$t('invoicing.reservations.reserveAgain')" :aria-label="$t('invoicing.reservations.reserveAgain')" @click="reserveAgain(res)" />
                      </div>
                    </td>
                  </tr>
                  </template>
                </tbody>
              </v-table>
            </div>
            <v-btn v-if="!readonly" color="primary" variant="text" size="small" prepend-icon="mdi-plus" class="mt-1" @click="form.lines.push(emptyLine())">
              {{ $t('invoicing.addLine') }}
            </v-btn>
          </v-card-text>
        </v-card>

        <!-- Coverage toolbox + linked reservations -->
        <v-card v-if="isEdit" variant="outlined" rounded="lg" class="mt-4">
          <v-card-title class="d-flex align-center ga-2 py-2 flex-wrap">
            <v-icon size="20" color="primary">mdi-lock-clock</v-icon>
            {{ $t('nav.reservations') }}
            <v-chip size="x-small" variant="tonal">{{ activeReservations.length }}</v-chip>
            <v-spacer />
            <template v-if="canReserve">
              <v-btn size="small" variant="outlined" color="primary" prepend-icon="mdi-warehouse" :loading="reserving" @click="reserveAvailable">
                {{ $t('invoicing.reserveAvailable') }}
              </v-btn>
              <v-btn size="small" variant="outlined" color="warning" prepend-icon="mdi-shield-search" @click="openCoverDialog">
                {{ $t('invoicing.coverShortages') }}
              </v-btn>
              <v-btn size="small" variant="outlined" prepend-icon="mdi-factory" @click="openGenerateDialog">
                {{ $t('invoicing.generateExternalOrder') }}
              </v-btn>
            </template>
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
                        :to="res.orderId ? { name: 'invoicing.orders.edit', params: { id: String(res.orderId) } } : undefined"
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
                        @click="openRelease(res)"
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
                        @click="reserveAgain(res)"
                      />
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>
          </v-card-text>
        </v-card>
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

        <!-- Notes / terms / tags + totals -->
        <v-row class="mt-4">
          <v-col cols="12" md="6">
            <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="2" auto-grow :readonly="readonly" />
            <v-textarea v-model="form.terms" :label="$t('invoicing.terms')" rows="2" auto-grow :readonly="readonly" />
            <TagInput v-model="form.tags" type="internal_order" :org-url="orgUrl()" class="mt-2" />
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
                  <span>{{ $t('invoicing.deliveredQty') }}</span>
                  <span>{{ totalDelivered }}</span>
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
      <EntityNotesPanel :org-url="orgUrl()" entity-type="internal_order" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ProductPickerDialog v-model="productPickerOpen" :org-url="orgUrl()" :base-currency="baseCurrency" :locale="localeCode" @select="onProductPicked" />
    <ContactPickerDialog v-model="contactPickerOpen" :org-url="orgUrl()" :type="contactPickerTarget?.kind === 'supplier' ? 'supplier' : 'customer'" @select="onContactPicked" />

    <!-- Cover-shortages dialog: free stock → unreserved incoming → preemptable reservations -->
    <v-dialog v-model="coverDialog" max-width="860" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center ga-2">
          <v-icon color="warning">mdi-shield-search</v-icon>
          {{ $t('invoicing.coverShortages') }}
          <v-spacer />
          <v-btn icon="mdi-refresh" size="small" variant="text" :loading="loadingSuggestions" @click="loadSuggestions" />
        </v-card-title>
        <v-card-text>
          <div v-if="loadingSuggestions" class="text-center pa-4"><v-progress-circular indeterminate /></div>
          <div v-else-if="!suggestions.length" class="text-medium-emphasis pa-4">{{ $t('invoicing.noShortages') }}</div>
          <div v-for="line in suggestions" :key="line.lineId" class="mb-4">
            <div class="text-subtitle-2 mb-1">
              {{ sugLookup.products?.[line.productId]?.name || line.productId }}
              — {{ $t('invoicing.shortQty') }}: <b>{{ line.openQuantity }}</b>
            </div>

            <div v-if="line.freeStock.length" class="mb-2">
              <div class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.freeStock') }}</div>
              <div v-for="fs in line.freeStock" :key="fs.warehouseId" class="d-flex align-center ga-2 mb-1">
                <v-chip size="x-small" variant="tonal">{{ sugLookup.warehouses?.[fs.warehouseId] || fs.warehouseId }}</v-chip>
                <span class="text-caption">{{ $t('invoicing.freeQty') }}: {{ fs.available }}</span>
                <v-text-field v-model.number="fs._qty" type="number" min="0" density="compact" variant="underlined" hide-details style="max-width: 100px" />
                <v-btn size="x-small" color="primary" variant="tonal" :loading="acting" @click="reserveFromStock(line, fs)">{{ $t('invoicing.reserve') }}</v-btn>
              </div>
            </div>

            <div v-if="line.incoming.length" class="mb-2">
              <div class="text-caption text-medium-emphasis mb-1">{{ $t('invoicing.incomingStock') }}</div>
              <div v-for="inc in line.incoming" :key="inc.allocationId" class="d-flex align-center ga-2 mb-1 flex-wrap">
                <v-chip size="x-small" variant="tonal" color="info">{{ inc.orderNumber }}</v-chip>
                <v-chip size="x-small" variant="tonal">{{ sugLookup.warehouses?.[inc.warehouseId] || '' }}</v-chip>
                <span class="text-caption">
                  {{ inc.unreserved }}
                  <template v-if="inc.expectedDate"> · {{ inc.expectedDate.split('T')[0] }}</template>
                </span>
                <v-icon v-if="inc.late" size="14" color="error" :title="$t('invoicing.lateDelivery')">mdi-clock-alert-outline</v-icon>
                <v-text-field v-model.number="inc._qty" type="number" min="0" density="compact" variant="underlined" hide-details style="max-width: 100px" />
                <v-btn size="x-small" color="primary" variant="tonal" :loading="acting" @click="reserveFromOrder(line, inc)">{{ $t('invoicing.reserve') }}</v-btn>
              </div>
            </div>

            <div v-if="line.preemptable.length" class="mb-2">
              <div class="text-caption text-medium-emphasis mb-1">
                {{ $t('invoicing.preemptable') }}
                <span v-if="line.preemptableTotal > line.preemptable.length">({{ line.preemptable.length }}/{{ line.preemptableTotal }})</span>
              </div>
              <div v-for="p in line.preemptable" :key="p.reservationId" class="d-flex align-center ga-2 mb-1 flex-wrap">
                <v-chip size="x-small" variant="tonal">{{ p.reservationNumber }}</v-chip>
                <span class="text-caption">
                  {{ sugLookup.contacts?.[p.contactId] || '' }}
                  <template v-if="p.internalOrderNumber"> · {{ p.internalOrderNumber }}</template>
                  <template v-if="p.requestedDeliveryDate"> · {{ p.requestedDeliveryDate.split('T')[0] }}</template>
                  · {{ $t('invoicing.releasableQty') }}: {{ p.releasable }}
                </span>
                <v-text-field v-model.number="p._qty" type="number" min="0" density="compact" variant="underlined" hide-details style="max-width: 100px" />
                <v-btn size="x-small" color="warning" variant="tonal" :loading="acting" @click="preempt(line, p)">{{ $t('invoicing.preempt') }}</v-btn>
              </div>
            </div>
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="coverDialog = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Generate-external-order dialog -->
    <v-dialog v-model="generateDialog" max-width="720">
      <v-card>
        <v-card-title class="d-flex align-center ga-2">
          <v-icon color="primary">mdi-factory</v-icon>
          {{ $t('invoicing.generateExternalOrder') }}
        </v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('invoicing.generateExternalHint') }}</p>
          <div v-if="!generateRows.length" class="text-medium-emphasis pa-2">{{ $t('invoicing.noShortages') }}</div>
          <div v-for="row in generateRows" :key="row.internalOrderLineId" class="d-flex align-center ga-2 mb-2 flex-wrap">
            <div style="min-width: 200px" class="flex-grow-1 text-body-2">{{ row.description }}</div>
            <v-text-field v-model.number="row.quantity" type="number" min="0" :label="$t('invoicing.qty')" density="compact" variant="outlined" hide-details style="max-width: 110px" />
            <v-autocomplete
              v-model="row.supplierId"
              :items="supplierOptions"
              item-title="companyName"
              item-value="_id"
              :label="$t('invoicing.supplier')"
              density="compact"
              variant="outlined"
              no-filter
              hide-details
              style="min-width: 220px"
              :loading="loadingContacts"
              @update:search="(s: string) => onContactSearch(s, 'supplier')"
            />
            <!-- FR-22.42: where the goods go, said up front — the order's warehouse, else the default one. -->
            <v-autocomplete v-model="row.warehouseId" :items="warehouses" item-title="name" item-value="_id" :label="$t('invoicing.toWarehouse')" density="compact" variant="outlined" hide-details style="min-width: 180px" />
          </div>
          <!-- FR-22.42: a draft supplier order of the same supplier can take the lines, instead of a new one. -->
          <v-select
            v-if="generateRows.length"
            v-model="generateTarget"
            :items="generateTargets"
            item-title="title"
            item-value="value"
            :label="$t('invoicing.generateInto')"
            :hint="generateTargets.length > 1 ? $t('invoicing.generateIntoHint') : ''"
            persistent-hint
            density="compact"
            variant="outlined"
            class="mt-4"
            data-testid="generate-target"
            @update:model-value="generateTargetTouched = true"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="generateDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="generating" :disabled="!generateRows.some(r => r.quantity > 0 && r.supplierId)" @click="submitGenerate">
            {{ generateTarget === 'new' ? $t('common.create') : $t('invoicing.addToOrder') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell, { type FormAction, type StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ContactPickerDialog from 'ui-shared/components/ContactPickerDialog'
import ProductLineDescription from '../components/ProductLineDescription.vue'
import { useConversionFeedback } from '../composables/useConversionFeedback'
import ReservationQuantityDialog from '../components/ReservationQuantityDialog.vue'
import ReservationReleaseDialog from '../components/ReservationReleaseDialog.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import { reservationErrorMessage } from '../composables/reservation-errors'
import { lineCoverage, orderCoverage } from 'config/order-coverage'
import { asDraftOrder, defaultDraftFor, pickDraftsFor, type DraftOrder } from '../composables/order-generate'
import { cascadeSummary } from '../composables/order-cascade'
import OrderCascadeDialog from '../components/OrderCascadeDialog.vue'

/** A line as the user edits it. What the server derives for it lives in `lineFigures`, not here. */
interface LineRow {
  _id?: string
  productId?: string
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  taxRate?: number
}

/** A saved line's figures, derived by the server from its reservations and invoices. */
interface LineFigures {
  reserved: number
  /** Of `reserved`, what waits on a supplier order not sent yet (FR-22.44). */
  onUnsentOrder: number
  invoiced: number
  delivered: number
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError, showSnackbar } = useSnackbar()
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
const readonly = computed(() => ['completed', 'cancelled', 'delivered'].includes(orderStatus.value))
const canReserve = computed(() => ['confirmed', 'partially_delivered'].includes(orderStatus.value))

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => (({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' } as Record<string, string>)[appStore.locale] || 'en-US'))
const rules = { required: (v: string) => !!v || t('validation.required') }

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function fmtCurrency(amount: number) { return formatCurrency(amount, form.currency || baseCurrency.value, localeCode.value) }
function emptyLine(): LineRow { return { description: '', quantity: 0, unit: 'pcs' } }

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

// ── reservations + lookups ──
const reservations = ref<any[]>([])
const orderNumbers = ref<Record<string, string>>({})
const activeReservations = computed(() => reservations.value.filter((r) => r.status !== 'cancelled'))
function resStatusColor(status: string) {
  return status === 'active' ? 'primary' : status === 'fulfilled' ? 'success' : 'error'
}
/** #203: a line's reservations, shown under it. */
function lineReservations(line: any) {
  return reservations.value.filter((r) => String(r.internalOrderLineId) === String(line._id))
}
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
const NO_FIGURES: LineFigures = { reserved: 0, onUnsentOrder: 0, invoiced: 0, delivered: 0 }
function figuresOf(line: LineRow): LineFigures {
  return (line._id && lineFigures.value[String(line._id)]) || NO_FIGURES
}
function takeFigures(lines: any[]) {
  lineFigures.value = Object.fromEntries((lines || []).map((l: any) => [String(l._id), {
    reserved: Number(l.reservedQuantity) || 0,
    onUnsentOrder: Number(l.onUnsentOrderQuantity) || 0,
    invoiced: Number(l.invoicedQuantity) || 0,
    delivered: Number(l.deliveredQuantity) || 0,
  }]))
}
/** The reservations, their orders' numbers and the names, as GET /internal-orders/:id answers them. */
function takeReservations(data: any) {
  reservations.value = data.reservations || []
  if (data.lookup?.contacts) Object.assign(contactNames.value, data.lookup.contacts)
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
    takeFigures(data.internalOrder.lines)
    takeReservations(data)
  } catch {
    showError(t('common.operationFailed'))
  }
}

function isLate(res: any) {
  return !!(res.expectedDate && form.requestedDeliveryDate && res.expectedDate.split('T')[0] > form.requestedDeliveryDate)
}
/** FR-22.44: covered on stock (`full`), or partly only by a supplier order not sent yet (`ordered`). */
function coverageInput(line: LineRow) {
  const f = figuresOf(line)
  return { quantity: line.quantity, reserved: f.reserved, onUnsentOrder: f.onUnsentOrder }
}
const coverage = computed(() => orderCoverage(form.lines.map(coverageInput)).status)
function lineCoverageOf(line: LineRow) { return lineCoverage(coverageInput(line)) }
function coverageColor(c: string) { return ({ none: 'error', partial: 'warning', ordered: 'info', full: 'success' }[c] || 'grey') }
function lineCoverageColor(line: LineRow) { return coverageColor(lineCoverageOf(line).status) }

// ── contacts (server-searched pools) + warehouses ──
const clientOptions = ref<any[]>([])
const supplierOptions = ref<any[]>([])
const loadingContacts = ref(false)
const warehouses = ref<Array<{ _id: string; name: string; isDefault?: boolean }>>([])
const contactNames = ref<Record<string, string>>({})

let contactSearchTimer: ReturnType<typeof setTimeout> | null = null
function onContactSearch(text: string, pool: 'client' | 'supplier') {
  if (contactSearchTimer) clearTimeout(contactSearchTimer)
  contactSearchTimer = setTimeout(() => fetchContacts(pool, text || undefined), 300)
}

async function fetchContacts(pool: 'client' | 'supplier', search?: string) {
  loadingContacts.value = true
  try {
    const params: Record<string, any> = { size: 20 }
    if (pool === 'supplier') params.type = 'supplier'
    if (search) params.search = search
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params })
    const items = data.contacts || []
    const merged = [...items]
    if (pool === 'client' && form.contactId && contactNames.value[form.contactId] && !merged.some((c: any) => c._id === form.contactId)) {
      merged.push({ _id: form.contactId, companyName: contactNames.value[form.contactId] })
    }
    if (pool === 'client') clientOptions.value = merged
    else supplierOptions.value = merged
    for (const c of items) contactNames.value[c._id] = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')
  } catch { /* */ } finally {
    loadingContacts.value = false
  }
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } })
    warehouses.value = data.warehouses || []
  } catch { /* */ }
}
function warehouseName(id: string) { return warehouses.value.find((w) => w._id === String(id))?.name || '—' }

// ── pickers ──
const productPickerOpen = ref(false)
const productPickerTarget = ref<number | null>(null)
function openProductPicker(li: number) {
  productPickerTarget.value = li
  productPickerOpen.value = true
}
function onProductPicked(p: any) {
  const line = productPickerTarget.value !== null ? form.lines[productPickerTarget.value] : undefined
  if (!line) return
  line.productId = p._id
  line.description = p.name
  onProductSelected(line, p)
}

type ContactPickTarget = { kind: 'client' } | { kind: 'supplier' }
const contactPickerOpen = ref(false)
const contactPickerTarget = ref<ContactPickTarget | null>(null)
function openContactPicker(target: ContactPickTarget) {
  contactPickerTarget.value = target
  contactPickerOpen.value = true
}
function onContactPicked(c: any) {
  const id = c?._id || c?.id
  if (!id) return
  const name = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')
  contactNames.value[id] = name
  const entry = { _id: id, companyName: name }
  if (contactPickerTarget.value?.kind === 'supplier') {
    if (!supplierOptions.value.some((o) => o._id === id)) supplierOptions.value = [entry, ...supplierOptions.value]
  } else {
    if (!clientOptions.value.some((o) => o._id === id)) clientOptions.value = [entry, ...clientOptions.value]
    form.contactId = id
  }
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
    const input = linesRef.value?.querySelector<HTMLInputElement>(`[data-line-qty="${idx}"] input`)
    if (!input || input.readOnly) return
    input.focus()
    try { input.select() } catch { /* a number input may refuse select() */ }
  }, 200)
}

const totalOrdered = computed(() => form.lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0))
const totalReserved = computed(() => form.lines.reduce((s, l) => s + figuresOf(l).reserved, 0))
const totalDelivered = computed(() => form.lines.reduce((s, l) => s + figuresOf(l).delivered, 0))
const estimatedTotal = computed(() => form.lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.expectedUnitPrice) || 0), 0))

// ── status pipeline + actions ──
const statusDef = computed<StatusDef | undefined>(() => ({
  steps: ['invoicing.status.draft', 'invoicing.status.confirmed', 'invoicing.status.delivered', 'invoicing.status.completed'],
  current: `invoicing.status.${orderStatus.value === 'partially_delivered' ? 'confirmed' : orderStatus.value}`,
  colors: orderStatus.value === 'cancelled' ? { [`invoicing.status.cancelled`]: 'error' } : undefined,
}))

const saving = ref(false)
const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), icon: 'mdi-content-save', handler: onSave, loading: saving.value, show: !readonly.value && ['draft', 'confirmed'].includes(orderStatus.value) },
  { label: t('invoicing.confirmOrder'), icon: 'mdi-check', color: 'success', handler: confirmOrder, show: isEdit.value && orderStatus.value === 'draft' },
  { label: t('invoicing.convertToInvoice'), icon: 'mdi-swap-horizontal', color: 'info', handler: convertOrder, show: isEdit.value && ['confirmed', 'partially_delivered', 'delivered'].includes(orderStatus.value) },
  { label: t('invoicing.completeOrder'), icon: 'mdi-check-all', variant: 'outlined', handler: completeOrder, show: isEdit.value && ['confirmed', 'partially_delivered', 'delivered'].includes(orderStatus.value) },
  { label: t('invoicing.cancelOrder'), icon: 'mdi-cancel', color: 'error', variant: 'outlined', handler: cancelOrder, show: isEdit.value && ['draft', 'confirmed'].includes(orderStatus.value) },
  { label: t('common.delete'), icon: 'mdi-delete', color: 'error', variant: 'text', handler: deleteOrder, show: isEdit.value && orderStatus.value === 'draft' },
])

// ── pending changes ──
const { markSaved, tryRestore, snapshot: snapshotPending } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'internal_order',
  icon: 'mdi-account-clock-outline',
  getFormData: () => JSON.parse(JSON.stringify(form)),
  getPreviewFields: () => [
    { label: 'Date', value: form.issueDate || '' },
    { label: 'Lines', value: String(form.lines.length) },
  ],
  setFormData: (data) => Object.assign(form, data),
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

// ── persistence ──
function buildPayload() {
  return {
    contactId: form.contactId,
    issueDate: form.issueDate,
    requestedDeliveryDate: form.requestedDeliveryDate,
    priority: form.priority,
    warehouseId: form.warehouseId || undefined,
    currency: form.currency,
    exchangeRate: form.exchangeRate || 1,
    notes: form.notes || undefined,
    terms: form.terms || undefined,
    tags: form.tags,
    lines: form.lines
      .filter((l) => l.productId)
      .map((l) => ({
        ...(l._id ? { _id: l._id } : {}),
        productId: l.productId!,
        description: l.description,
        sku: l.sku || undefined,
        quantity: Number(l.quantity) || 0,
        unit: l.unit || 'pcs',
        expectedUnitPrice: l.expectedUnitPrice !== undefined && l.expectedUnitPrice !== null ? Number(l.expectedUnitPrice) : undefined,
        taxRate: l.taxRate,
      })),
  }
}

async function onSave() {
  const { valid } = (await formRef.value?.validate()) || { valid: true }
  if (!valid) return
  if (!form.lines.some((l) => l.productId && (Number(l.quantity) || 0) > 0)) {
    showError(t('invoicing.linesRequired'))
    return
  }
  saving.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoicing/internal-orders/${route.params.id}`, buildPayload())
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      await loadOrder()
    } else {
      const { data } = await httpClient.post(`${orgUrl()}/invoicing/internal-orders`, buildPayload())
      showSuccess(t('common.savedSuccessfully'))
      markSaved()
      router.replace({ name: 'invoicing.internalOrders.edit', params: { id: data.internalOrder._id } })
      orderNumber.value = data.internalOrder.orderNumber
      orderStatus.value = data.internalOrder.status
      await loadOrder(data.internalOrder._id)
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
    await httpClient.post(`${orgUrl()}/invoicing/internal-orders/${route.params.id}/${path}`)
    showSuccess(t(successKey))
    await loadOrder()
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
function confirmOrder() { doAction('confirm', 'invoicing.orderConfirmed') }

// ── FR-22.41: Complete and Cancel say what they release before they do it ──
const cascade = reactive({ open: false, action: 'cancel' as 'cancel' | 'complete', error: '', busy: false })
const cascadeNow = computed(() => cascadeSummary(reservations.value, 'client', orderNumbers.value))
function openCascade(action: 'cancel' | 'complete') {
  cascade.action = action
  cascade.error = ''
  cascade.open = true
}
/** Cancel always asks: it cannot be undone. Complete asks only when it lets reservations go. */
function cancelOrder() { openCascade('cancel') }
function completeOrder() {
  if (cascadeNow.value.count > 0) openCascade('complete')
  else doAction('complete', 'invoicing.orderCompleted')
}
async function confirmCascade() {
  cascade.busy = true
  cascade.error = ''
  const ok = await doAction(cascade.action, cascade.action === 'cancel' ? 'invoicing.orderCancelled' : 'invoicing.orderCompleted', {
    onError: (message) => { cascade.error = message },
  })
  cascade.busy = false
  if (ok) cascade.open = false
}

async function convertOrder() {
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

async function deleteOrder() {
  if (!confirm(t('invoicing.deleteInternalOrderConfirm'))) return
  try {
    await httpClient.delete(`${orgUrl()}/invoicing/internal-orders/${route.params.id}`)
    showSuccess(t('common.deletedSuccessfully'))
    router.push({ name: 'invoicing.internalOrders' })
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
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

// ── cover-shortages dialog ──
const coverDialog = ref(false)
const loadingSuggestions = ref(false)
const acting = ref(false)
const suggestions = ref<any[]>([])
const sugLookup = ref<any>({})

function openCoverDialog() {
  coverDialog.value = true
  loadSuggestions()
}
async function loadSuggestions() {
  loadingSuggestions.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/internal-orders/${route.params.id}/suggestions`)
    for (const line of data.lines || []) {
      for (const fs of line.freeStock) fs._qty = Math.min(line.openQuantity, fs.available)
      for (const inc of line.incoming) inc._qty = Math.min(line.openQuantity, inc.unreserved)
      for (const p of line.preemptable) p._qty = Math.min(line.openQuantity, p.releasable)
    }
    suggestions.value = data.lines || []
    sugLookup.value = data.lookup || {}
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    loadingSuggestions.value = false
  }
}

async function coverAction(fn: () => Promise<any>) {
  acting.value = true
  try {
    await fn()
    showSuccess(t('common.savedSuccessfully'))
    await Promise.all([refreshReservations(), loadSuggestions()])
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    acting.value = false
  }
}
function reserveFromStock(line: any, fs: any) {
  return coverAction(() => httpClient.post(`${orgUrl()}/invoicing/reservations`, {
    source: 'stock',
    productId: line.productId,
    quantity: fs._qty,
    internalOrderId: route.params.id,
    internalOrderLineId: line.lineId,
    warehouseId: fs.warehouseId,
  }))
}
function reserveFromOrder(line: any, inc: any) {
  return coverAction(() => httpClient.post(`${orgUrl()}/invoicing/reservations`, {
    source: 'order',
    productId: line.productId,
    quantity: inc._qty,
    internalOrderId: route.params.id,
    internalOrderLineId: line.lineId,
    orderId: inc.orderId,
    groupId: inc.groupId,
    lineId: inc.lineId,
    allocationId: inc.allocationId,
  }))
}
function preempt(line: any, p: any) {
  if (!confirm(t('invoicing.preemptConfirm', { number: p.reservationNumber }))) return
  return coverAction(() => httpClient.post(`${orgUrl()}/invoicing/reservations/${p.reservationId}/preempt`, {
    internalOrderId: route.params.id,
    internalOrderLineId: line.lineId,
    quantity: p._qty,
  }))
}

// ── generate-external dialog ──
const generateDialog = ref(false)
const generating = ref(false)
const generateRows = ref<any[]>([])
/** 'new', or the id of the draft supplier order the lines are added to (FR-22.42). */
const generateTarget = ref<string>('new')
const generateTargetTouched = ref(false)
const draftOrders = ref<DraftOrder[]>([])

/**
 * The warehouse the goods go to when the dialog leaves it empty — the order's own, else the
 * default one — which is what `generateExternalOrder` falls back to. Shown, not implied.
 */
const fallbackWarehouseId = computed(() => form.warehouseId || warehouses.value.find((w) => w.isDefault)?._id || '')

const generateTargets = computed(() => [
  { value: 'new', title: t('invoicing.generateIntoNew') },
  ...pickDraftsFor(draftOrders.value, generateRows.value.map((r) => r.supplierId)).map((d) => ({
    value: d._id,
    title: t('invoicing.generateIntoDraft', { number: d.orderNumber, suppliers: d.supplierNames.join(', '), lines: d.lineCount }),
  })),
])

// Until the user picks one, the target follows the suppliers: their newest draft, else a new order.
watch(() => generateRows.value.map((r) => r.supplierId).join('|'), () => {
  if (!generateDialog.value || generateTargetTouched.value) return
  generateTarget.value = defaultDraftFor(draftOrders.value, generateRows.value.map((r) => r.supplierId))?._id || 'new'
  if (!generateTargets.value.some((o) => o.value === generateTarget.value)) generateTarget.value = 'new'
})

async function loadDraftOrders() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/orders`, { params: { status: 'draft', size: 100, sortBy: 'createdAt', sortOrder: 'desc' } })
    draftOrders.value = (data.orders || []).map(asDraftOrder)
  } catch {
    draftOrders.value = []
  }
}

async function openGenerateDialog() {
  // Fresh every time: a reservation made since the cover dialog last looked changes what is short.
  await Promise.all([loadSuggestions(), loadDraftOrders()])
  generateRows.value = suggestions.value.map((line) => ({
    internalOrderLineId: line.lineId,
    description: sugLookup.value.products?.[line.productId]?.name || line.productId,
    quantity: line.openQuantity,
    supplierId: line.supplierHint?.supplierId || '',
    warehouseId: fallbackWarehouseId.value,
  }))
  // Make hinted suppliers resolvable in the autocomplete.
  for (const row of generateRows.value) {
    if (row.supplierId && sugLookup.value.contacts?.[row.supplierId] && !supplierOptions.value.some((o) => o._id === row.supplierId)) {
      supplierOptions.value = [{ _id: row.supplierId, companyName: sugLookup.value.contacts[row.supplierId] }, ...supplierOptions.value]
    }
  }
  generateTargetTouched.value = false
  generateTarget.value = defaultDraftFor(draftOrders.value, generateRows.value.map((r) => r.supplierId))?._id || 'new'
  generateDialog.value = true
}

async function submitGenerate() {
  const lines = generateRows.value
    .filter((r) => r.quantity > 0 && r.supplierId)
    .map((r) => ({
      internalOrderLineId: r.internalOrderLineId,
      quantity: r.quantity,
      supplierId: r.supplierId,
      warehouseId: r.warehouseId || undefined,
    }))
  if (!lines.length) return
  generating.value = true
  const appending = generateTarget.value !== 'new'
  try {
    const { data } = await httpClient.post(`${orgUrl()}/invoicing/internal-orders/${route.params.id}/generate-external`, {
      lines,
      ...(appending ? { orderId: generateTarget.value } : {}),
    })
    showSuccess(t(appending ? 'invoicing.externalOrderAppended' : 'invoicing.externalOrderCreated', { number: data.order.orderNumber }))
    generateDialog.value = false
    // FR-22.35: the user lands on the supplier order — the next step is sending it.
    await router.push({ name: 'invoicing.orders.edit', params: { id: String(data.order._id) } })
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    generating.value = false
  }
}

// ── loading ──
async function loadOrder(id?: string) {
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
    form.lines = (o.lines || []).map((l: any) => ({
      _id: l._id,
      productId: l.productId ? String(l.productId) : undefined,
      description: l.description || '',
      sku: l.sku,
      quantity: l.quantity || 0,
      unit: l.unit || 'pcs',
      expectedUnitPrice: l.expectedUnitPrice,
      taxRate: l.taxRate,
    }))
    // FR-22.43: a blank line waits for the next article while lines can still be added.
    if (canAddLines.value) form.lines.push(emptyLine())
    takeFigures(o.lines)
    takeReservations(data)
    if (form.contactId && contactNames.value[form.contactId] && !clientOptions.value.some((c: any) => c._id === form.contactId)) {
      clientOptions.value = [{ _id: form.contactId, companyName: contactNames.value[form.contactId] }, ...clientOptions.value]
    }
    // FR-22.13: what was just loaded is the clean state. The composable's own snapshot runs on a
    // 500 ms timer from mount, so a slower load counted as an edit, and so did every reload after
    // Confirm, Complete or Convert: leaving an untouched order asked to keep „Незапазени промени".
    snapshotPending()
  } catch {
    showError(t('common.operationFailed'))
  }
}

async function fetchPeekedNumber() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/internal-orders/peek-next`)
    peekedNumber.value = data.next || ''
  } catch { /* */ }
}

onMounted(async () => {
  await Promise.all([fetchContacts('client'), fetchWarehouses()])
  if (tryRestore()) return
  if (isEdit.value) await loadOrder()
  else fetchPeekedNumber()
})
</script>
