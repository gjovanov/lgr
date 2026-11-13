<template>
  <EntityFormShell
    :title="isEdit ? $t('warehouse.viewMovement') : $t('common.create') + ' ' + $t('warehouse.movementDoc')"
    :subtitle="isEdit ? (movement.number || '') : ''"
    :status="isEdit ? statusDef : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/movements"
    :back-label="$t('nav.stockMovements')"
  >
    <!-- FR-04 (#11): the linked inventory count, when this adjustment has one. -->
    <v-alert v-if="movement.inventoryCountId" type="info" variant="tonal" density="compact" class="mb-3">
      {{ $t('nav.inventoryCount') }}:
      <router-link :to="{ name: 'inventory.inventory-counts.edit', params: { id: movement.inventoryCountId } }">
        {{ $t('common.view') }}
      </router-link>
    </v-alert>

    <!-- FR-22.31: the supplier's bill that pays for this receipt — a link into invoicing. -->
    <v-alert v-if="movement.bill && !transferOnly" type="success" variant="tonal" density="compact" class="mb-3" icon="mdi-receipt-text-check-outline" data-testid="receipt-bill">
      {{ $t('warehouse.billedBy') }}
      <a :href="billHref(movement.bill.id)" class="font-weight-medium" data-testid="receipt-bill-link">{{ movement.bill.number }}</a>
    </v-alert>
    <!-- A receipt that no bill can be made from says why, rather than just not offering one. -->
    <v-alert v-else-if="notBillableText && !transferOnly" type="info" variant="tonal" density="compact" class="mb-3" data-testid="receipt-not-billable">
      {{ notBillableText }}
    </v-alert>

    <!-- FR-22.61: the sales invoice that holds this dispatch (the one made from it, or the one that booked it): a
         link into invoicing. -->
    <v-alert v-if="movement.sale && !transferOnly" type="success" variant="tonal" density="compact" class="mb-3" icon="mdi-receipt-text-check-outline" data-testid="dispatch-sale">
      {{ $t('warehouse.invoicedBy') }}
      <a :href="saleHref(movement.sale.id)" class="font-weight-medium" data-testid="dispatch-sale-link">{{ movement.sale.number }}</a>
    </v-alert>
    <!-- A dispatch that no invoice can be made from says why, rather than just not offering one. -->
    <v-alert v-else-if="notInvoiceableText && !transferOnly" type="info" variant="tonal" density="compact" class="mb-3" data-testid="dispatch-not-invoiceable">
      {{ notInvoiceableText }}
    </v-alert>

    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="3">
          <v-select :model-value="form.type" :label="`${$t('common.type')} *`" :items="movementTypeItems" :rules="[rules.required]" :disabled="isEdit" density="compact" @update:model-value="onTypeChange" />
        </v-col>
        <!-- Empty is `null`, never '': Vuetify treats '' as a selected value, which floated the
             label away and left a blank "selection" — the field read as nothing at all. -->
        <v-col v-if="showWarehouse.from" cols="12" md="3">
          <v-select v-model="form.fromWarehouseId" :label="$t('warehouse.fromWarehouse') + (transferOnly ? ' *' : '')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="readonly" :rules="transferOnly ? [rules.required] : []" density="compact" data-testid="from-warehouse" />
        </v-col>
        <v-col v-if="showWarehouse.to" cols="12" md="3">
          <v-select v-model="form.toWarehouseId" :label="$t('warehouse.toWarehouse') + (transferOnly ? ' *' : '')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="readonly" :rules="transferOnly ? [rules.required] : []" density="compact" data-testid="to-warehouse" @update:model-value="form.toGuessed = false" />
        </v-col>
        <v-col cols="12" md="3">
          <DateField v-model="form.date" :label="$t('common.date')" :rules="[rules.required]" :disabled="readonly" density="compact" />
        </v-col>
      </v-row>
      <!-- FR-22.6 (B-8): searched on the server, so every supplier can be reached; on a receipt
           it lists suppliers only and is called „Доставчик". An adjustment names a client or a
           supplier: the toggle says which, and the field lists, labels and creates that side. -->
      <div class="d-flex align-start ga-3">
        <v-btn-toggle
          v-if="isAdjustment"
          v-model="adjustmentSide"
          mandatory
          density="compact"
          variant="outlined"
          divided
          color="primary"
          class="flex-shrink-0 mt-1"
          :disabled="readonly"
          data-testid="adjustment-partner-side"
        >
          <v-btn value="customer" size="small">{{ $t('invoicing.client') }}</v-btn>
          <v-btn value="supplier" size="small">{{ $t('invoicing.supplier') }}</v-btn>
        </v-btn-toggle>
        <v-defaults-provider :defaults="{ VAutocomplete: { density: 'compact' } }">
          <ContactAutocompleteWithCreate
            v-model="form.contactId"
            class="flex-grow-1"
            :contacts="partners.contacts.value"
            :loading="partners.loading.value"
            :label="partnerLabel"
            :org-url="appStore.orgUrl()"
            :new-contact-type="partnerSide ?? undefined"
            :disabled="readonly"
            data-testid="movement-partner"
            @update:search="partners.onSearch"
            @contact-created="partners.add"
          />
        </v-defaults-provider>
      </div>

      <div class="d-flex align-center mt-4 mb-2">
        <span class="text-subtitle-2">{{ $t('invoicing.lineItems') }}</span>
        <v-chip v-if="form.type === 'receipt' && !readonly" class="ml-3" size="small" :color="grWithUpdate ? 'primary' : undefined" :variant="grWithUpdate ? 'flat' : 'outlined'">
          <!-- FR-22.28: remembered per user and org, so a receipt that carries prices every day
               does not cost a click every day. -->
          <v-switch :model-value="grWithUpdate" density="compact" hide-details class="mr-2" color="white" style="width: 36px" @update:model-value="onGrSwitch" />
          {{ $t(grWithUpdate ? 'warehouse.withProductUpdate' : 'warehouse.withoutProductUpdate') }}
        </v-chip>
        <v-btn v-if="grWithUpdate && !readonly" class="ml-2" size="small" variant="outlined" prepend-icon="mdi-view-column-outline" @click="columnPickerOpen = true">
          {{ $t('warehouse.grPicker.button', { n: activeColumns.length }) }}
        </v-btn>
        <v-spacer />
        <v-btn v-if="!readonly" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">{{ $t('invoicing.addLine') }}</v-btn>
      </div>
      <!-- FR-22.28: the grid takes the keyboard the way the invoice lines do (Tab / Enter / arrows,
           a new line past the last one), and fits a 1366 px laptop: the article column takes what
           the fixed columns leave instead of half the viewport. -->
      <div ref="lineTableRef" class="overflow-x-auto" @keydown.capture="onGridKeydown">
        <v-table density="compact" class="line-table">
          <thead>
            <tr>
              <th style="min-width:220px">{{ $t('warehouse.product') }}</th>
              <th style="width:76px">{{ $t('warehouse.stock') }}</th>
              <th class="text-end" style="width:90px;min-width:80px">{{ $t('warehouse.quantity') }}</th>
              <th v-if="seesCosts" class="text-end" style="width:104px;min-width:96px">{{ $t('warehouse.unitCost') }}</th>
              <th v-if="seesCosts" class="text-end" style="width:96px">{{ $t('common.total') }}</th>
              <!-- A fixed width: the room they leave goes to the article's name, which is what a line is read by. -->
              <th v-for="col in (grWithUpdate ? activeColumns : [])" :key="col.key" :class="col.align === 'end' ? 'text-end' : ''" style="width: 88px; min-width: 80px">
                {{ col.label || $t(col.i18n || '') }}
              </th>
              <th v-if="!readonly" style="width:32px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(line, idx) in form.lines" :key="idx">
              <td>
                <div v-if="!readonly" class="d-flex align-center ga-1">
                  <ProductSearch
                    :org-url="appStore.orgUrl()"
                    :initial-product="line.productId ? { _id: line.productId, name: line.productName || '' } : null"
                    :allow-create="isReceipt"
                    price-field="purchasePrice"
                    :stock-warehouse-id="stockWarehouseId"
                    :base-currency="baseCurrency"
                    :locale="localeCode"
                    class="flex-grow-1"
                    @product-selected="onLineProductSelected(idx, $event)"
                    @product-cleared="onLineProductCleared(idx)"
                    @create-product="openQuickProduct(idx, $event)"
                    @details="openProductPicker(idx, $event)"
                  />
                  <ProductDetailsButton @click="openProductPicker(idx)" />
                </div>
                <span v-else>{{ line.productName || line.productId }}</span>
              </td>
              <td>
                <v-chip v-if="line.stockQty != null" size="small" label color="info" variant="tonal">{{ line.stockQty }}</v-chip>
                <span v-else class="text-grey">&mdash;</span>
              </td>
              <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" :disabled="readonly" /></td>
              <td v-if="seesCosts">
                <v-text-field
                  v-model.number="line.unitCost"
                  type="number"
                  step="0.0001"
                  density="compact"
                  hide-details
                  variant="underlined"
                  :disabled="readonly"
                  @update:model-value="onUnitCostChange(idx)"
                />
              </td>
              <td v-if="seesCosts" class="text-end text-no-wrap">{{ fmtCurrency(line.quantity * (line.unitCost || 0)) }}</td>

              <!-- Extra product-update columns (only when grWithUpdate is ON) -->
              <td v-for="col in (grWithUpdate ? activeColumns : [])" :key="col.key" :class="col.align === 'end' ? 'text-end' : ''">
                <v-select
                  v-if="col.key === 'type'"
                  :model-value="productUpdateFor(line).type"
                  :items="productTypeItems()"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setUpdate(line, 'type', $event)"
                />
                <v-autocomplete
                  v-else-if="col.key === 'categoryId'"
                  :model-value="productUpdateFor(line).categoryId"
                  :items="categories"
                  item-title="name"
                  item-value="_id"
                  density="compact"
                  hide-details
                  variant="underlined"
                  clearable
                  @update:model-value="setUpdate(line, 'categoryId', $event)"
                />
                <v-autocomplete
                  v-else-if="col.key === 'unit'"
                  :model-value="productUpdateFor(line).unit"
                  :items="uomOptions"
                  item-title="title"
                  item-value="value"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setUpdate(line, 'unit', $event)"
                />
                <!-- A tier by its NAME — blank when the article holds none of that name. -->
                <v-text-field
                  v-else-if="col.tierName"
                  :model-value="tierPriceOf(line.priceTiers, col.tierName)"
                  type="number"
                  step="0.0001"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setTierPrice(line, col.tierName!, $event)"
                />
                <v-text-field
                  v-else
                  :model-value="productUpdateFor(line)[col.productField!]"
                  :type="col.inputType === 'number' ? 'number' : 'text'"
                  step="0.0001"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setUpdate(line, col.productField!, $event)"
                />
              </td>

              <td v-if="!readonly"><v-btn icon="mdi-close" size="x-small" variant="text" tabindex="-1" :title="$t('common.remove')" @click="form.lines.splice(idx, 1)" /></td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td v-if="seesCosts" :colspan="4" class="text-end text-subtitle-2">{{ $t('common.total') }}</td>
              <td v-if="seesCosts" class="text-end text-subtitle-2 text-no-wrap">{{ fmtCurrency(computedTotal) }}</td>
              <td v-else :colspan="3"></td>
              <td v-if="grWithUpdate" :colspan="activeColumns.length"></td>
              <td v-if="!readonly"></td>
            </tr>
          </tfoot>
        </v-table>
      </div>

      <GRColumnPicker v-model="columnPickerOpen" />

      <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" :disabled="readonly" density="compact" />
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>

    <ProductPickerDialog
      v-model="productPickerOpen"
      :org-url="appStore.orgUrl()"
      :base-currency="baseCurrency"
      :locale="localeCode"
      multiple
      :stock-warehouse-id="stockWarehouseId"
      price-field="purchasePrice"
      :existing-product-ids="existingProductIds"
      :initial-search="productPickerText"
      @select-many="onProductsPicked"
    />

    <!-- FR-22.30: the article the line's search did not find, created without leaving the receipt. -->
    <QuickProductDialog
      v-model="quickOpen"
      :org-url="appStore.orgUrl()"
      :initial-name="quickName"
      @created="onQuickProductCreated"
    />

    <!-- Neither warehouse set: the movement would change no stock. Asked, not refused. -->
    <v-dialog v-model="noWarehouseDialog" max-width="520">
      <v-card data-testid="no-warehouse-dialog">
        <v-card-title class="d-flex align-center ga-2">
          <v-icon color="warning">mdi-alert-outline</v-icon>
          {{ $t('warehouse.noWarehouseConfirm.title') }}
        </v-card-title>
        <v-card-text>
          {{ noWarehouseAction === 'confirm' ? $t('warehouse.noWarehouseConfirm.confirmText') : $t('warehouse.noWarehouseConfirm.saveText') }}
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="answerNoWarehouse(false)">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="warning" variant="flat" @click="answerNoWarehouse(true)">
            {{ noWarehouseAction === 'confirm' ? $t('warehouse.noWarehouseConfirm.confirmAnyway') : $t('warehouse.noWarehouseConfirm.saveAnyway') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- FR-22.31a: a receipt that names no supplier is billed once someone says whose goods they were. -->
    <v-dialog v-model="billSupplierDialog" max-width="520">
      <v-card data-testid="bill-supplier-dialog">
        <v-card-title>{{ $t('warehouse.billSupplier.title') }}</v-card-title>
        <v-card-text>
          <div class="text-body-2 text-medium-emphasis mb-3">{{ $t('warehouse.billSupplier.hint') }}</div>
          <v-defaults-provider :defaults="{ VAutocomplete: { density: 'compact' } }">
            <ContactAutocompleteWithCreate
              v-model="billSupplierId"
              :contacts="billSuppliers.contacts.value"
              :loading="billSuppliers.loading.value"
              :label="$t('invoicing.supplier')"
              :org-url="appStore.orgUrl()"
              new-contact-type="supplier"
              data-testid="bill-supplier"
              @update:search="billSuppliers.onSearch"
              @contact-created="billSuppliers.add"
            />
          </v-defaults-provider>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="billSupplierDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :disabled="!billSupplierId" :loading="billing" data-testid="bill-supplier-confirm" @click="createBill(billSupplierId)">
            {{ $t('warehouse.billSupplier.confirm') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- FR-22.61a: a dispatch that names no customer is invoiced once someone says whose goods they were. -->
    <v-dialog v-model="invoiceCustomerDialog" max-width="520">
      <v-card data-testid="invoice-customer-dialog">
        <v-card-title>{{ $t('warehouse.invoiceCustomer.title') }}</v-card-title>
        <v-card-text>
          <div class="text-body-2 text-medium-emphasis mb-3">{{ $t('warehouse.invoiceCustomer.hint') }}</div>
          <v-defaults-provider :defaults="{ VAutocomplete: { density: 'compact' } }">
            <ContactAutocompleteWithCreate
              v-model="invoiceCustomerId"
              :contacts="invoiceCustomers.contacts.value"
              :loading="invoiceCustomers.loading.value"
              :label="$t('invoicing.customer')"
              :org-url="appStore.orgUrl()"
              new-contact-type="customer"
              data-testid="invoice-customer"
              @update:search="invoiceCustomers.onSearch"
              @contact-created="invoiceCustomers.add"
            />
          </v-defaults-provider>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="invoiceCustomerDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :disabled="!invoiceCustomerId" :loading="invoicing" data-testid="invoice-customer-confirm" @click="createInvoice(invoiceCustomerId)">
            {{ $t('warehouse.invoiceCustomer.confirm') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Single-document import: OCR one разписка and merge it into THIS movement.
         Nothing is booked — the user still has to save and confirm. -->
    <DocImportDialog
      v-model="importDialogOpen"
      :org-url="appStore.orgUrl()"
      target="movement"
      mode="single"
      :current-form="importCurrentForm"
      @apply="applyImportedMovement"
    />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { unusedWarehouseSide } from 'config/movement-warehouses'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useGridNavigation } from 'ui-shared/composables/useGridNavigation'
import { pinnedWarehouseId, rememberedFlag } from 'ui-shared/composables/useUserDefaults'
import { appHref, goTo } from 'ui-shared/nav/navigate'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { isTransferOnly } from 'ui-shared/nav/page-registry'
import { useAccess } from 'ui-shared/access/useAccess'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import DateField from 'ui-shared/components/DateField.vue'
import ProductSearch from 'ui-shared/components/ProductSearch.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import ProductDetailsButton from 'ui-shared/components/ProductDetailsButton.vue'
import QuickProductDialog from 'ui-shared/components/QuickProductDialog.vue'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import ContactAutocompleteWithCreate from 'ui-shared/components/ContactAutocompleteWithCreate.vue'
import { useContactSearch } from 'ui-shared/composables/useContactSearch'
import { useProductTypes } from 'ui-shared/composables/useProductTypes'
import type { FormAction, StatusDef } from 'ui-shared/components/EntityFormShell.vue'
import GRColumnPicker from '../components/GRColumnPicker.vue'
import { useGRColumns } from '../composables/useGRColumns'
// What a line stages for its product, and what reaches it — shared with the supplier bill's form.
import {
  buildProductUpdates, cascadePurchasePrice, needsSeed, productsForSeed, seedFromProduct, setProductField, setTierPrice, tierPriceOf,
  type GRBase, type GRTier,
} from 'ui-shared/composables/gr-product-update'

interface Warehouse { _id: string; name: string; isDefault?: boolean }
interface MovementState {
  number?: string
  status: string
  inventoryCountId?: string
  /** FR-22.31: a supplier bill may be made from it (a completed receipt nobody has billed). */
  billable?: boolean
  /** FR-22.31a: it may, once the user says who the supplier is: the receipt names none. */
  needsSupplier?: boolean
  /** FR-22.31a: why no bill can be made from it. */
  notBillable?: { code: string; number?: string }
  /** FR-22.31: the live bill that holds it. */
  bill?: { id: string; number: string }
  /** FR-22.61: a sales invoice may be made from it (a completed dispatch no document holds). */
  invoiceable?: boolean
  /** FR-22.61a: it may, once the user says who the customer is: the dispatch names none. */
  needsCustomer?: boolean
  /** FR-22.61: why no invoice can be made from it. */
  notInvoiceable?: { code: string; number?: string }
  /** FR-22.61: the live sales invoice that holds it. */
  sale?: { id: string; number: string }
}

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const billing = ref(false)
const invoicing = ref(false)
const formRef = ref()
const warehouses = ref<Warehouse[]>([])
const movement = ref<MovementState>({ status: 'draft' })
/**
 * FR-26.8.5: a session that writes transfers only (a Seller, `inventory.transfer` without
 * `inventory.write`). The server refuses it every other type (`movement.controller#transferRefusal`).
 */
const transferOnly = isTransferOnly(sessionViewer())
// FR-27.11.D: cost figures only for a role that holds them (the server sends none otherwise).
const seesCosts = computed(() => useAccess().can('products.costs'))
// Draft movements stay editable; confirmed/completed are read-only (stock already applied). A
// transfer-only session reads a movement of any other type and changes nothing on it.
const readonly = computed(() => (isEdit.value && movement.value.status !== 'draft') || (transferOnly && form.value.type !== 'transfer'))

/**
 * The status pipeline. EntityFormShell translates each step as an i18n KEY, so the bare
 * 'draft' / 'confirmed' / 'completed' it used to get rendered as English in every language
 * (FR-22.11). Same words as the movements list's status chips.
 */
const statusDef = computed<StatusDef>(() => ({
  steps: ['draft', 'confirmed', 'completed'].map(s => `invoicing.status.${s}`),
  current: `invoicing.status.${movement.value.status}`,
}))

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))
function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

const emptyLine = () => ({
  productId: '', productName: '', quantity: 0, unitCost: 0, stockQty: null as number | null,
  // GR-with-update extras (only populated when grWithUpdate is ON): the product's fields and its
  // tiers by name as staged, and the base they were seeded from (`gr-product-update.ts`).
  productUpdate: {} as Record<string, any>,
  priceTiers: [] as GRTier[],
  productBase: undefined as GRBase | undefined,
})
const form = ref({
  type: transferOnly ? 'transfer' : 'receipt', fromWarehouseId: null as string | null, toWarehouseId: null as string | null, contactId: '' as string | undefined,
  date: new Date().toISOString().split('T')[0], notes: '',
  lines: [emptyLine()] as any[],
  // The To warehouse is the form's guess for a receipt, not the person's choice (`applyNewReceiptDefaults`).
  toGuessed: false,
})

const movementTypeItems = computed(() =>
  (transferOnly ? ['transfer'] : ['receipt', 'dispatch', 'transfer', 'adjustment']).map(value => ({ title: t(`warehouse.movementTypes.${value}`), value })),
)

// ── which warehouses a type names (`config/movement-warehouses`) ──
/**
 * A dispatch has no To warehouse and a receipt no From, so the field is not offered. A movement that
 * already names one keeps showing it: a booked document reads as it was booked, and a draft saved
 * before the rule needs the field to clear it.
 */
const showWarehouse = computed(() => {
  const unused = unusedWarehouseSide(form.value.type)
  return { from: unused !== 'from' || !!form.value.fromWarehouseId, to: unused !== 'to' || !!form.value.toWarehouseId }
})

function clearUnusedWarehouse() {
  const unused = unusedWarehouseSide(form.value.type)
  if (unused === 'from') form.value.fromWarehouseId = null
  if (unused === 'to') form.value.toWarehouseId = null
}

/**
 * The user changed the type. ⚠ Not a watcher on `form.type`: loading a movement changes that too,
 * and would clear a warehouse off a booked document on screen. A new movement starts as a receipt
 * with its To warehouse filled in. That is the form's guess for a receipt, and on any other type it
 * adds stock: a dispatch keeping it added stock, and a write-off booked goods in, with a count of the
 * wrong sign (#168). So the guess goes with the receipt. A To the person chose stays.
 */
function onTypeChange(type: string) {
  form.value.type = type
  clearUnusedWarehouse()
  if (form.value.toGuessed) {
    form.value.toWarehouseId = null
    form.value.toGuessed = false
  }
  if (!isEdit.value) applyNewReceiptDefaults()
}

// ── the partner: the supplier on a receipt, any contact otherwise ──
/**
 * FR-22.6 (B-8). The field used to load `GET /invoicing/contact` with no size: the API's 10
 * newest contacts of every type, filtered in the browser, so an older supplier could not be
 * picked at all and customers filled the list. It now searches the server; on a receipt it
 * asks for suppliers (and `both`) only.
 */
const isReceipt = computed(() => form.value.type === 'receipt')
/**
 * An adjustment names a client or a supplier (owner, 2026-11-12). Every type was already searched, but the list opens on
 * the newest contacts, which in a shop that imported its suppliers are suppliers only, so a client read as not allowed.
 * The toggle makes the side explicit: the list, the label and a contact created from the field follow it.
 */
const isAdjustment = computed(() => form.value.type === 'adjustment')
const adjustmentSide = ref<'customer' | 'supplier'>('customer')
/** The side the partner field lists and creates: suppliers on a receipt, the toggle's on an adjustment, any otherwise. */
const partnerSide = computed<'customer' | 'supplier' | null>(() =>
  isReceipt.value ? 'supplier' : isAdjustment.value ? adjustmentSide.value : null)
const partnerLabel = computed(() => t(
  partnerSide.value === 'supplier' ? 'invoicing.supplier' : partnerSide.value === 'customer' ? 'invoicing.client' : 'invoicing.contact'))
const partners = useContactSearch({
  orgUrl: () => appStore.orgUrl(),
  type: () => partnerSide.value,
  selected: () => [form.value.contactId],
})
watch(partnerSide, () => { void partners.search() })
// A loaded, restored or imported movement names its contact by id: fetch it so it shows by name.
watch(() => form.value.contactId, () => { void partners.ensureSelected() })
/** The chosen partner, once the list holds it (a loaded movement's after `ensureSelected`). */
const chosenPartner = computed(() => partners.contacts.value.find(c => c._id === form.value.contactId) ?? null)
// The toggle shows the side of the partner an adjustment names: a loaded supplier reads Supplier. `both` keeps the side.
watch(chosenPartner, (c) => {
  if (isAdjustment.value && (c?.type === 'customer' || c?.type === 'supplier')) adjustmentSide.value = c.type
})
// Switching sides drops a partner of the other side; a `both` contact stays.
watch(adjustmentSide, (side) => {
  const c = chosenPartner.value
  if (isAdjustment.value && !readonly.value && c && c.type !== side && c.type !== 'both') form.value.contactId = undefined
})

// ── neither warehouse set ──
/**
 * A movement with no "from" and no "to" warehouse moves nothing: `confirmMovement` adjusts only
 * the warehouses that are set, so confirming it marks it completed and changes no stock at all.
 * Users asked for the warehouse to be required; it is occasionally intended (a note kept for the
 * record), so it is a question before saving or confirming rather than a refusal.
 */
const noWarehouseDialog = ref(false)
const noWarehouseAction = ref<'save' | 'confirm'>('save')
let noWarehouseAnswer: ((proceed: boolean) => void) | null = null

function hasNoWarehouse() {
  return !form.value.fromWarehouseId && !form.value.toWarehouseId
}

function askNoWarehouse(action: 'save' | 'confirm'): Promise<boolean> {
  noWarehouseAction.value = action
  noWarehouseDialog.value = true
  return new Promise(resolve => { noWarehouseAnswer = resolve })
}

function answerNoWarehouse(proceed: boolean) {
  const answer = noWarehouseAnswer
  noWarehouseAnswer = null
  noWarehouseDialog.value = false
  answer?.(proceed)
}

// Escape or a click outside closes the dialog: that is a "no".
watch(noWarehouseDialog, (open) => { if (!open && noWarehouseAnswer) answerNoWarehouse(false) })

// ── GR-with-update state ──
const grWithUpdate = ref(false)
const columnPickerOpen = ref(false)
const { activeColumns } = useGRColumns()
const categories = ref<Array<{ _id: string; name: string }>>([])
const { productTypeItems } = useProductTypes()
const uomCodes = ['pcs', 'pair', 'set', 'box', 'pack', 'dozen', 'g', 'kg', 'ton', 'lb', 'oz', 'ml', 'L', 'm3', 'gal', 'mm', 'cm', 'm', 'km', 'in', 'ft', 'm2', 'ha', 'hr', 'day', 'month']
const uomOptions = computed(() => uomCodes.map(code => ({ title: `${t(`warehouse.uom.${code}`, code)} (${code})`, value: code })))

/** FR-22.28: the switch is remembered per user and org (`lgr:gr-with-update:<user>:<org>`). */
const grSwitchMemory = rememberedFlag('gr-with-update')
function onGrSwitch(on: boolean | null) {
  grWithUpdate.value = !!on
  grSwitchMemory.write(!!on)
}

// Auto-disable the toggle when type changes away from receipt.
watch(() => form.value.type, (t) => { if (t !== 'receipt') grWithUpdate.value = false })

const computedTotal = computed(() => form.value.lines.reduce((s: number, l: any) => s + l.quantity * (l.unitCost || 0), 0))

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'inventory',
  entityType: 'stockMovement',
  icon: 'mdi-swap-horizontal',
  getFormData: () => ({ ...form.value }),
  // The pending-changes panel shows the values: the type by its name, not as „receipt".
  getPreviewFields: () => [
    { label: 'Type', value: t(`warehouse.movementTypes.${form.value.type}`) },
    { label: 'Date', value: form.value.date },
  ],
  // A draft saved before the warehouses became `null` when empty may carry ''.
  setFormData: (data) => {
    form.value = { ...form.value, ...data, fromWarehouseId: data.fromWarehouseId || null, toWarehouseId: data.toWarehouseId || null }
  },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

/** FR-22.31a: why this receipt cannot be billed, in the words of the page. */
const notBillableText = computed(() => {
  const why = movement.value.notBillable
  if (!why) return ''
  // A voided document names itself; one that is gone has nothing to name.
  if (why.code === 'receipt_not_billable' && !why.number) return t('warehouse.notBillable.orphan')
  return t(`warehouse.notBillable.${why.code}`, { number: why.number || '' })
})

/** FR-22.61: why no invoice can be made from this dispatch, in the words of the page. */
const notInvoiceableText = computed(() => {
  const why = movement.value.notInvoiceable
  if (!why) return ''
  // A voided document names itself; one that is gone has nothing to name.
  if (why.code === 'dispatch_not_invoiceable' && !why.number) return t('warehouse.notInvoiceable.orphan')
  return t(`warehouse.notInvoiceable.${why.code}`, { number: why.number || '' })
})

/**
 * FR-22.29: an editable movement's primary action books it — „Запази и потвърди" saves and
 * confirms in one go (it was Save, then a separate „Потвърди" on the draft it left). Plain Save
 * keeps a draft. FR-22.52: Ctrl+Enter runs „Запази и потвърди", Ctrl+S the plain Save. FR-22.31: a
 * completed receipt that is not billed yet offers „Входяща фактура" — its supplier's bill, made
 * from it. One that names no supplier asks for it first (FR-22.31a).
 */
const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = []
  if (!readonly.value) {
    actions.push({ label: t('warehouse.saveAndConfirm'), color: 'primary', icon: 'mdi-check-all', handler: saveAndConfirm, loading: saving.value, primary: true })
    actions.push({ label: t('common.save'), color: 'primary', variant: 'outlined', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value })
    // Importing onto a confirmed movement would be pointless — its stock is already applied. A
    // transfer-only session imports nothing: the import writes with `inventory.write` (FR-26).
    if (!transferOnly) actions.push({
      label: t('docImport.importFile'),
      color: 'secondary',
      variant: 'outlined',
      icon: 'mdi-file-upload-outline',
      handler: () => { importDialogOpen.value = true },
    })
  } else if (movement.value.billable && !transferOnly) {
    actions.push({ label: t('warehouse.incomingInvoice'), color: 'primary', icon: 'mdi-receipt-text-plus-outline', handler: onIncomingInvoice, loading: billing.value })
  } else if (movement.value.invoiceable && !transferOnly) {
    // FR-22.61: a completed dispatch no document holds offers its customer's invoice, made from it.
    actions.push({ label: t('warehouse.salesInvoice'), color: 'primary', icon: 'mdi-receipt-text-plus-outline', handler: onSalesInvoice, loading: invoicing.value })
  }
  return actions
})

// ── single-document import ──
const importDialogOpen = ref(false)

/** The current form values, so the import dialog can show a field diff. */
const importCurrentForm = computed(() => ({ ...form.value }))

/**
 * Merge an imported разписка into THIS open movement. Fields and lines are assigned
 * directly: routing through `onLineProductSelected` would call `fetchLineStock`, which
 * overwrites the quantity with whatever is currently on hand — the opposite of what a
 * delivery note says.
 */
function applyImportedMovement(payload: { fields: Record<string, any>; lines: any[]; lineMode: 'replace' | 'append' | 'keep' }) {
  for (const [k, v] of Object.entries(payload.fields || {})) {
    if (v === undefined || v === null || v === '') continue
    ;(form.value as any)[k] = v
  }

  if (payload.lineMode !== 'keep' && payload.lines?.length) {
    const mapped = payload.lines.map((l: any) => ({
      productId: l.productId || '',
      productName: l.productName || l.sourceText || '',
      quantity: Number(l.quantity) || 0,
      unitCost: Number(l.unitCost) || 0,
      stockQty: null as number | null,
      productUpdate: l.productUpdate || {},
      priceTiers: l.priceTiers || [],
    }))
    const kept = payload.lineMode === 'append'
      ? form.value.lines.filter((l: any) => l.productId || l.productName)
      : []
    form.value.lines = [...kept, ...mapped, emptyLine()]
    // Delivered prices only make sense with the product-update columns visible.
    if (form.value.type === 'receipt' && mapped.some(l => Object.keys(l.productUpdate).length || l.priceTiers.length)) {
      grWithUpdate.value = true
    }
  }
  // The document may have changed the type: it names its warehouse, and not the one it leaves open.
  clearUnusedWarehouse()
  showSuccess(t('docImport.applied'))
}

/** A loaded receipt whose lines carry delivered prices was booked "with product update" —
 *  show the toggle and its columns, otherwise the prices it carried are invisible on reopen. */
function syncGrWithUpdateFromLines() {
  if (form.value.type !== 'receipt') return
  const any = (form.value.lines || []).some((l: any) => (l.productUpdate && Object.keys(l.productUpdate).length) || (l.priceTiers && l.priceTiers.length))
  if (any) grWithUpdate.value = true
}

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/movement/${route.params.id}`)
    const detail = data.stockMovement || data
    // The page names the movement by its SM- number (FR-22.29): the API sends `movementNumber`,
    // which this read as `number` and so never showed.
    movement.value = {
      number: detail.number || detail.movementNumber,
      status: detail.status || 'draft',
      inventoryCountId: detail.inventoryCountId || undefined,
      billable: !!detail.billable,
      needsSupplier: !!detail.needsSupplier,
      notBillable: detail.notBillable || undefined,
      bill: detail.bill || undefined,
      invoiceable: !!detail.invoiceable,
      needsCustomer: !!detail.needsCustomer,
      notInvoiceable: detail.notInvoiceable || undefined,
      sale: detail.sale || undefined,
    }
    form.value = {
      type: detail.type, fromWarehouseId: detail.fromWarehouseId || null, toWarehouseId: detail.toWarehouseId || null, toGuessed: false,
      contactId: detail.contactId || undefined, date: detail.date?.split('T')[0] || '', notes: detail.notes || '',
      lines: (detail.lines || []).map((l: any) => ({ productId: l.productId, productName: l.productName || '', quantity: l.quantity, unitCost: l.unitCost, stockQty: null, productUpdate: l.productUpdate || {}, priceTiers: l.priceTiers || [] })),
    }
    const wasOn = grWithUpdate.value
    syncGrWithUpdateFromLines()
    // Reloaded with the switch on (after a save): the lines take their articles' current values
    // again, so what the next save sends is what changes from here. Turning it on seeds them too.
    if (wasOn && !readonly.value) await seedUnseededLines()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

/**
 * Save the movement; the id it has afterwards, or null when it was not saved. The blank line the
 * grid keeps at the bottom is not part of it.
 */
async function save(): Promise<string | null> {
  const basePayload: Record<string, any> = {
    type: form.value.type,
    date: form.value.date,
    fromWarehouseId: form.value.fromWarehouseId || undefined,
    toWarehouseId: form.value.toWarehouseId || undefined,
    contactId: form.value.contactId || undefined,
    notes: form.value.notes || undefined,
    totalAmount: computedTotal.value,
    lines: form.value.lines.filter((l: any) => l.productId).map((l: any) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitCost: l.unitCost || 0,
      totalCost: l.quantity * (l.unitCost || 0),
    })),
  }

  if (grWithUpdate.value && form.value.type === 'receipt') {
    // Only what the lines change on their products (`gr-product-update.ts`).
    basePayload.productUpdates = buildProductUpdates(form.value.lines)
  }

  if (isEdit.value) {
    // Draft edit: type is immutable after create — PUT does not accept it. An emptied warehouse or
    // partner is sent as `null`: left out, PUT keeps the one the draft has, and clearing it did
    // nothing. Once confirmed a receipt's wrong supplier refuses every other one for good.
    const { type: _type, ...updateBody } = basePayload
    updateBody.fromWarehouseId = form.value.fromWarehouseId || null
    updateBody.toWarehouseId = form.value.toWarehouseId || null
    updateBody.contactId = form.value.contactId || null
    await httpClient.put(`${appStore.orgUrl()}/warehouse/movement/${route.params.id}`, updateBody)
    markSaved()
    return route.params.id as string
  }
  const endpoint = grWithUpdate.value && form.value.type === 'receipt'
    ? `${appStore.orgUrl()}/warehouse/movement/with-update`
    : `${appStore.orgUrl()}/warehouse/movement`
  const { data } = await httpClient.post(endpoint, basePayload)
  markSaved()
  return data.stockMovement?._id || data.stockMovement?.id || data._id || null
}

/** After a create, the page becomes the movement's own: its route, its number, its status. */
async function showSaved(id: string | null) {
  if (!id) {
    router.push({ name: 'inventory.movements' })
    return
  }
  if (route.params.id !== id) await router.replace({ name: 'inventory.movements.view', params: { id } })
  // The same view instance stays mounted across that navigation, so load what it now shows.
  await fetchItem()
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (hasNoWarehouse() && !(await askNoWarehouse('save'))) return
  saving.value = true
  try {
    const id = await save()
    showSuccess(t('common.savedSuccessfully'))
    await showSaved(id)
  } catch (e: any) {
    showError(stockRefusalMessage(e, t))
  } finally {
    saving.value = false
  }
}

/** FR-22.29: save and book in one action. A refused confirm leaves the saved draft on screen. */
async function saveAndConfirm() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  if (hasNoWarehouse() && !(await askNoWarehouse('confirm'))) return
  saving.value = true
  let id: string | null = null
  try {
    id = await save()
    if (!id) throw new Error(t('common.operationFailed'))
    // FR-04 (#11): confirming a manual adjustment auto-creates its completed inventory
    // count server-side (createCount is UI-only — imports/skills stay count-free).
    await httpClient.post(
      `${appStore.orgUrl()}/warehouse/movement/${id}/confirm`,
      form.value.type === 'adjustment' ? { createCount: true } : {},
    )
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(stockRefusalMessage(e, t))
  } finally {
    try {
      if (id) await showSaved(id)
    } finally {
      saving.value = false
    }
  }
}

/**
 * FR-22.31 (#168): the supplier's bill for this receipt. The server makes it — a draft, linked,
 * so it will move no stock — and the user continues on it in invoicing: the supplier's invoice
 * number, then „Запази и получи". `contactId` is the supplier of a receipt that names none.
 */
async function createBill(contactId?: string) {
  billing.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoicing/bills/from-receipt`, {
      movementIds: [route.params.id],
      ...(contactId ? { contactId } : {}),
    })
    goTo(billHref(data.invoice.id || data.invoice._id))
  } catch (e: any) {
    const res = e?.response?.data
    // Billed meanwhile (a second click, another tab): go to that bill rather than refuse.
    if (res?.code === 'receipt_already_billed' && res.invoiceId) {
      goTo(billHref(res.invoiceId))
      return
    }
    billing.value = false
    // Its bill was voided in another tab, and took its supplier with it.
    if (res?.code === 'receipt_without_supplier') {
      askBillSupplier()
      return
    }
    showError(stockRefusalMessage(e, t))
  }
}

// ── FR-22.31a: the supplier of a receipt that names none ──
const billSupplierDialog = ref(false)
const billSupplierId = ref<string | undefined>(undefined)
const billSuppliers = useContactSearch({
  orgUrl: () => appStore.orgUrl(),
  type: () => 'supplier',
  selected: () => [billSupplierId.value],
})

function askBillSupplier() {
  billSupplierId.value = undefined
  billSupplierDialog.value = true
  void billSuppliers.search()
}

function onIncomingInvoice() {
  if (movement.value.needsSupplier) askBillSupplier()
  else void createBill()
}

function billHref(id: string) {
  return appHref('invoicing', `/invoicing/bills/${id}/edit`)
}

/**
 * FR-22.61 (#725): the customer's invoice for this dispatch. The server makes it, a draft, linked, so it will move
 * no stock, with each line at that customer's price; the user reads the prices there and issues it. `contactId` is
 * the customer of a dispatch that names none.
 */
async function createInvoice(contactId?: string) {
  invoicing.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoicing/sales/from-dispatch`, {
      movementIds: [route.params.id],
      // „Словом" is written in the language the person works in, as the invoice form writes it.
      locale: appStore.locale,
      ...(contactId ? { contactId } : {}),
    })
    goTo(saleHref(data.invoice.id || data.invoice._id))
  } catch (e: any) {
    const res = e?.response?.data
    // Invoiced meanwhile (a second click, another tab): go to that invoice rather than refuse.
    if (res?.code === 'dispatch_already_invoiced' && res.invoiceId) {
      goTo(saleHref(res.invoiceId))
      return
    }
    invoicing.value = false
    // Its invoice was voided in another tab, and took its customer with it.
    if (res?.code === 'dispatch_without_customer') {
      askInvoiceCustomer()
      return
    }
    showError(stockRefusalMessage(e, t))
  }
}

// ── FR-22.61a: the customer of a dispatch that names none ──
const invoiceCustomerDialog = ref(false)
const invoiceCustomerId = ref<string | undefined>(undefined)
const invoiceCustomers = useContactSearch({
  orgUrl: () => appStore.orgUrl(),
  type: () => 'customer',
  selected: () => [invoiceCustomerId.value],
})

function askInvoiceCustomer() {
  invoiceCustomerId.value = undefined
  invoiceCustomerDialog.value = true
  void invoiceCustomers.search()
}

function onSalesInvoice() {
  if (movement.value.needsCustomer) askInvoiceCustomer()
  else void createInvoice()
}

function saleHref(id: string) {
  return appHref('invoicing', `/invoicing/invoices/${id}/edit`)
}

function addLine() { form.value.lines.push(emptyLine()) }

/** FR-22.28: keyboard across the line grid, as on the invoice forms. */
const { onGridKeydown } = useGridNavigation({ addLine, getLines: () => form.value.lines })

/**
 * The warehouse a line's „Наличност" reads: where the goods arrive on a receipt (FR-22.28 — it
 * read the „От склад" a receipt does not have, so a receipt line always showed —), where they
 * leave from on everything else.
 */
const stockWarehouseId = computed(() => (isReceipt.value ? form.value.toWarehouseId : form.value.fromWarehouseId))

/**
 * What the warehouse currently holds for a line — CONTEXT, shown as the „stock" chip.
 *
 * It must not touch `quantity` or `unitCost`: those are the DOCUMENT's own values. This ran on
 * every load (the `fromWarehouseId` watcher below fires as soon as a movement is fetched) and
 * rewrote every line to the current on-hand figure — SM-2026-01005 dispatched 100 of „Винт
 * 5.5/6.3х145" and the page showed 251, the stock level, priced at today's avgCost. Confirmed
 * movements are read-only so nothing was ever saved back, but every quantity on screen was wrong.
 *
 * `prefill` is the one deliberate exception: picking a product onto an EMPTY line of a movement
 * that takes goods OUT fills in what is on hand as a starting point. It never overwrites a
 * quantity that is already there, and never on a receipt: what arrives is not what is on hand.
 */
async function fetchLineStock(idx: number, opts: { prefill?: boolean } = {}) {
  const line = form.value.lines[idx]
  const warehouseId = stockWarehouseId.value
  if (!line?.productId || !warehouseId) {
    if (line) line.stockQty = null
    return
  }
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level`, {
      params: { productId: line.productId, warehouseId, size: 1 },
    })
    const sl = data.stockLevels?.[0]
    if (!sl) { line.stockQty = 0; return }
    line.stockQty = sl.availableQuantity ?? sl.quantity ?? 0
    if (opts.prefill && !isReceipt.value && !Number(line.quantity)) {
      line.quantity = line.stockQty
      line.unitCost = sl.avgCost || line.unitCost
    }
  } catch {
    line.stockQty = null
  }
}

async function onLineProductSelected(idx: number, product: any) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = product._id
  line.productName = product.name
  line.unitCost = product.purchasePrice ?? 0
  line.stockQty = null
  line.productUpdate = {}
  line.priceTiers = []
  line.productBase = undefined
  // FR-22.28: an article on the last line opens the next one, as on the invoice forms.
  if (idx === form.value.lines.length - 1) form.value.lines.push(emptyLine())
  focusQuantity(idx)
  await fetchLineStock(idx, { prefill: true })

  // When grWithUpdate is ON, load the full product so we can show/edit its fields.
  if (grWithUpdate.value) await seedLineProductUpdate(idx, product.purchasePrice ?? 0)
}

/**
 * The quantity is what a line needs next, so the caret goes there once the article is chosen —
 * by click, by Enter or from the new-article dialog. Deferred past the search's own close and a
 * dialog's focus return, which would otherwise take it back.
 */
const lineTableRef = ref<HTMLElement>()
function focusQuantity(idx: number) {
  setTimeout(() => {
    const row = lineTableRef.value?.querySelectorAll('tbody > tr')[idx]
    const input = row?.querySelectorAll('td')[2]?.querySelector('input') as HTMLInputElement | null
    if (!input || input.disabled) return
    input.focus()
    try { input.select() } catch { /* number inputs may refuse select() */ }
  }, 200)
}

/**
 * Load the line's product and stage its current fields and tiers on the line, with their base —
 * what the payload compares against, so only what the user changes reaches the product
 * (`ui-shared/composables/gr-product-update.ts`). Tiers go by name: none is padded in.
 */
async function seedLineProductUpdate(idx: number, costAtPick?: number) {
  const line = form.value.lines[idx]
  if (!line?.productId) return
  const productId = String(line.productId)
  const costBefore = costAtPick ?? line.unitCost
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product/${productId}`)
    // The line may have been given another product while this one loaded.
    if (String(line.productId) !== productId) return
    Object.assign(line, seedFromProduct(data.product || data, productId))
    // A cost typed while the product loaded is its new purchase price, as if typed after.
    if (line.unitCost !== costBefore) cascadePurchasePrice(line, line.unitCost)
  } catch { /* keep defaults if fetch fails */ }
}

/**
 * Seed the lines that name a product and stage nothing yet (a loaded draft, a reload after a
 * save): all their articles are read at once.
 */
async function seedUnseededLines() {
  const pending = form.value.lines.filter((l: any) => needsSeed(l))
  if (!pending.length) return
  const products = await productsForSeed(async (ids) => {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`, { params: { ids: ids.join(','), size: ids.length } })
    return data.products || []
  }, [...new Set(pending.map((l: any) => String(l.productId)))])
  for (const line of pending) {
    const p = products.get(String(line.productId))
    // Staged meanwhile (a price typed while these loaded): that line keeps what was typed.
    if (p && needsSeed(line)) Object.assign(line, seedFromProduct(p, String(line.productId)))
  }
}

// Toggling ON seeds any line that already has a product but no staged update yet (edit mode).
watch(grWithUpdate, async (on) => {
  if (on) await seedUnseededLines()
})

function onLineProductCleared(idx: number) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = ''
  line.productName = ''
  line.stockQty = null
}

const productPickerOpen = ref(false)
const productPickerRowIdx = ref(-1)
/** FR-28.25: what the user had typed in the line's field when they asked for Details (F4, "Show all N results"). */
const productPickerText = ref('')
/** FR-28.28: the articles already on the document are marked in the dialog, not hidden from it. */
const existingProductIds = computed(() => form.value.lines.map((l: any) => String(l.productId || '')).filter(Boolean))

function openProductPicker(idx: number, text = '') {
  productPickerRowIdx.value = idx
  productPickerText.value = text
  productPickerOpen.value = true
}

/** The line after `idx` that is free for an article: the blank one that follows, else a new one inserted there. */
function lineAfter(idx: number): number {
  const next = idx + 1
  const line = form.value.lines[next]
  if (line && !line.productId) return next
  form.value.lines.splice(next, 0, emptyLine())
  return next
}

/**
 * FR-28.28: several articles at once. The first goes on the line the dialog was opened from, as one pick would;
 * each of the others on the next free line. Each runs the line's own after-pick logic, in the order ticked.
 */
async function onProductsPicked(products: any[]) {
  let idx = productPickerRowIdx.value
  productPickerRowIdx.value = -1
  if (idx < 0 || !products.length) return
  for (let i = 0; i < products.length; i++) {
    if (i > 0) idx = lineAfter(idx)
    await onLineProductSelected(idx, products[i])
  }
}

// ── FR-22.30: „+ Нов продукт „…"" on a receipt line ──
const quickOpen = ref(false)
const quickName = ref('')
let quickLine = -1

function openQuickProduct(idx: number, name: string) {
  quickLine = idx
  quickName.value = name
  quickOpen.value = true
}

/** The new article (or the catalog's own, when it had it) goes on the line it was asked from. */
async function onQuickProductCreated(product: any) {
  if (quickLine < 0 || !product) return
  await onLineProductSelected(quickLine, { ...product, _id: product._id || product.id })
}

// Refreshes the „stock" chips when the warehouse they read changes. Info only — see fetchLineStock.
watch(stockWarehouseId, () => {
  form.value.lines.forEach((_line: any, idx: number) => {
    if (_line.productId) fetchLineStock(idx)
  })
})

// Navigating from one movement to another reuses this view: load the one now shown.
watch(() => route.params.id, (id, was) => {
  if (id && id !== was && !saving.value) void fetchItem()
})

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } }); warehouses.value = data.warehouses || [] } catch { /* */ }
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-category?size=0`)
    categories.value = data.productCategories || []
  } catch { /* */ }
}

// ── GR-with-update helpers ──

function productUpdateFor(line: any): Record<string, any> {
  if (!line.productUpdate) line.productUpdate = {}
  return line.productUpdate
}

function setUpdate(line: any, field: string, value: any) {
  setProductField(line, field, value)
}

/**
 * The receipt's unit cost is the article's new purchase price: staged on its product, with the
 * tiers that follow the purchase price moved along (`cascadePurchasePrice` says which do).
 */
function onUnitCostChange(idx: number) {
  const line = form.value.lines[idx]
  if (!line || !grWithUpdate.value) return
  cascadePurchasePrice(line, line.unitCost)
}

/**
 * FR-22.28: a new receipt starts where the user's documents start — the warehouse they pinned on
 * a document form, else the org's default — and with the product-update switch as they left it.
 */
function applyNewReceiptDefaults() {
  if (form.value.type !== 'receipt') return
  const pinned = pinnedWarehouseId()
  const candidate = (pinned && warehouses.value.some(w => w._id === pinned) ? pinned : '')
    || warehouses.value.find(w => w.isDefault)?._id
    || null
  if (candidate && !form.value.toWarehouseId) {
    form.value.toWarehouseId = candidate
    form.value.toGuessed = true
  }
  if (grSwitchMemory.read()) grWithUpdate.value = true
}

/**
 * FR-22.47 — „Заприходи" on an article (`?productId=`): the new receipt starts with that article
 * on its first line, filled exactly as picking it there fills it (`onLineProductSelected`): the
 * cost the receipt uses (its purchase price), what the destination holds of it, its staged product
 * update when that switch is on, and the next blank line, with the cursor in the quantity. It
 * runs after the receipt's defaults, so the stock shown is the chosen destination's. An article
 * that cannot be read leaves the blank receipt „Нова стокова разписка" opens.
 */
async function prefillFromProduct(id: string) {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product/${encodeURIComponent(id)}`)
    const product = data?.product
    if (!product) return
    await onLineProductSelected(0, { ...product, _id: String(product._id || product.id) })
  } catch { /* the blank receipt */ }
}

onMounted(async () => {
  await Promise.all([fetchWarehouses(), partners.search(), fetchCategories()])
  if (tryRestore()) return
  if (isEdit.value) {
    await fetchItem()
    return
  }
  applyNewReceiptDefaults()
  const productId = typeof route.query.productId === 'string' ? route.query.productId : ''
  if (productId) await prefillFromProduct(productId)
})
</script>

<style scoped>
/* v-table's 16px cell gutters cost 32px per column: with the product-update columns on, that is
   most of what kept the receipt from fitting a 1366 px screen (FR-22.28). */
.line-table :deep(th),
.line-table :deep(td) {
  padding-left: 6px !important;
  padding-right: 6px !important;
}
</style>
