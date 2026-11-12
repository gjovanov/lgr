<template>
  <EntityFormShell
    :title="isEdit ? $t('warehouse.editProduct') : $t('warehouse.newProduct')"
    :subtitle="isEdit ? form.name : ''"
    :status="isEdit ? { steps: [$t('common.active'), $t('common.archived')], current: form.isActive !== false ? $t('common.active') : $t('common.archived') } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/products"
  >
    <!-- FR-22.47: what the article leads to, read from the article as stored. -->
    <template #header-actions>
      <ProductDocActions v-if="isEdit" :product="storedProduct" />
    </template>

    <v-form ref="formRef" :disabled="!writes" @submit.prevent="handleSubmit">
      <ProductTabBar :active-tab="urlTab" :is-new="!isEdit" :product-id="(route.params.id as string) || ''" />

          <v-tabs-window v-model="tab" class="pt-2">
            <!-- Basic Info: SKU, Name, Tariff code / Type, Category, Unit / Barcode, Description, Tags / Active -->
            <v-tabs-window-item value="basic">
              <v-row data-testid="product-basic-line-1">
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.sku" :label="$t('warehouse.sku')" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field
                    v-model="form.tariffCode"
                    :label="$t('warehouse.tariffCode')"
                    :maxlength="PRODUCT_TARIFF_CODE_MAX"
                    data-testid="product-tariff-code"
                  />
                </v-col>
              </v-row>
              <v-row data-testid="product-basic-line-2">
                <v-col cols="12" md="4">
                  <v-select v-model="form.type" :label="$t('common.type')" :items="productTypeItems()" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="4">
                  <!-- A category name no category carries is shown as the placeholder, and kept. -->
                  <v-autocomplete
                    v-model="form.categoryId"
                    :label="$t('warehouse.category')"
                    :items="categories"
                    item-title="name"
                    item-value="_id"
                    :loading="loadingCategories"
                    :placeholder="unlinkedCategory || undefined"
                    :persistent-placeholder="!!unlinkedCategory"
                    :rules="[categoryGiven]"
                    data-testid="product-category"
                    clearable
                  />
                </v-col>
                <v-col cols="12" md="4">
                  <v-autocomplete v-model="form.unit" :label="$t('warehouse.unit')" :items="uomOptions" item-title="title" item-value="value" />
                </v-col>
              </v-row>
              <v-row data-testid="product-basic-line-3">
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.barcode" :label="$t('warehouse.barcode')" />
                </v-col>
                <v-col cols="12" md="4">
                  <!-- One line while it is short, as its neighbours are; it grows with what is written. -->
                  <v-textarea v-model="form.description" :label="$t('common.description')" rows="1" max-rows="8" auto-grow />
                </v-col>
                <v-col cols="12" md="4">
                  <!-- As tall as the description beside it (the tier rows keep the compact one). -->
                  <TagInput v-model="form.tags" type="product" :org-url="orgUrl()" density="default" />
                </v-col>
              </v-row>
              <v-row data-testid="product-basic-line-4">
                <v-col cols="12">
                  <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" hide-details />
                </v-col>
              </v-row>
            </v-tabs-window-item>

            <!-- Pricing (base prices + custom prices merged) -->
            <v-tabs-window-item value="pricing">
              <!-- Base prices: 4 fields in one row. A price keeps four decimals and a margin three
                   (`price-precision.ts`); the selling price's column is the wide one, for its margin beside it. -->
              <p class="text-subtitle-1 font-weight-bold mb-3">{{ $t('warehouse.basePrices') }}</p>
              <v-row>
                <v-col v-if="seesCosts" cols="12" sm="6" md="3">
                  <DecimalField
                    v-model="form.purchasePrice"
                    :decimals="PRICE_DECIMALS"
                    :label="$t('warehouse.purchasePrice')"
                    data-testid="base-purchase-price"
                    @update:model-value="onPurchasePriceChange"
                  />
                </v-col>
                <!-- FR-27.11.D: the selling price is a level of its own. -->
                <v-col v-if="seesSelling" cols="12" sm="6" :md="seesCosts ? 4 : 3">
                  <!-- Side by side while both fit; in a narrow column the margin goes under the price. -->
                  <div class="d-flex flex-wrap ga-2 align-start">
                    <DecimalField
                      v-model="form.sellingPrice"
                      :decimals="PRICE_DECIMALS"
                      :label="$t('warehouse.sellingPrice')"
                      class="flex-grow-1 base-price"
                      data-testid="base-selling-price"
                      @update:model-value="onSellingPriceChange"
                    />
                    <DecimalField
                      v-if="seesCosts"
                      v-model="sellingPricePercent"
                      :decimals="PERCENT_DECIMALS"
                      :label="$t('warehouse.margin')"
                      suffix="%"
                      class="base-margin"
                      :disabled="!form.purchasePrice"
                      data-testid="base-selling-margin"
                      @update:model-value="onSellingPercentChange"
                    />
                  </div>
                </v-col>
                <v-col cols="12" sm="6" :md="seesCosts ? 2 : 3">
                  <v-text-field v-model.number="form.taxRate" :label="$t('warehouse.taxRate')" type="number" suffix="%" />
                </v-col>
                <v-col v-if="seesCosts" cols="12" sm="6" md="3">
                  <DecimalField
                    :model-value="margin"
                    :decimals="PERCENT_DECIMALS"
                    :label="$t('warehouse.margin')"
                    suffix="%"
                    readonly
                    data-testid="base-margin"
                  />
                </v-col>
              </v-row>

              <v-divider class="my-4" />

              <!-- Price Tiers (13 slots: Доставна, Цена на едро, Цена 0..Цена 10) -->
              <div class="d-flex align-center mb-2">
                <!-- The slots the table shows below: 13 since 2026-08-06, fewer for a role that sees fewer levels. -->
                <p class="text-subtitle-1 font-weight-bold" data-testid="tier-title">{{ $t('warehouse.priceTiers', { count: priceTiers.length }) }}</p>
                <v-spacer />
                <div class="d-flex ga-1">
                  <v-chip
                    v-for="f in FILTER_KEYS" :key="f"
                    :color="visibleFilters[f] ? 'primary' : undefined"
                    :variant="visibleFilters[f] ? 'flat' : 'outlined'"
                    size="x-small"
                    @click="visibleFilters[f] = !visibleFilters[f]"
                  >
                    {{ $t('warehouse.filter.' + f) }}
                  </v-chip>
                </div>
              </div>
              <p class="text-body-2 text-medium-emphasis mb-3">{{ $t('warehouse.priceTiersHelp') }}</p>

              <v-table density="compact" class="mb-4" data-testid="tier-table">
                <thead>
                  <tr>
                    <th style="width: 40px">#</th>
                    <th style="width: 220px">{{ $t('common.name') }}</th>
                    <th v-if="seesCosts" style="width: 130px">%</th>
                    <th style="width: 190px">{{ $t('warehouse.finalPrice') }}</th>
                    <th v-if="visibleFilters.contact">{{ $t('invoicing.contact') }}</th>
                    <th v-if="visibleFilters.tags">{{ $t('warehouse.contactTags') }}</th>
                    <th v-if="visibleFilters.minQty" style="width: 110px">{{ $t('warehouse.minQuantity') }}</th>
                    <th v-if="visibleFilters.validity" style="width: 160px">{{ $t('warehouse.validFrom') }}</th>
                    <th v-if="visibleFilters.validity" style="width: 160px">{{ $t('warehouse.validTo') }}</th>
                    <!-- Takes the width nothing else wants, so the figures keep their own and stay beside the names. -->
                    <th v-if="spareColumn" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  <!-- The article's two base prices again, where the tiers begin: the SAME figures as the fields above
                       (one model each), so every price of the article reads down one column. Shown to whoever sees
                       the field above, and no slot of the article: they are not numbered and never sent as tiers. -->
                  <tr v-if="seesCosts" class="tier-base-row" data-testid="tier-base-purchase">
                    <td />
                    <td><span class="tier-base-name">{{ $t('warehouse.purchasePrice') }}</span></td>
                    <td />
                    <td>
                      <DecimalField
                        v-model="form.purchasePrice"
                        :decimals="PRICE_DECIMALS"
                        density="compact"
                        hide-details
                        variant="plain"
                        class="tier-price"
                        :aria-label="$t('warehouse.purchasePrice')"
                        @update:model-value="onPurchasePriceChange"
                      />
                    </td>
                    <td v-if="trailingColumns" :colspan="trailingColumns" />
                  </tr>
                  <tr v-if="seesSelling" class="tier-base-row" data-testid="tier-base-selling">
                    <td />
                    <td><span class="tier-base-name">{{ $t('warehouse.sellingPrice') }}</span></td>
                    <td v-if="seesCosts">
                      <DecimalField
                        v-model="sellingPricePercent"
                        :decimals="PERCENT_DECIMALS"
                        density="compact"
                        hide-details
                        variant="plain"
                        class="tier-percent"
                        :disabled="!form.purchasePrice"
                        :aria-label="$t('warehouse.margin')"
                        @update:model-value="onSellingPercentChange"
                      />
                    </td>
                    <td>
                      <DecimalField
                        v-model="form.sellingPrice"
                        :decimals="PRICE_DECIMALS"
                        density="compact"
                        hide-details
                        variant="plain"
                        class="tier-price"
                        :aria-label="$t('warehouse.sellingPrice')"
                        @update:model-value="onSellingPriceChange"
                      />
                    </td>
                    <td v-if="trailingColumns" :colspan="trailingColumns" />
                  </tr>
                  <tr v-for="(tier, i) in priceTiers" :key="i" data-testid="tier-row" :data-tier="tier.name">
                    <td class="text-medium-emphasis">{{ i + 1 }}</td>
                    <td>
                      <v-text-field v-model="tier.name" density="compact" hide-details variant="plain" class="tier-name" :rules="[rules.required]" />
                    </td>
                    <td v-if="seesCosts">
                      <DecimalField
                        v-model="tier.percent"
                        :decimals="PERCENT_DECIMALS"
                        density="compact"
                        hide-details
                        variant="plain"
                        class="tier-percent"
                        :disabled="!form.purchasePrice"
                        @update:model-value="onTierPercentChange(i)"
                      />
                    </td>
                    <td>
                      <DecimalField
                        v-model="tier.finalPrice"
                        :decimals="PRICE_DECIMALS"
                        density="compact"
                        hide-details
                        variant="plain"
                        class="tier-price"
                        :append-inner-icon="tier.manualOverride ? 'mdi-pencil-lock' : undefined"
                        @update:model-value="onTierFinalPriceChange(i)"
                      />
                    </td>
                    <td v-if="visibleFilters.contact">
                      <!-- Searched on the server (FR-22.6): every contact can be reached, and the
                           ones a tier already names are fetched so their chips show names. -->
                      <v-autocomplete
                        v-model="tier.contactIds"
                        :items="tierContacts.contacts.value"
                        :item-title="contactTitle"
                        item-value="_id"
                        :loading="tierContacts.loading.value"
                        density="compact"
                        hide-details
                        variant="plain"
                        multiple
                        chips
                        closable-chips
                        @update:search="tierContacts.onSearch"
                      />
                    </td>
                    <td v-if="visibleFilters.tags">
                      <TagInput v-model="tier.tags" type="contact" :org-url="orgUrl()" />
                    </td>
                    <td v-if="visibleFilters.minQty">
                      <v-text-field v-model.number="tier.minQuantity" type="number" density="compact" hide-details variant="plain" class="tier-min-qty" />
                    </td>
                    <td v-if="visibleFilters.validity">
                      <v-text-field v-model="tier.validFrom" type="date" density="compact" hide-details variant="plain" class="tier-date" />
                    </td>
                    <td v-if="visibleFilters.validity">
                      <v-text-field v-model="tier.validTo" type="date" density="compact" hide-details variant="plain" class="tier-date" />
                    </td>
                    <td v-if="spareColumn" />
                  </tr>
                </tbody>
              </v-table>
            </v-tabs-window-item>

            <!-- Inventory Settings -->
            <v-tabs-window-item value="inventory">
              <v-switch v-model="form.trackInventory" :label="$t('warehouse.trackInventory')" color="primary" />
              <v-row v-if="form.trackInventory">
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.minStockLevel" :label="$t('warehouse.minStockLevel')" type="number" min="0" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.maxStockLevel" :label="$t('warehouse.maxStockLevel')" type="number" min="0" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-select
                    v-model="form.costingMethod"
                    :label="$t('warehouse.costingMethod')"
                    :items="costingMethodItems"
                    clearable
                    :hint="$t('warehouse.costingMethodHint')"
                    persistent-hint
                  />
                </v-col>
                <v-col v-if="seesCosts && form.costingMethod === 'standard'" cols="12" md="4">
                  <!-- A price like the others: four decimals (`price-precision.ts`). -->
                  <DecimalField v-model="form.standardCost" :decimals="PRICE_DECIMALS" :label="$t('warehouse.standardCost')" data-testid="standard-cost" />
                </v-col>
              </v-row>
            </v-tabs-window-item>
          </v-tabs-window>

    </v-form>
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { writesInventory } from 'ui-shared/nav/page-registry'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { useContactSearch, contactTitle } from 'ui-shared/composables/useContactSearch'
import { useProductTypes } from 'ui-shared/composables/useProductTypes'
import TagInput from 'ui-shared/components/TagInput.vue'
import DecimalField from 'ui-shared/components/DecimalField.vue'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import ProductTabBar from '../components/ProductTabBar.vue'
import ProductDocActions from '../components/ProductDocActions.vue'
import type { ProductForActions } from '../composables/product-doc-actions'
import { PRICE_TIER_NAMES, PRODUCT_TARIFF_CODE_MAX } from 'config/constants'
import { capOfTier } from 'config/access'
import { tierSlotsToAdd } from 'ui-shared/composables/product-price-columns'
import { PERCENT_DECIMALS, PRICE_DECIMALS, cascadeTiers, marginOver, markFollowers, priceAtMargin } from 'ui-shared/composables/price-precision'
import { useAccess } from 'ui-shared/access/useAccess'

const { t } = useI18n()
// FR-26.8.7: without `inventory.write` (a Seller) the page reads, and offers no New, Save or Delete.
const writes = writesInventory(sessionViewer())
const route = useRoute()
// FR-27.6: a role without the cost figures reads the product without them (the server sends none) and edits it
// without them: no buying price, no margins, no buying-price slot. The server keeps the stored ones.
const access = useAccess()
const seesCosts = computed(() => access.can('products.costs'))
// FR-27.11.D: the selling price and each price slot are levels a role sees or does not.
const seesSelling = computed(() => access.can('products.price:selling'))
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

interface PriceEntry {
  name: string
  price: number
  percent: number
  minQuantity: number
  validFrom: string
  validTo: string
  contactId: string
  tags: string[]
}

interface PriceTier {
  name: string
  percent: number
  finalPrice: number
  manualOverride: boolean
  contactIds: string[]
  tags: string[]
  minQuantity: number | null
  validFrom: string
  validTo: string
  /** The form's own note, never sent: this tier moves with the purchase price (`markFollowers`, `cascadeTiers`). */
  followsPurchase?: boolean
}

const FILTER_KEYS = ['contact', 'tags', 'minQty', 'validity'] as const
type FilterKey = typeof FILTER_KEYS[number]

interface Category {
  _id: string
  name: string
}

const formRef = ref()
const loading = ref(false)
const loadingCategories = ref(false)
const categories = ref<Category[]>([])
const tab = ref('basic')
const isEdit = computed(() => !!route.params.id)

// URL tab param → internal v-tabs-window value.
// URL uses `edit|pricing|settings`; internal uses `basic|pricing|inventory`.
const URL_TO_INTERNAL: Record<string, string> = { edit: 'basic', pricing: 'pricing', settings: 'inventory' }
const urlTab = computed(() => (route.params.tab as string) || 'edit')
watch(urlTab, (v) => { tab.value = URL_TO_INTERNAL[v] || 'basic' }, { immediate: true })

const form = reactive({
  sku: '', name: '', tariffCode: '', type: 'goods' as string, category: '', categoryId: null as string | null, unit: 'pcs', barcode: '',
  description: '', isActive: true,
  purchasePrice: 0, sellingPrice: 0, taxRate: 0,
  trackInventory: true, minStockLevel: 0, maxStockLevel: 0,
  costingMethod: null as string | null,
  standardCost: 0,
  tags: [] as string[],
})

/**
 * FR-22.47: the article as stored, which its „Продай" / „Резервирай" read — not the form, whose
 * „Активен" switch means nothing until it is saved. Null until the article has loaded.
 */
const storedProduct = ref<ProductForActions | null>(null)
function keepStored(p: { _id?: string; id?: string; isActive?: boolean; trackInventory?: boolean } | null | undefined) {
  if (!p) return
  storedProduct.value = {
    _id: String(p._id || p.id || route.params.id),
    isActive: p.isActive !== false,
    trackInventory: p.trackInventory !== false,
  }
}

const costingMethodItems = [
  { title: t('warehouse.costingWAC'), value: 'wac' },
  { title: 'FIFO', value: 'fifo' },
  { title: 'LIFO', value: 'lifo' },
  { title: 'FEFO', value: 'fefo' },
  { title: t('warehouse.costingStandard'), value: 'standard' },
]

const { uomOptions } = useProductUnits()
const { productTypeItems } = useProductTypes()

const priceEntries = ref<PriceEntry[]>([])
const priceTiers = ref<PriceTier[]>([])
const visibleFilters = reactive<Record<FilterKey, boolean>>({ contact: false, tags: false, minQty: false, validity: false })
/**
 * The tiers table gives each figure a width of its own (`th` widths, and the fields' minimums in the styles below). In
 * a table whose every column names a width the browser shares the rest out among them, in proportion: `#` stood 200 px
 * wide and the prices a third of the page from their names. So one more column, with no width, takes the rest, unless
 * a filter column without a width (contacts, tags) is there to take it.
 */
const spareColumn = computed(() => !visibleFilters.contact && !visibleFilters.tags)
/** The columns after the price (validity is two): what a base-price row spans with one empty cell. */
const trailingColumns = computed(() =>
  (visibleFilters.contact ? 1 : 0) + (visibleFilters.tags ? 1 : 0) + (visibleFilters.minQty ? 1 : 0)
  + (visibleFilters.validity ? 2 : 0) + (spareColumn.value ? 1 : 0))

/**
 * The contacts a tier can be limited to. Loaded unpaged until FR-22.6 — the API's 10 newest
 * contacts — so an older one could not be chosen, and a tier that already named one showed its
 * id. One list serves every tier row; the contacts any tier names stay in it.
 */
const tierContacts = useContactSearch({
  orgUrl: () => orgUrl(),
  selected: () => priceTiers.value.flatMap(t => t.contactIds || []),
})
const sellingPricePercent = ref(0)
let updatingFromPercent = false

// Canonical price-tier slots. Extended 2026-08-06 from 10 → 13 (added Цена 8/9/10):
// the storeAvailability export carries Цена0..Цена9 (the old 10-slot model truncated
// Цена8/Цена9), and Цена 10 is headroom for the full PlusMinus price-level range.
const CANONICAL_TIER_NAMES: readonly string[] = PRICE_TIER_NAMES
/** The slots this role edits: the levels it sees (FR-27.11), the buying-price one only with the cost figures. */
const tierNames = (): readonly string[] => CANONICAL_TIER_NAMES.filter(n => access.can(capOfTier(n)))

function makeDefaultTier(i: number, sellingPrice: number): PriceTier {
  return { name: tierNames()[i] || `Цена ${i}`, percent: 0, finalPrice: sellingPrice || 0, manualOverride: false, contactIds: [], tags: [], minQuantity: null, validFrom: '', validTo: '' }
}

/**
 * A slot for every level the role sees, added by name where the article has none; never one taken away.
 *
 * ⚠ FR-27.11.D: the server sends only the slots the role sees, so the form trims nothing. It used to cut the list to
 * the grant's count, and in an org on `roles` the grant is the token's claims until `/auth/me` answers: a role whose
 * legacy projection holds no price level lost every slot it was sent, and its Save then dropped them on the server.
 *
 * ⚠ Only into a free place (`tierSlotsToAdd`): an article holds `MAX_PRICE_TIERS` slots at most and the update route
 * stores what it is sent, so one whose slots carry other names („Price 1..10") must not get a second set here.
 */
function ensureTierSlots() {
  for (const name of tierSlotsToAdd(priceTiers.value.map(t => t.name), tierNames())) {
    priceTiers.value.push({ ...makeDefaultTier(0, form.sellingPrice), name })
  }
}

/**
 * The purchase price moved: a tier that follows it goes to the new price plus its margin, and a tier fixed by hand
 * keeps its price, so its margin is what moves (it was left showing the margin over the OLD purchase price).
 * Prices to four decimals, margins to three: `price-precision.ts`.
 *
 * ⚠ A tier that is neither keeps both: a slot the backfill filled with the selling price at 0 %, a price an import
 * wrote. Every tier not fixed by hand used to be moved, and such a slot then took the purchase price itself, which
 * nobody chose. The goods receipt's cascade has always told them apart; this reads the same rule (`cascadeTiers`).
 */
function recomputeTiersFromPurchase() {
  cascadeTiers(priceTiers.value, form.purchasePrice)
}

function onTierPercentChange(i: number) {
  const t = priceTiers.value[i]
  t.manualOverride = false
  // A margin typed here is a margin over the purchase price: from now on the tier follows it.
  t.followsPurchase = true
  if (form.purchasePrice) t.finalPrice = priceAtMargin(form.purchasePrice, t.percent)
}

function onTierFinalPriceChange(i: number) {
  const t = priceTiers.value[i]
  t.manualOverride = true
  t.followsPurchase = false
  if (form.purchasePrice) t.percent = marginOver(form.purchasePrice, t.finalPrice)
}

/** The stored tiers as the table edits them. */
function tiersOf(product: any): PriceTier[] {
  return (product?.priceTiers || []).map((t: any) => ({
    name: t.name || '',
    percent: Number(t.percent) || 0,
    finalPrice: Number(t.finalPrice) || 0,
    manualOverride: !!t.manualOverride,
    contactIds: (t.contactIds || []).map((id: any) => String(id)),
    tags: t.tags || [],
    minQuantity: t.minQuantity ?? null,
    validFrom: t.validFrom ? String(t.validFrom).split('T')[0] : '',
    validTo: t.validTo ? String(t.validTo).split('T')[0] : '',
  }))
}

/** The article's tiers into the table: its own, a slot for every level it lacks, and which of them follow the purchase price. */
function showTiers(product: any) {
  priceTiers.value = tiersOf(product)
  ensureTierSlots()
  markFollowers(priceTiers.value, product?.purchasePrice)
  void tierContacts.ensureSelected()
  // Turn on filter columns if any tier has a value in that filter, for nicer reveal UX.
  for (const t of priceTiers.value) {
    if (t.contactIds.length) visibleFilters.contact = true
    if (t.tags.length) visibleFilters.tags = true
    if (t.minQuantity != null) visibleFilters.minQty = true
    if (t.validFrom || t.validTo) visibleFilters.validity = true
  }
}

const rules = { required: (v: string) => !!v || t('validation.required') }
const margin = computed(() => (form.purchasePrice > 0 ? marginOver(form.purchasePrice, form.sellingPrice) : 0))

/**
 * A category is stored twice: `categoryId`, which the field edits, and the `category` name that
 * lists, reports and imports read. Some articles carry only the name (on 2026-10-26: every
 * product of the `regal` org, and the acme seed), and the field cannot show it. Saving
 * such an article used to write `category: ''`, erasing it. Now:
 *   - on load, a name exactly one category carries is linked to that category;
 *   - any other name is the field's placeholder, and saving keeps it;
 *   - the name changes only when the user changes the field: a pick takes the category's name,
 *     a clear drops it.
 */
const unlinkedCategory = computed(() => (form.categoryId ? '' : form.category))

/**
 * A NEW article has a category: the route that makes one refuses it without, and a new article saved with the
 * field empty got that refusal back as the save's error, with nothing on the field to say what was missing.
 * An article that exists may be saved with the field cleared: that drops its category, as it always did.
 */
const categoryGiven = (picked: string | null) => isEdit.value || !!picked || !!form.category || t('validation.required')
/** Whether a field of the Edit tab that must be filled is not. */
const editTabIncomplete = () => !form.sku || !form.name || !form.type || categoryGiven(form.categoryId) !== true

function linkCategoryByName() {
  if (form.categoryId || !form.category) return
  const key = (s: string) => (s || '').trim().toLocaleLowerCase('bg')
  const hits = categories.value.filter(c => key(c.name) === key(form.category))
  if (hits.length === 1) form.categoryId = hits[0]._id
}

watch(() => form.categoryId, (id, old) => {
  if (id) {
    const cat = categories.value.find(c => c._id === id)
    if (cat) form.category = cat.name
  } else if (old) {
    form.category = ''
  }
})

const { markSaved, markClean, tryRestore, snapshot } = usePendingChanges({
  appId: 'inventory',
  entityType: 'product',
  icon: 'mdi-package-variant',
  // The tiers are part of what the form holds: left out, an edit of a tier alone was no unsaved change (the form
  // let it go without a word), and edits kept for later came back with an empty tier table.
  getFormData: () => ({ ...form, priceEntries: priceEntries.value, priceTiers: priceTiers.value }),
  getPreviewFields: () => [
    { label: 'SKU', value: form.sku },
    { label: 'Name', value: form.name },
  ],
  setFormData: (data) => {
    const { priceEntries: pe, priceTiers: pt, ...rest } = data
    Object.assign(form, rest)
    if (pe) priceEntries.value = pe
    if (Array.isArray(pt)) priceTiers.value = pt
  },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

// ── EntityFormShell actions & smart buttons ──

const formActions = computed<FormAction[]>(() => {
  if (!writes) return []
  const actions: FormAction[] = [
    {
      label: t('common.save'),
      icon: 'mdi-content-save',
      color: 'primary',
      handler: handleSubmit,
      loading: loading.value,
    },
  ]
  if (isEdit.value) {
    actions.push({
      label: form.isActive !== false ? t('common.archive') : t('common.restore'),
      icon: form.isActive !== false ? 'mdi-archive' : 'mdi-archive-arrow-up',
      color: form.isActive !== false ? 'warning' : 'success',
      variant: 'outlined',
      handler: () => {
        form.isActive = !form.isActive
        handleSubmit()
      },
    })
  }
  return actions
})


// ── Percentage ↔ Price sync ──

function calcPercent(price: number): number {
  return marginOver(form.purchasePrice, price)
}

function calcPrice(percent: number): number {
  return priceAtMargin(form.purchasePrice, percent)
}

function onSellingPriceChange() {
  if (updatingFromPercent) return
  sellingPricePercent.value = calcPercent(form.sellingPrice)
}

function onSellingPercentChange() {
  updatingFromPercent = true
  form.sellingPrice = calcPrice(sellingPricePercent.value)
  updatingFromPercent = false
}

function onPurchasePriceChange() {
  // Recalculate selling-price margin from current absolute prices
  sellingPricePercent.value = calcPercent(form.sellingPrice)
  // Cascade: each tier that follows the purchase price from its margin, each fixed one's margin from its price
  recomputeTiersFromPurchase()
  for (const entry of priceEntries.value) {
    entry.percent = calcPercent(entry.price)
  }
}

function onEntryPriceChange(i: number) {
  if (updatingFromPercent) return
  priceEntries.value[i].percent = calcPercent(priceEntries.value[i].price)
}

function onEntryPercentChange(i: number) {
  updatingFromPercent = true
  priceEntries.value[i].price = calcPrice(priceEntries.value[i].percent)
  updatingFromPercent = false
}

// ── Price entries ──

function addPriceEntry() {
  priceEntries.value.push({ name: '', price: 0, percent: 0, minQuantity: 0, validFrom: '', validTo: '', contactId: '', tags: [] })
}

function splitPriceEntries() {
  const customPrices: any[] = []
  const tagPrices: any[] = []

  for (const entry of priceEntries.value) {
    const base = {
      name: entry.name,
      price: entry.price,
      minQuantity: entry.minQuantity || undefined,
      validFrom: entry.validFrom || undefined,
      validTo: entry.validTo || undefined,
    }

    if (entry.contactId) {
      customPrices.push({ ...base, contactId: entry.contactId })
    }

    for (const tag of (entry.tags || [])) {
      tagPrices.push({ ...base, tag })
    }
  }

  return { customPrices, tagPrices }
}

function mergePriceEntries(customPrices: any[], tagPrices: any[]): PriceEntry[] {
  const entries: PriceEntry[] = []

  for (const cp of customPrices) {
    const matchingTags = tagPrices.filter(tp => tp.name === cp.name && tp.price === cp.price)
    if (matchingTags.length > 0) {
      entries.push({
        name: cp.name || '',
        price: cp.price || 0,
        percent: calcPercent(cp.price || 0),
        minQuantity: cp.minQuantity || 0,
        validFrom: cp.validFrom?.split('T')[0] || '',
        validTo: cp.validTo?.split('T')[0] || '',
        contactId: cp.contactId ? String(cp.contactId) : '',
        tags: matchingTags.map((tp: any) => tp.tag),
      })
      for (const mt of matchingTags) mt._merged = true
    } else {
      entries.push({
        name: cp.name || '',
        price: cp.price || 0,
        percent: calcPercent(cp.price || 0),
        minQuantity: cp.minQuantity || 0,
        validFrom: cp.validFrom?.split('T')[0] || '',
        validTo: cp.validTo?.split('T')[0] || '',
        contactId: cp.contactId ? String(cp.contactId) : '',
        tags: [],
      })
    }
  }

  const remaining = tagPrices.filter((tp: any) => !tp._merged)
  const grouped = new Map<string, any[]>()
  for (const tp of remaining) {
    const key = `${tp.name}|${tp.price}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(tp)
  }

  for (const group of grouped.values()) {
    const first = group[0]
    entries.push({
      name: first.name || '',
      price: first.price || 0,
      percent: calcPercent(first.price || 0),
      minQuantity: first.minQuantity || 0,
      validFrom: first.validFrom?.split('T')[0] || '',
      validTo: first.validTo?.split('T')[0] || '',
      contactId: '',
      tags: group.map((tp: any) => tp.tag),
    })
  }

  return entries
}

// ── API ──

async function fetchCategories() {
  loadingCategories.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/product-category?size=0`)
    categories.value = data.productCategories || []
  } finally {
    loadingCategories.value = false
  }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) {
    // What must be filled is on the Edit tab. Asked from another tab, the save did nothing and said nothing: the
    // field that stops it is shown instead.
    if (urlTab.value !== 'edit' && editTabIncomplete()) router.replace({ params: { ...route.params, tab: 'edit' } })
    return
  }
  loading.value = true
  try {
    // Set category name from selected category for backward compat. No category selected leaves
    // the name alone: clearing the field already dropped it, and a name no category carries is kept.
    if (form.categoryId) {
      const cat = categories.value.find(c => c._id === form.categoryId)
      if (cat) form.category = cat.name
    }
    // As it is stored (the model trims it): the field shows what the article now holds.
    form.tariffCode = (form.tariffCode || '').trim()

    // Legacy customPrices/tagPrices UI was retired in Phase 7 (2026-04-21).
    // The server preserves the existing arrays when the field is omitted.
    const tiersPayload = priceTiers.value.map(t => ({
      name: t.name,
      percent: Number(t.percent) || 0,
      finalPrice: Number(t.finalPrice) || 0,
      manualOverride: !!t.manualOverride,
      contactIds: (t.contactIds || []).filter(Boolean),
      tags: (t.tags || []).filter(Boolean),
      minQuantity: t.minQuantity != null && t.minQuantity !== ('' as any) ? Number(t.minQuantity) : undefined,
      validFrom: t.validFrom || undefined,
      validTo: t.validTo || undefined,
    }))
    const payload: Record<string, any> = { ...form, priceTiers: tiersPayload }
    if (!seesCosts.value) {
      // Nothing it cannot see: the server keeps the stored costs and margins.
      delete payload.purchasePrice
      delete payload.standardCost
      for (const t of tiersPayload as any[]) delete t.percent
    }
    // FR-27.11.C.4: nor a price of a level it does not see; the server merges the slots by name.
    if (!seesSelling.value) delete payload.sellingPrice

    if (isEdit.value) {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/product/${route.params.id}`, payload)
      markSaved()
      keepStored(data?.product)
      // The form stays open on what it saved, on the current tab: an edit from here is unsaved again. `markSaved`
      // alone let every later edit go without a word.
      markClean()
      showSuccess(t('common.savedSuccessfully'))
    } else {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/product`, payload)
      markSaved()
      // The new article opens as itself in this same form: what is edited there is unsaved again.
      markClean()
      showSuccess(t('common.savedSuccessfully'))
      const newId = data?.product?._id || data?._id
      if (newId) router.push({ name: 'inventory.products.edit', params: { id: newId, tab: urlTab.value } })
      else router.push({ name: 'inventory.products' })
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

onMounted(async () => {
  // Helpers the form offers, never a condition of reading the article: a role without contacts or categories (a role
  // made for products alone, FR-27.4) still opens it. `Promise.all` left the form empty on the first refusal.
  await Promise.allSettled([tierContacts.search(), fetchCategories()])
  if (tryRestore()) {
    // The form holds the restored edits; the header's actions still read the article as stored.
    if (isEdit.value) {
      httpClient.get(`${orgUrl()}/warehouse/product/${route.params.id}`)
        .then(({ data }) => {
          keepStored(data?.product)
          // Edits kept before the tiers were kept with them: the table shows the stored tiers, not nothing.
          if (!priceTiers.value.length) {
            showTiers(data?.product)
            snapshot()
          }
        })
        .catch(() => { /* no actions until it can be read */ })
    } else if (!priceTiers.value.length) {
      ensureTierSlots()
      markFollowers(priceTiers.value, 0)
    }
    return
  }
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product/${route.params.id}`)
      const p = data.product || data
      Object.assign(form, {
        sku: p.sku || '', name: p.name || '', tariffCode: p.tariffCode || '', type: p.type || 'goods', category: p.category || '',
        categoryId: p.categoryId || null,
        unit: p.unit || 'pcs', barcode: p.barcode || '', description: p.description || '',
        isActive: p.isActive ?? true, purchasePrice: p.purchasePrice || 0, sellingPrice: p.sellingPrice || 0, taxRate: p.taxRate || 0,
        trackInventory: p.trackInventory ?? true, minStockLevel: p.minStockLevel || 0,
        maxStockLevel: p.maxStockLevel || 0,
        costingMethod: p.costingMethod || null,
        standardCost: p.standardCost || 0,
        tags: p.tags || [],
      })
      keepStored(p)
      linkCategoryByName()
      sellingPricePercent.value = calcPercent(form.sellingPrice)
      priceEntries.value = mergePriceEntries(p.customPrices || [], p.tagPrices || [])
      // The article's price tiers; a slot with base-price defaults for every level it lacks.
      showTiers(p)
    } catch { /* handle */ }
  } else {
    // New product: seed the default slots client-side so the table is always full. (This called
    // `ensureTenTiers`, gone since the 10 → 13 rename, and threw on every new article — FR-22 B-2.)
    ensureTierSlots()
    // Empty slots at no purchase price yet: they follow the one typed, as they always did.
    markFollowers(priceTiers.value, 0)
    await applyOrgDefaultVat()
  }
  // The clean state is the loaded article, taken once the field watchers have run (FR-22.13).
  // The default snapshot fires 500 ms after mount: a slower load left an untouched form dirty.
  await nextTick()
  snapshot()
})

/**
 * A new article starts at the org's default VAT rate, the one documents preselect, instead of
 * 0 % (FR-22 B-3). A rate the user has already typed is kept; a failed fetch keeps the field as is.
 */
async function applyOrgDefaultVat() {
  try {
    const { data } = await httpClient.get(orgUrl())
    const rate = (data?.org?.settings || data?.settings)?.taxConfig?.defaultVatRate
    if (typeof rate === 'number' && form.taxRate === 0) form.taxRate = rate
  } catch { /* keep the field as is */ }
}
</script>

<style scoped>
/*
 * Wide enough for the figures these fields keep, whatever else the table shows: a margin of four digits and three
 * decimals with its sign (-2000.555), and a price of six digits and four decimals (123456.7891) beside the lock of a
 * price fixed by hand. `ch` is a digit's width in the field's own font; the pixels are the field's paddings, its
 * suffix and its icon.
 */
.tier-percent {
  min-width: calc(9ch + 16px);
}
.tier-price {
  min-width: calc(11ch + 16px + 32px);
}
.base-margin {
  flex: 0 0 calc(9ch + 16px + 28px);
}
.base-price {
  flex-basis: calc(11ch + 16px);
}

/*
 * The wider figures must not be paid for by the columns beside them: a date squeezed to "dd/m" says nothing. With
 * every filter shown in a narrow window the table scrolls sideways (`v-table` does) before a field is cut.
 */
.tier-name {
  min-width: 140px;
}
.tier-min-qty {
  min-width: 80px;
}
.tier-date {
  min-width: 136px;
}

/* The two base prices at the head of the tiers: the article's own prices, not slots of it. */
.tier-base-row {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
/* Reads as the tier names under it, which are fields: their size, 8px in from the cell, 3px under its middle. */
.tier-base-name {
  display: inline-block;
  padding-inline-start: 8px;
  padding-top: 6px;
  font-size: 1rem;
  font-weight: 500;
}
</style>
