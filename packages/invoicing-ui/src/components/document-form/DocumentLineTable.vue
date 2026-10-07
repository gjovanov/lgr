<template>
  <div>
    <div class="d-flex align-center mt-4 mb-2">
      <h3 class="text-subtitle-2 font-weight-bold">{{ $t('invoicing.lineItems') }}</h3>
      <v-chip
        v-if="config.supportsProductUpdate"
        class="ml-3"
        size="small"
        :color="withProductUpdate ? 'primary' : undefined"
        :variant="withProductUpdate ? 'flat' : 'outlined'"
      >
        <v-switch v-model="withProductUpdate" density="compact" hide-details class="mr-2" color="white" style="width: 36px" />
        {{ $t(withProductUpdate ? 'warehouse.withProductUpdate' : 'warehouse.withoutProductUpdate') }}
      </v-chip>
      <v-btn v-if="grColumnsVisible" class="ml-2" size="small" variant="outlined" prepend-icon="mdi-view-column-outline" @click="grColumnPickerOpen = true">
        {{ $t('warehouse.grPicker.button', { n: grActiveColumns.length }) }}
      </v-btn>
      <v-spacer />
      <v-btn color="primary" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">
        {{ $t('invoicing.addLine') }}
      </v-btn>
      <v-btn class="ml-2" variant="outlined" size="small" icon="mdi-cog" :title="$t('invoicing.linePicker.title')" :aria-label="$t('invoicing.linePicker.title')" @click="columnPickerOpen = true" />
    </div>

    <!-- Doc-level single-value controls — tax rate / warehouse while the per-line column is hidden,
         and (outgoing documents) one price for every line. Changing a value applies it to every
         line; new lines seed from it. -->
    <div v-if="!isColActive('taxRate') || !isColActive('warehouse') || docPriceEnabled" class="d-flex align-center ga-4 mb-2 flex-wrap">
      <div v-if="!isColActive('taxRate')" style="width: 180px">
        <TaxRateCombobox
          :model-value="docTaxRate"
          :rates="vatRates"
          :default-rate="defaultVatRate"
          :org-url="appStore.orgUrl()"
          :label="$t('invoicing.taxRate')"
          @update:model-value="onDocTaxRateChange"
        />
      </div>
      <div v-if="!isColActive('warehouse')" class="d-flex align-center ga-1" style="width: 280px">
        <v-autocomplete
          :model-value="docWarehouseId"
          :items="warehouses"
          item-title="name"
          item-value="_id"
          :label="$t('warehouse.warehouse')"
          density="compact"
          hide-details
          variant="underlined"
          clearable
          @update:model-value="onDocWarehouseChange"
        />
        <v-btn
          :icon="isPinnedDefaultWarehouse ? 'mdi-pin' : 'mdi-pin-outline'"
          size="x-small"
          variant="text"
          tabindex="-1"
          :color="isPinnedDefaultWarehouse ? 'primary' : undefined"
          :title="$t('invoicing.saveDefaultWarehouse')"
          :aria-label="$t('invoicing.saveDefaultWarehouse')"
          @click="pinDefaultWarehouse"
        />
      </div>
      <!-- One named price (Цена 1…N, selling price, …) for the whole document: each line takes its
           own product's price of that name. The list is what the lines' price pickers offer. -->
      <div v-if="docPriceEnabled" style="width: 280px">
        <v-select
          :model-value="docPriceKey ?? ''"
          :items="docPriceItems"
          item-title="title"
          item-value="value"
          :label="$t('invoicing.docPrice.label')"
          :loading="docPriceLoading"
          :disabled="!hasPricedLines"
          :title="hasPricedLines ? undefined : $t('invoicing.docPrice.noProducts')"
          prepend-inner-icon="mdi-tag-multiple-outline"
          density="compact"
          hide-details
          variant="underlined"
          data-testid="doc-price-select"
          @update:menu="(open: boolean) => open && loadDocPriceChoices()"
          @update:model-value="(key: string) => applyDocPrice(key || null)"
        >
          <template #item="{ item, props: ip }">
            <v-list-item v-bind="ip" :subtitle="item.raw.subtitle" />
          </template>
        </v-select>
      </div>
    </div>

    <LineColumnPickerDialog
      v-model="columnPickerOpen"
      :entries="lineColumnEntries"
      @toggle="toggleCol"
      @reorder="reorderCol"
      @select-all="selectAllCols"
      @select-none="selectNoCols"
      @reset-defaults="resetColDefaults"
    />

    <GRColumnPickerDialog
      v-model="grColumnPickerOpen"
      :selected="grSelectedCols"
      @toggle="grToggleCol"
      @select-all="grSelectAllCols"
      @select-none="grSelectNoCols"
      @reset-defaults="grResetColDefaults"
    />

    <div style="overflow-x: auto;" @keydown.capture="onGridKeydown">
      <!-- The description takes whatever the fixed-width columns leave. It used to demand half the
           viewport (min-width: 50vw), which pushed Price and Total off-screen on a laptop with the
           side panel open — the row could not be read without scrolling sideways. -->
      <v-table density="compact" class="line-table">
      <thead>
        <tr>
          <th class="line-no">{{ $t('invoicing.lineNoShort') }}</th>
          <th style="min-width:220px">{{ $t('common.description') }}</th>
          <th
            v-for="col in activeLineColumns.filter((c) => c.key !== 'description')"
            :key="col.key"
            :class="col.align === 'end' ? 'text-end' : ''"
            :style="col.width ? `width:${col.width};min-width:${col.width}` : ''"
          >{{ $t(col.i18n) }}</th>
          <th
            v-for="col in (grColumnsVisible ? grActiveColumns : [])"
            :key="'gr-' + col.key"
            :class="col.align === 'end' ? 'text-end' : ''"
            style="min-width: 110px"
          >{{ $t(col.i18n) }}</th>
          <th style="width:32px"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(line, idx) in form.lines" :key="idx">
          <td class="line-no text-medium-emphasis">{{ idx + 1 }}</td>
          <td>
            <div class="d-flex align-center ga-1">
              <ProductLineDescription
                :description="line.description"
                :product-id="line.productId"
                :price-field="config.priceField"
                class="flex-grow-1"
                @update:description="line.description = $event"
                @update:product-id="line.productId = $event"
                @product-selected="onProductSelected(idx, $event)"
                @product-cleared="onProductCleared(idx)"
              />
              <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.browseProducts')" :aria-label="$t('invoicing.browseProducts')" @click="openProductPicker(idx)" />
            </div>
          </td>
          <td v-if="isColActive('qty')">
            <!-- the column width (catalog) fits 5-digit quantities plus the number-input spinner -->
            <v-text-field v-model.number="line.quantity" type="number" min="0" density="compact" hide-details variant="underlined" />
          </td>
          <td v-if="isColActive('unit')">
            <v-autocomplete v-model="line.unit" :items="uomOptions" item-title="title" item-value="value" density="compact" hide-details variant="underlined">
              <!-- Closed: localized abbreviation only. Dropdown: abbrev + full name. -->
              <template #selection="{ item }">{{ item.raw.short }}</template>
              <template #item="{ item, props: ip }">
                <v-list-item v-bind="ip" :title="item.raw.short" :subtitle="item.raw.full" />
              </template>
            </v-autocomplete>
          </td>
          <td v-if="isColActive('unitPrice')">
            <div class="d-flex align-center ga-1">
              <!-- Explicit price picker: selling + every named tier (Цена1..N). Sits to the
                   LEFT of the price editor, mirroring the explain-price icon on Total. -->
              <PriceSelectButton
                :product-id="line.productId"
                :contact-id="form.contactId"
                :quantity="line.quantity"
                :org-url="orgUrl()"
                :currency="form.currency"
                @select="onLinePriceSelected(idx, $event)"
              />
              <PriceCombobox
                v-if="config.priceEditor === 'combobox'"
                :model-value="line.unitPrice"
                :product-id="line.productId"
                :contact-id="form.contactId"
                :quantity="line.quantity"
                :org-url="orgUrl()"
                :currency="form.currency"
                :resolved-price="line.resolvedPrice"
                :price-explanation="line.priceExplanation"
                :auto-apply-resolved="!line.loaded && !line.pricePinned"
                class="flex-grow-1"
                @update:model-value="onLinePriceChange(idx, $event)"
                @update:price-explanation="line.priceExplanation = $event"
              />
              <v-text-field
                v-else
                v-model.number="line.unitPrice"
                type="number"
                step="0.0001"
                density="compact"
                hide-details
                variant="underlined"
                class="flex-grow-1"
                @change="onLinePriceManualChange(idx)"
              />
            </div>
          </td>
          <td v-if="isColActive('discount')">
            <v-text-field v-model.number="line.discount" type="number" min="0" max="100" suffix="%" density="compact" hide-details variant="underlined" />
          </td>
          <td v-if="isColActive('lineSubtotal')" class="text-end" style="white-space: nowrap;">
            <PriceExplainButton v-if="!isColActive('lineTotal') && line.priceExplanation?.length" :steps="line.priceExplanation" :currency="form.currency" />
            <span>{{ fmtCurrency(computeLineSubtotal(line)) }}</span>
          </td>
          <td v-if="isColActive('taxRate')">
            <TaxRateCombobox v-model="line.taxRate" :rates="vatRates" :default-rate="defaultVatRate" :org-url="appStore.orgUrl()" />
          </td>
          <td v-if="isColActive('warehouse')">
            <v-autocomplete v-model="line.warehouseId" :items="warehouses" item-title="name" item-value="_id" density="compact" hide-details variant="underlined" clearable />
          </td>
          <td v-if="isColActive('lineTotal')" class="text-end" style="white-space: nowrap;">
            <PriceExplainButton v-if="line.priceExplanation?.length" :steps="line.priceExplanation" :currency="form.currency" />
            <span>{{ fmtCurrency(computeLineTotal(line)) }}</span>
          </td>
          <!-- GR product-update columns (with-product-update toggle ON) -->
          <td v-for="col in (grColumnsVisible ? grActiveColumns : [])" :key="'gr-' + col.key" :class="col.align === 'end' ? 'text-end' : ''">
            <GRProductUpdateCell
              :col="col"
              :product-update="line.productUpdate || {}"
              :price-tiers="line.priceTiers || []"
              :categories="grCategories"
              :uom-options="uomOptions"
              @set-field="(f, v) => setGRField(line, f, v)"
              @set-tier="(i, v) => setGRTierPrice(line, i, v)"
            />
          </td>
          <td>
            <v-btn icon="mdi-close" size="x-small" variant="text" tabindex="-1" :title="$t('common.remove')" :aria-label="$t('common.remove')" @click="removeLine(idx)" />
          </td>
        </tr>
      </tbody>
      </v-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import ProductLineDescription from '../ProductLineDescription.vue'
import PriceCombobox from 'ui-shared/components/PriceCombobox.vue'
import PriceSelectButton from 'ui-shared/components/PriceSelectButton'
import PriceExplainButton from 'ui-shared/components/PriceExplainButton.vue'
import TaxRateCombobox from 'ui-shared/components/TaxRateCombobox'
import LineColumnPickerDialog from 'ui-shared/components/LineColumnPickerDialog.vue'
import GRProductUpdateCell from 'ui-shared/components/GRProductUpdateCell.vue'
import GRColumnPickerDialog from 'ui-shared/components/GRColumnPickerDialog.vue'
import { useGridNavigation } from '../../composables/document-form/useGridNavigation'

const props = defineProps<{ doc: any }>()

const {
  config,
  form,
  warehouses,
  uomOptions,
  vatRates,
  defaultVatRate,
  appStore,
  orgUrl,
  fmtCurrency,
  computeLineTotal,
  computeLineSubtotal,
  docTaxRate,
  docWarehouseId,
  onDocTaxRateChange,
  onDocWarehouseChange,
  pinDefaultWarehouse,
  isPinnedDefaultWarehouse,
  addLine,
  removeLine,
  onProductSelected,
  onProductCleared,
  openProductPicker,
  onLinePriceChange,
  onLinePriceManualChange,
  onLinePriceSelected,
  docPriceEnabled,
  docPriceKey,
  docPriceItems,
  docPriceLoading,
  hasPricedLines,
  loadDocPriceChoices,
  applyDocPrice,
  isColActive,
  columnPickerOpen,
  selectedCols,
  availableLineColumns,
  activeLineColumns,
  lineColumnEntries,
  toggleCol,
  reorderCol,
  selectAllCols,
  selectNoCols,
  resetColDefaults,
  withProductUpdate,
  grColumnPickerOpen,
  grColumnsVisible,
  grSelectedCols,
  grActiveColumns,
  grToggleCol,
  grSelectAllCols,
  grSelectNoCols,
  grResetColDefaults,
  grCategories,
  setGRField,
  setGRTierPrice,
} = props.doc

// Spreadsheet-like Tab/Enter navigation across the line-item cells.
const { onGridKeydown } = useGridNavigation({ addLine, getLines: () => form.lines })
</script>

<style scoped>
/* v-table's 16px cell gutters cost 32px per column — on a grid of up to ten columns that is a
   whole column's worth of width. */
.line-table :deep(th),
.line-table :deep(td) {
  padding-left: 6px !important;
  padding-right: 6px !important;
}
.line-no {
  width: 36px;
  text-align: end;
  white-space: nowrap;
}
</style>
