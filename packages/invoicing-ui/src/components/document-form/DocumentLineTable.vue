<template>
  <div>
    <div class="d-flex align-center mt-4 mb-2">
      <h3 class="text-subtitle-2 font-weight-bold">{{ $t('invoicing.lineItems') }}</h3>
      <v-spacer />
      <v-btn color="primary" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">
        {{ $t('invoicing.addLine') }}
      </v-btn>
      <v-btn class="ml-2" variant="outlined" size="small" icon="mdi-cog" :title="$t('invoicing.linePicker.title')" :aria-label="$t('invoicing.linePicker.title')" @click="columnPickerOpen = true" />
    </div>

    <LineColumnPickerDialog
      v-model="columnPickerOpen"
      :selected="selectedCols"
      :available-columns="availableLineColumns"
      @toggle="toggleCol"
      @select-all="selectAllCols"
      @select-none="selectNoCols"
      @reset-defaults="resetColDefaults"
    />

    <div style="overflow-x: auto;" @keydown.capture="onGridKeydown">
      <v-table density="compact">
      <thead>
        <tr>
          <th>{{ $t('common.description') }}</th>
          <th
            v-for="col in activeLineColumns.filter((c) => c.key !== 'description')"
            :key="col.key"
            :class="col.align === 'end' ? 'text-end' : ''"
            :style="col.width ? `width:${col.width}` : ''"
          >{{ $t(col.i18n) }}</th>
          <th style="width:40px"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(line, idx) in form.lines" :key="idx">
          <td style="min-width:160px">
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
              @update:model-value="onLinePriceChange(idx, $event)"
              @update:price-explanation="line.priceExplanation = $event"
            />
            <v-text-field
              v-else
              v-model.number="line.unitPrice"
              type="number"
              step="0.01"
              density="compact"
              hide-details
              variant="underlined"
              @change="onLinePriceManualChange(idx)"
            />
          </td>
          <td v-if="isColActive('discount')">
            <v-text-field v-model.number="line.discount" type="number" min="0" max="100" suffix="%" density="compact" hide-details variant="underlined" />
          </td>
          <td v-if="isColActive('taxRate')" style="min-width: 120px">
            <TaxRateCombobox v-model="line.taxRate" :rates="vatRates" :default-rate="defaultVatRate" :org-url="appStore.orgUrl()" />
          </td>
          <td v-if="isColActive('warehouse')">
            <v-autocomplete v-model="line.warehouseId" :items="warehouses" item-title="name" item-value="_id" density="compact" hide-details variant="underlined" clearable />
          </td>
          <td v-if="isColActive('lineTotal')" class="text-end" style="white-space: nowrap; min-width: 120px;">
            <span>{{ fmtCurrency(computeLineTotal(line)) }}</span>
            <PriceExplainButton v-if="line.priceExplanation?.length" :steps="line.priceExplanation" :currency="form.currency" />
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
import PriceExplainButton from 'ui-shared/components/PriceExplainButton.vue'
import TaxRateCombobox from 'ui-shared/components/TaxRateCombobox'
import LineColumnPickerDialog from 'ui-shared/components/LineColumnPickerDialog.vue'
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
  addLine,
  removeLine,
  onProductSelected,
  onProductCleared,
  openProductPicker,
  onLinePriceChange,
  onLinePriceManualChange,
  isColActive,
  columnPickerOpen,
  selectedCols,
  availableLineColumns,
  activeLineColumns,
  toggleCol,
  selectAllCols,
  selectNoCols,
  resetColDefaults,
} = props.doc

// Spreadsheet-like Tab/Enter navigation across the line-item cells.
const { onGridKeydown } = useGridNavigation({ addLine, getLines: () => form.lines })
</script>
