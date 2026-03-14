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
            <v-tab value="customPrices">{{ $t('warehouse.customPrices') }}</v-tab>
          </v-tabs>

          <v-tabs-window v-model="tab" class="mt-6 pt-4">
            <!-- Basic Info -->
            <v-tabs-window-item value="basic" >
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
                  <v-text-field v-model="form.unit" :label="$t('warehouse.unit')" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model="form.barcode" :label="$t('warehouse.barcode')" />
                </v-col>
              </v-row>
              <v-textarea v-model="form.description" :label="$t('common.description')" rows="3" />
              <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" />
              <TagInput v-model="form.tags" type="product" :org-url="orgUrl()" />
            </v-tabs-window-item>

            <!-- Pricing -->
            <v-tabs-window-item value="pricing">
              <v-row>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.purchasePrice" :label="$t('warehouse.purchasePrice')" type="number" step="0.01" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.sellingPrice" :label="$t('warehouse.sellingPrice')" type="number" step="0.01" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.taxRate" :label="$t('warehouse.taxRate')" type="number" suffix="%" />
                </v-col>
              </v-row>
              <v-row>
                <v-col cols="12" md="4">
                  <v-text-field :model-value="margin" :label="$t('warehouse.margin')" suffix="%" readonly />
                </v-col>
              </v-row>
            </v-tabs-window-item>

            <!-- Inventory Settings -->
            <v-tabs-window-item value="inventory">
              <v-switch v-model="form.trackInventory" :label="$t('warehouse.trackInventory')" color="primary" />
              <v-row v-if="form.trackInventory">
                <v-col cols="12" md="6">
                  <v-text-field v-model.number="form.minStockLevel" :label="$t('warehouse.minStockLevel')" type="number" min="0" />
                </v-col>
                <v-col cols="12" md="6">
                  <v-text-field v-model.number="form.maxStockLevel" :label="$t('warehouse.maxStockLevel')" type="number" min="0" />
                </v-col>
              </v-row>
            </v-tabs-window-item>

            <!-- Custom Prices (unified: contact-based + tag-based) -->
            <v-tabs-window-item value="customPrices">
              <p class="text-body-2 text-medium-emphasis mb-4">
                {{ $t('warehouse.customPricesHelp') || 'Define custom prices for specific contacts or contact tags. Tag-based prices apply to all contacts with matching tags.' }}
              </p>
              <div v-for="(entry, i) in priceEntries" :key="i" class="mb-4 pa-4 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ entry.name || ($t('warehouse.customPrice') + ' ' + (i + 1)) }}</span>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="small" color="error" @click="priceEntries.splice(i, 1)" />
                </div>
                <v-row>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="entry.name" :label="$t('common.name')" density="compact" :rules="[rules.required]" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model.number="entry.price" :label="$t('warehouse.price')" type="number" step="0.01" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model.number="entry.minQuantity" :label="$t('warehouse.minQuantity')" type="number" density="compact" />
                  </v-col>
                </v-row>
                <v-row>
                  <v-col cols="12" md="3">
                    <v-text-field v-model="entry.validFrom" :label="$t('warehouse.validFrom')" type="date" density="compact" />
                  </v-col>
                  <v-col cols="12" md="3">
                    <v-text-field v-model="entry.validTo" :label="$t('warehouse.validTo')" type="date" density="compact" />
                  </v-col>
                  <v-col cols="12" md="3">
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
                  <v-col cols="12" md="3">
                    <TagInput
                      v-model="entry.tags"
                      type="contact"
                      :org-url="orgUrl()"
                      :label="$t('warehouse.contactTags') || 'Contact Tags'"
                    />
                  </v-col>
                </v-row>
              </div>
              <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addPriceEntry">
                {{ $t('warehouse.addCustomPrice') }}
              </v-btn>
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
import { ref, reactive, computed, onMounted } from 'vue'
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
  tags: [] as string[],
})

// Unified price entries (merged view of customPrices + tagPrices)
const priceEntries = ref<PriceEntry[]>([])

const rules = { required: (v: string) => !!v || t('validation.required') }
const margin = computed(() => form.purchasePrice > 0 ? (((form.sellingPrice - form.purchasePrice) / form.purchasePrice) * 100).toFixed(1) : '0.0')

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function addPriceEntry() {
  priceEntries.value.push({ name: '', price: 0, minQuantity: 1, validFrom: '', validTo: '', contactId: '', tags: [] })
}

// Split unified entries into customPrices + tagPrices for the API
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

// Merge customPrices + tagPrices from API into unified entries
function mergePriceEntries(customPrices: any[], tagPrices: any[]): PriceEntry[] {
  const entries: PriceEntry[] = []

  // Add contact-based prices
  for (const cp of customPrices) {
    // Check if there's a tagPrice with the same name to merge
    const matchingTags = tagPrices.filter(tp => tp.name === cp.name && tp.price === cp.price)
    if (matchingTags.length > 0) {
      entries.push({
        name: cp.name || '',
        price: cp.price || 0,
        minQuantity: cp.minQuantity || 1,
        validFrom: cp.validFrom?.split('T')[0] || '',
        validTo: cp.validTo?.split('T')[0] || '',
        contactId: cp.contactId ? String(cp.contactId) : '',
        tags: matchingTags.map((tp: any) => tp.tag),
      })
      // Mark these tagPrices as consumed
      for (const mt of matchingTags) mt._merged = true
    } else {
      entries.push({
        name: cp.name || '',
        price: cp.price || 0,
        minQuantity: cp.minQuantity || 1,
        validFrom: cp.validFrom?.split('T')[0] || '',
        validTo: cp.validTo?.split('T')[0] || '',
        contactId: cp.contactId ? String(cp.contactId) : '',
        tags: [],
      })
    }
  }

  // Group remaining tagPrices by name+price
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
      minQuantity: first.minQuantity || 1,
      validFrom: first.validFrom?.split('T')[0] || '',
      validTo: first.validTo?.split('T')[0] || '',
      contactId: '',
      tags: group.map((tp: any) => tp.tag),
    })
  }

  return entries
}

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
        tags: p.tags || [],
      })
      priceEntries.value = mergePriceEntries(p.customPrices || [], p.tagPrices || [])
    } catch { /* handle */ }
  }
})
</script>
