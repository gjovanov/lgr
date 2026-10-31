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

    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <ProductTabBar :active-tab="urlTab" :is-new="!isEdit" :product-id="(route.params.id as string) || ''" />

          <v-tabs-window v-model="tab" class="pt-2">
            <!-- Basic Info -->
            <v-tabs-window-item value="basic">
              <v-row>
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.sku" :label="$t('warehouse.sku')" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-select v-model="form.type" :label="$t('common.type')" :items="productTypeItems()" :rules="[rules.required]" />
                </v-col>
              </v-row>
              <v-row>
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
                    clearable
                  />
                </v-col>
                <v-col cols="12" md="4">
                  <v-autocomplete v-model="form.unit" :label="$t('warehouse.unit')" :items="uomOptions" item-title="title" item-value="value" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.barcode" :label="$t('warehouse.barcode')" />
                </v-col>
              </v-row>
              <v-textarea v-model="form.description" :label="$t('common.description')" rows="3" />
              <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" />
              <TagInput v-model="form.tags" type="product" :org-url="orgUrl()" />
            </v-tabs-window-item>

            <!-- Pricing (base prices + custom prices merged) -->
            <v-tabs-window-item value="pricing">
              <!-- Base prices: 4 fields in one row -->
              <p class="text-subtitle-1 font-weight-bold mb-3">{{ $t('warehouse.basePrices') }}</p>
              <v-row>
                <v-col cols="12" sm="6" md="3">
                  <v-text-field
                    v-model.number="form.purchasePrice"
                    :label="$t('warehouse.purchasePrice')"
                    type="number"
                    step="0.01"
                    @update:model-value="onPurchasePriceChange"
                  />
                </v-col>
                <v-col cols="12" sm="6" md="3">
                  <div class="d-flex ga-2 align-start">
                    <v-text-field
                      v-model.number="form.sellingPrice"
                      :label="$t('warehouse.sellingPrice')"
                      type="number"
                      step="0.01"
                      class="flex-grow-1"
                      @update:model-value="onSellingPriceChange"
                    />
                    <v-text-field
                      v-model.number="sellingPricePercent"
                      :label="$t('warehouse.margin')"
                      type="number"
                      step="0.1"
                      suffix="%"
                      style="max-width: 100px"
                      :disabled="!form.purchasePrice"
                      @update:model-value="onSellingPercentChange"
                    />
                  </div>
                </v-col>
                <v-col cols="12" sm="6" md="3">
                  <v-text-field v-model.number="form.taxRate" :label="$t('warehouse.taxRate')" type="number" suffix="%" />
                </v-col>
                <v-col cols="12" sm="6" md="3">
                  <v-text-field :model-value="margin" :label="$t('warehouse.margin')" suffix="%" readonly />
                </v-col>
              </v-row>

              <v-divider class="my-4" />

              <!-- Price Tiers (13 slots: Доставна, Цена на едро, Цена 0..Цена 10) -->
              <div class="d-flex align-center mb-2">
                <p class="text-subtitle-1 font-weight-bold">{{ $t('warehouse.priceTiers') }}</p>
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

              <v-table density="compact" class="mb-4">
                <thead>
                  <tr>
                    <th style="width: 40px">#</th>
                    <th style="width: 22%">{{ $t('common.name') }}</th>
                    <th style="width: 80px">%</th>
                    <th style="width: 120px">{{ $t('warehouse.finalPrice') }}</th>
                    <th v-if="visibleFilters.contact">{{ $t('invoicing.contact') }}</th>
                    <th v-if="visibleFilters.tags">{{ $t('warehouse.contactTags') }}</th>
                    <th v-if="visibleFilters.minQty" style="width: 110px">{{ $t('warehouse.minQuantity') }}</th>
                    <th v-if="visibleFilters.validity" style="width: 160px">{{ $t('warehouse.validFrom') }}</th>
                    <th v-if="visibleFilters.validity" style="width: 160px">{{ $t('warehouse.validTo') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(tier, i) in priceTiers" :key="i">
                    <td class="text-medium-emphasis">{{ i + 1 }}</td>
                    <td>
                      <v-text-field v-model="tier.name" density="compact" hide-details variant="plain" :rules="[rules.required]" />
                    </td>
                    <td>
                      <v-text-field
                        v-model.number="tier.percent"
                        type="number"
                        step="0.1"
                        density="compact"
                        hide-details
                        variant="plain"
                        :disabled="!form.purchasePrice"
                        @update:model-value="onTierPercentChange(i)"
                      />
                    </td>
                    <td>
                      <v-text-field
                        v-model.number="tier.finalPrice"
                        type="number"
                        step="0.01"
                        density="compact"
                        hide-details
                        variant="plain"
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
                      <v-text-field v-model.number="tier.minQuantity" type="number" density="compact" hide-details variant="plain" />
                    </td>
                    <td v-if="visibleFilters.validity">
                      <v-text-field v-model="tier.validFrom" type="date" density="compact" hide-details variant="plain" />
                    </td>
                    <td v-if="visibleFilters.validity">
                      <v-text-field v-model="tier.validTo" type="date" density="compact" hide-details variant="plain" />
                    </td>
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
                <v-col v-if="form.costingMethod === 'standard'" cols="12" md="4">
                  <v-text-field v-model.number="form.standardCost" :label="$t('warehouse.standardCost')" type="number" min="0" step="0.01" />
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
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import { useProductUnits } from 'ui-shared/composables/useProductUnits'
import { useContactSearch, contactTitle } from 'ui-shared/composables/useContactSearch'
import { useProductTypes } from 'ui-shared/composables/useProductTypes'
import TagInput from 'ui-shared/components/TagInput.vue'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import ProductTabBar from '../components/ProductTabBar.vue'
import ProductDocActions from '../components/ProductDocActions.vue'
import type { ProductForActions } from '../composables/product-doc-actions'
import { PRICE_TIER_NAMES } from 'config/constants'

const { t } = useI18n()
const route = useRoute()
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
  sku: '', name: '', type: 'goods' as string, category: '', categoryId: null as string | null, unit: 'pcs', barcode: '',
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
const TIER_SLOT_COUNT = CANONICAL_TIER_NAMES.length

function makeDefaultTier(i: number, sellingPrice: number): PriceTier {
  return { name: CANONICAL_TIER_NAMES[i] || `Цена ${i}`, percent: 0, finalPrice: sellingPrice || 0, manualOverride: false, contactIds: [], tags: [], minQuantity: null, validFrom: '', validTo: '' }
}

function ensureTierSlots() {
  const target = TIER_SLOT_COUNT
  while (priceTiers.value.length < target) {
    priceTiers.value.push(makeDefaultTier(priceTiers.value.length, form.sellingPrice))
  }
  if (priceTiers.value.length > target) priceTiers.value.length = target
}

function recomputeTiersFromPurchase() {
  if (!form.purchasePrice) return
  for (const t of priceTiers.value) {
    if (!t.manualOverride) t.finalPrice = +(form.purchasePrice * (1 + (t.percent || 0) / 100)).toFixed(2)
  }
}

function onTierPercentChange(i: number) {
  const t = priceTiers.value[i]
  t.manualOverride = false
  if (form.purchasePrice) t.finalPrice = +(form.purchasePrice * (1 + (t.percent || 0) / 100)).toFixed(2)
}

function onTierFinalPriceChange(i: number) {
  const t = priceTiers.value[i]
  t.manualOverride = true
  if (form.purchasePrice) t.percent = +(((t.finalPrice - form.purchasePrice) / form.purchasePrice) * 100).toFixed(1)
}

const rules = { required: (v: string) => !!v || t('validation.required') }
const margin = computed(() => form.purchasePrice > 0 ? (((form.sellingPrice - form.purchasePrice) / form.purchasePrice) * 100).toFixed(1) : '0.0')

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

const { markSaved, tryRestore, snapshot } = usePendingChanges({
  appId: 'inventory',
  entityType: 'product',
  icon: 'mdi-package-variant',
  getFormData: () => ({ ...form, priceEntries: priceEntries.value }),
  getPreviewFields: () => [
    { label: 'SKU', value: form.sku },
    { label: 'Name', value: form.name },
  ],
  setFormData: (data) => {
    const { priceEntries: pe, ...rest } = data
    Object.assign(form, rest)
    if (pe) priceEntries.value = pe
  },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

// ── EntityFormShell actions & smart buttons ──

const formActions = computed<FormAction[]>(() => {
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
  if (!form.purchasePrice) return 0
  return +((( price - form.purchasePrice) / form.purchasePrice) * 100).toFixed(1)
}

function calcPrice(percent: number): number {
  return +(form.purchasePrice * (1 + percent / 100)).toFixed(2)
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
  // Cascade: recompute each non-overridden tier from its stored percent
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
  if (!valid) return
  loading.value = true
  try {
    // Set category name from selected category for backward compat. No category selected leaves
    // the name alone: clearing the field already dropped it, and a name no category carries is kept.
    if (form.categoryId) {
      const cat = categories.value.find(c => c._id === form.categoryId)
      if (cat) form.category = cat.name
    }

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
    const payload = { ...form, priceTiers: tiersPayload }

    if (isEdit.value) {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/product/${route.params.id}`, payload)
      markSaved()
      keepStored(data?.product)
      showSuccess(t('common.savedSuccessfully'))
      // Stay on the current tab.
    } else {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/product`, payload)
      markSaved()
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
  await Promise.all([tierContacts.search(), fetchCategories()])
  if (tryRestore()) {
    // The form holds the restored edits; the header's actions still read the article as stored.
    if (isEdit.value) {
      httpClient.get(`${orgUrl()}/warehouse/product/${route.params.id}`)
        .then(({ data }) => keepStored(data?.product))
        .catch(() => { /* no actions until it can be read */ })
    }
    return
  }
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product/${route.params.id}`)
      const p = data.product || data
      Object.assign(form, {
        sku: p.sku || '', name: p.name || '', type: p.type || 'goods', category: p.category || '',
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
      // Load existing priceTiers; pad to 13 slots with base-price defaults if fewer exist.
      priceTiers.value = (p.priceTiers || []).map((t: any) => ({
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
      ensureTierSlots()
      void tierContacts.ensureSelected()
      // Turn on filter columns if any tier has a value in that filter, for nicer reveal UX.
      for (const t of priceTiers.value) {
        if (t.contactIds.length) visibleFilters.contact = true
        if (t.tags.length) visibleFilters.tags = true
        if (t.minQuantity != null) visibleFilters.minQty = true
        if (t.validFrom || t.validTo) visibleFilters.validity = true
      }
    } catch { /* handle */ }
  } else {
    // New product: seed the default slots client-side so the table is always full. (This called
    // `ensureTenTiers`, gone since the 10 → 13 rename, and threw on every new article — FR-22 B-2.)
    ensureTierSlots()
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
