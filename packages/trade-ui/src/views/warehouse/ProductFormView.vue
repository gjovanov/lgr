<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ isEdit ? $t('warehouse.editProduct') : $t('warehouse.newProduct') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <v-tabs v-model="tab">
            <v-tab value="basic">{{ $t('warehouse.basicInfo') }}</v-tab>
            <v-tab value="pricing">{{ $t('warehouse.pricing') }}</v-tab>
            <v-tab value="inventory">{{ $t('warehouse.inventorySettings') }}</v-tab>
          </v-tabs>

          <v-tabs-window v-model="tab" class="mt-6 pt-4">
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
                  <v-select v-model="form.type" :label="$t('common.type')" :items="['goods', 'service', 'raw_material', 'finished_product']" :rules="[rules.required]" />
                </v-col>
              </v-row>
              <v-row>
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.category" :label="$t('warehouse.category')" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-combobox v-model="form.unit" :label="$t('warehouse.unit')" :items="uomOptions" item-title="title" item-value="value" />
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

              <!-- Custom Prices -->
              <div class="d-flex align-center mb-3">
                <p class="text-subtitle-1 font-weight-bold">{{ $t('warehouse.customPrices') }}</p>
                <v-spacer />
                <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addPriceEntry">
                  {{ $t('warehouse.addCustomPrice') }}
                </v-btn>
              </div>
              <p v-if="priceEntries.length === 0" class="text-body-2 text-medium-emphasis mb-4">
                {{ $t('warehouse.customPricesHelp') }}
              </p>
              <div v-for="(entry, i) in priceEntries" :key="i" class="mb-4 pa-4 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ entry.name || ($t('warehouse.customPrice') + ' ' + (i + 1)) }}</span>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="small" color="error" @click="priceEntries.splice(i, 1)" />
                </div>
                <v-row>
                  <v-col cols="12" sm="6" md="3">
                    <v-text-field v-model="entry.name" :label="$t('common.name')" density="compact" :rules="[rules.required]" />
                  </v-col>
                  <v-col cols="12" sm="6" md="3">
                    <div class="d-flex ga-2 align-start">
                      <v-text-field
                        v-model.number="entry.price"
                        :label="$t('warehouse.price')"
                        type="number"
                        step="0.01"
                        density="compact"
                        class="flex-grow-1"
                        @update:model-value="onEntryPriceChange(i)"
                      />
                      <v-text-field
                        v-model.number="entry.percent"
                        :label="'%'"
                        type="number"
                        step="0.1"
                        suffix="%"
                        density="compact"
                        style="max-width: 90px"
                        :disabled="!form.purchasePrice"
                        @update:model-value="onEntryPercentChange(i)"
                      />
                    </div>
                  </v-col>
                  <v-col cols="12" sm="6" md="3">
                    <v-text-field v-model.number="entry.minQuantity" :label="$t('warehouse.minQuantity')" type="number" density="compact" />
                  </v-col>
                  <v-col cols="12" sm="6" md="3">
                    <v-text-field v-model="entry.validFrom" :label="$t('warehouse.validFrom')" type="date" density="compact" />
                  </v-col>
                </v-row>
                <v-row>
                  <v-col cols="12" sm="6" md="3">
                    <v-text-field v-model="entry.validTo" :label="$t('warehouse.validTo')" type="date" density="compact" />
                  </v-col>
                  <v-col cols="12" sm="6" md="3">
                    <v-autocomplete
                      v-model="entry.contactId"
                      :label="$t('invoicing.contact')"
                      :items="contacts"
                      item-title="companyName"
                      item-value="_id"
                      :loading="loadingContacts"
                      density="compact"
                      clearable
                    />
                  </v-col>
                  <v-col cols="12" sm="6" md="6">
                    <TagInput
                      v-model="entry.tags"
                      type="contact"
                      :org-url="orgUrl()"
                      :label="$t('warehouse.contactTags')"
                    />
                  </v-col>
                </v-row>
              </div>
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

          <div class="d-flex justify-end mt-6">
            <v-btn variant="text" class="mr-2" @click="router.back()">{{ $t('common.cancel') }}</v-btn>
            <v-btn type="submit" color="primary" :loading="loading">{{ $t('common.save') }}</v-btn>
          </div>
        </v-form>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import TagInput from 'ui-shared/components/TagInput.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

interface Contact {
  _id: string
  companyName: string
}

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

const formRef = ref()
const loading = ref(false)
const loadingContacts = ref(false)
const contacts = ref<Contact[]>([])
const tab = ref('basic')
const isEdit = computed(() => !!route.params.id)

const form = reactive({
  sku: '', name: '', type: 'goods' as string, category: '', unit: 'pcs', barcode: '',
  description: '', isActive: true,
  purchasePrice: 0, sellingPrice: 0, taxRate: 0,
  trackInventory: true, minStockLevel: 0, maxStockLevel: 0,
  costingMethod: null as string | null,
  standardCost: 0,
  tags: [] as string[],
})

const costingMethodItems = [
  { title: t('warehouse.costingWAC'), value: 'wac' },
  { title: 'FIFO', value: 'fifo' },
  { title: 'LIFO', value: 'lifo' },
  { title: 'FEFO', value: 'fefo' },
  { title: t('warehouse.costingStandard'), value: 'standard' },
]

const uomCodes = ['pcs', 'pair', 'set', 'box', 'pack', 'dozen', 'g', 'kg', 'ton', 'lb', 'oz', 'ml', 'L', 'm3', 'gal', 'mm', 'cm', 'm', 'km', 'in', 'ft', 'm2', 'ha', 'hr', 'day', 'month']
const uomOptions = uomCodes.map(code => ({ title: `${t(`warehouse.uom.${code}`)} (${code})`, value: code }))

const priceEntries = ref<PriceEntry[]>([])
const sellingPricePercent = ref(0)
let updatingFromPercent = false

const rules = { required: (v: string) => !!v || t('validation.required') }
const margin = computed(() => form.purchasePrice > 0 ? (((form.sellingPrice - form.purchasePrice) / form.purchasePrice) * 100).toFixed(1) : '0.0')

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

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
  // Recalculate all percentages from current absolute prices
  sellingPricePercent.value = calcPercent(form.sellingPrice)
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

async function fetchContacts() {
  loadingContacts.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`)
    contacts.value = data.contacts || []
  } finally {
    loadingContacts.value = false
  }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    const { customPrices, tagPrices } = splitPriceEntries()
    const payload = { ...form, customPrices, tagPrices }

    if (isEdit.value) await httpClient.put(`${orgUrl()}/warehouse/product/${route.params.id}`, payload)
    else await httpClient.post(`${orgUrl()}/warehouse/product`, payload)
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'warehouse.products' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

onMounted(async () => {
  await fetchContacts()
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product/${route.params.id}`)
      const p = data.product || data
      Object.assign(form, {
        sku: p.sku || '', name: p.name || '', type: p.type || 'goods', category: p.category || '',
        unit: p.unit || 'pcs', barcode: p.barcode || '', description: p.description || '',
        isActive: p.isActive ?? true, purchasePrice: p.purchasePrice || 0, sellingPrice: p.sellingPrice || 0, taxRate: p.taxRate || 0,
        trackInventory: p.trackInventory ?? true, minStockLevel: p.minStockLevel || 0,
        maxStockLevel: p.maxStockLevel || 0,
        costingMethod: p.costingMethod || null,
        standardCost: p.standardCost || 0,
        tags: p.tags || [],
      })
      sellingPricePercent.value = calcPercent(form.sellingPrice)
      priceEntries.value = mergePriceEntries(p.customPrices || [], p.tagPrices || [])
    } catch { /* handle */ }
  }
})
</script>
