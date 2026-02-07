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

          <v-tabs-window v-model="tab" class="mt-4">
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
                  <v-select v-model="form.type" :label="$t('common.type')" :items="['goods', 'service']" :rules="[rules.required]" />
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
            </v-tabs-window-item>

            <!-- Pricing -->
            <v-tabs-window-item value="pricing">
              <v-row>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.cost" :label="$t('warehouse.purchasePrice')" type="number" step="0.01" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.price" :label="$t('warehouse.sellingPrice')" type="number" step="0.01" />
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
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.reorderLevel" :label="$t('warehouse.reorderLevel')" type="number" min="0" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.reorderQuantity" :label="$t('warehouse.reorderQuantity')" type="number" min="0" />
                </v-col>
                <v-col cols="12" md="4">
                  <v-text-field v-model.number="form.maxStock" :label="$t('warehouse.maxStock')" type="number" min="0" />
                </v-col>
              </v-row>
            </v-tabs-window-item>

            <!-- Custom Prices -->
            <v-tabs-window-item value="customPrices">
              <div v-for="(cp, i) in form.customPrices" :key="i" class="mb-4 pa-4 border rounded">
                <div class="d-flex align-center mb-2">
                  <span class="text-subtitle-2">{{ $t('warehouse.customPrice') }} {{ i + 1 }}</span>
                  <v-spacer />
                  <v-btn icon="mdi-delete" variant="text" size="small" color="error" @click="form.customPrices.splice(i, 1)" />
                </div>
                <v-row>
                  <v-col cols="4">
                    <v-text-field v-model="cp.label" :label="$t('common.name')" density="compact" />
                  </v-col>
                  <v-col cols="4">
                    <v-text-field v-model.number="cp.price" :label="$t('warehouse.price')" type="number" step="0.01" density="compact" />
                  </v-col>
                  <v-col cols="4">
                    <v-text-field v-model.number="cp.minQuantity" :label="$t('warehouse.minQuantity')" type="number" density="compact" />
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
import { httpClient } from '../../composables/useHttpClient'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

const formRef = ref()
const loading = ref(false)
const tab = ref('basic')
const isEdit = computed(() => !!route.params.id)

const form = reactive({
  sku: '', name: '', type: 'goods' as string, category: '', unit: 'pcs', barcode: '',
  description: '', isActive: true,
  cost: 0, price: 0, taxRate: 0,
  trackInventory: true, reorderLevel: 0, reorderQuantity: 0, maxStock: 0,
  customPrices: [] as Array<{ label: string; price: number; minQuantity: number }>,
})

const rules = { required: (v: string) => !!v || t('validation.required') }
const margin = computed(() => form.cost > 0 ? (((form.price - form.cost) / form.cost) * 100).toFixed(1) : '0.0')

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function addCustomPrice() {
  form.customPrices.push({ label: '', price: 0, minQuantity: 1 })
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    if (isEdit.value) await httpClient.put(`${orgUrl()}/products/${route.params.id}`, form)
    else await httpClient.post(`${orgUrl()}/products`, form)
    router.push({ name: 'warehouse.products' })
  } finally { loading.value = false }
}

onMounted(async () => {
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/products/${route.params.id}`)
      const p = data.product
      Object.assign(form, {
        sku: p.sku || '', name: p.name || '', type: p.type || 'goods', category: p.category || '',
        unit: p.unit || 'pcs', barcode: p.barcode || '', description: p.description || '',
        isActive: p.isActive ?? true, cost: p.cost || 0, price: p.price || 0, taxRate: p.taxRate || 0,
        trackInventory: p.trackInventory ?? true, reorderLevel: p.reorderLevel || 0,
        reorderQuantity: p.reorderQuantity || 0, maxStock: p.maxStock || 0,
        customPrices: p.customPrices || [],
      })
    } catch { /* handle */ }
  }
})
</script>
