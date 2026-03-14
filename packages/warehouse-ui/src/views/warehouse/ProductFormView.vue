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
            <v-tab value="tagPrices">{{ $t('warehouse.tagPrices') || 'Tag Prices' }}</v-tab>
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

            <!-- Tag Prices -->
            <v-tabs-window-item value="tagPrices">
              <p class="text-body-2 text-medium-emphasis mb-4">
                {{ $t('warehouse.tagPricesHelp') || 'Define prices for contacts with specific tags. When a contact has a matching tag, this price overrides the selling price.' }}
              </p>
              <div v-for="(tp, i) in form.tagPrices" :key="i" class="mb-4 pa-4 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ tp.name || ($t('warehouse.tagPrice') || 'Tag Price') + ' ' + (i + 1) }}</span>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="small" color="error" @click="form.tagPrices.splice(i, 1)" />
                </div>
                <v-row>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="tp.name" :label="$t('common.name')" density="compact" :rules="[rules.required]" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model.number="tp.price" :label="$t('warehouse.price')" type="number" step="0.01" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model.number="tp.minQuantity" :label="$t('warehouse.minQuantity')" type="number" density="compact" />
                  </v-col>
                </v-row>
                <v-row>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="tp.validFrom" :label="$t('warehouse.validFrom')" type="date" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="tp.validTo" :label="$t('warehouse.validTo')" type="date" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-autocomplete
                      v-model="tp.tag"
                      :label="$t('common.tag') || 'Contact Tag'"
                      :items="contactTags"
                      density="compact"
                      :rules="[rules.required]"
                      :loading="loadingContactTags"
                      auto-select-first
                    />
                  </v-col>
                </v-row>
              </div>
              <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addTagPrice">
                {{ $t('warehouse.addTagPrice') || 'Add Tag Price' }}
              </v-btn>
            </v-tabs-window-item>

            <!-- Custom Prices -->
            <v-tabs-window-item value="customPrices">
              <div v-for="(cp, i) in form.customPrices" :key="i" class="mb-4 pa-4 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ cp.name || ($t('warehouse.customPrice') + ' ' + (i + 1)) }}</span>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="small" color="error" @click="form.customPrices.splice(i, 1)" />
                </div>
                <v-row>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="cp.name" :label="$t('common.name')" density="compact" :rules="[rules.required]" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model.number="cp.price" :label="$t('warehouse.price')" type="number" step="0.01" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model.number="cp.minQuantity" :label="$t('warehouse.minQuantity')" type="number" density="compact" />
                  </v-col>
                </v-row>
                <v-row>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="cp.validFrom" :label="$t('warehouse.validFrom')" type="date" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field v-model="cp.validTo" :label="$t('warehouse.validTo')" type="date" density="compact" />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-autocomplete
                      v-model="cp.contactId"
                      :label="$t('invoicing.contact')"
                      :items="contacts"
                      item-title="companyName"
                      item-value="_id"
                      :loading="loadingContacts"
                      density="compact"
                    />
                  </v-col>
                </v-row>
              </div>
              <v-btn variant="outlined" prepend-icon="mdi-plus" size="small" @click="addCustomPrice">
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
  customPrices: [] as Array<{ name: string; contactId: string; price: number; minQuantity: number; validFrom: string; validTo: string }>,
  tagPrices: [] as Array<{ name: string; tag: string; price: number; minQuantity: number; validFrom: string; validTo: string }>,
  tags: [] as string[],
})

const rules = { required: (v: string) => !!v || t('validation.required') }
const margin = computed(() => form.purchasePrice > 0 ? (((form.sellingPrice - form.purchasePrice) / form.purchasePrice) * 100).toFixed(1) : '0.0')

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function addCustomPrice() {
  form.customPrices.push({ name: '', contactId: '', price: 0, minQuantity: 1, validFrom: '', validTo: '' })
}

function addTagPrice() {
  form.tagPrices.push({ name: '', tag: '', price: 0, minQuantity: 1, validFrom: '', validTo: '' })
}

const contactTags = ref<string[]>([])
const loadingContactTags = ref(false)

async function fetchContactTags() {
  loadingContactTags.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/tags`, { params: { type: 'contact' } })
    contactTags.value = (data.tags || []).map((t: any) => t.value || t)
  } catch { /* */ } finally {
    loadingContactTags.value = false
  }
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
    if (isEdit.value) await httpClient.put(`${orgUrl()}/warehouse/product/${route.params.id}`, form)
    else await httpClient.post(`${orgUrl()}/warehouse/product`, form)
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'warehouse.products' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

onMounted(async () => {
  await Promise.all([fetchContacts(), fetchContactTags()])
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
        customPrices: (p.customPrices || []).map((cp: any) => ({
          name: cp.name || '',
          contactId: cp.contactId ? String(cp.contactId) : '',
          price: cp.price || 0,
          minQuantity: cp.minQuantity || 1,
          validFrom: cp.validFrom?.split('T')[0] || '',
          validTo: cp.validTo?.split('T')[0] || '',
        })),
        tagPrices: (p.tagPrices || []).map((tp: any) => ({
          name: tp.name || '',
          tag: tp.tag || '',
          price: tp.price || 0,
          minQuantity: tp.minQuantity || 1,
          validFrom: tp.validFrom?.split('T')[0] || '',
          validTo: tp.validTo?.split('T')[0] || '',
        })),
      })
    } catch { /* handle */ }
  }
})
</script>
