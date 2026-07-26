<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('nav.priceLists') : $t('common.create') + ' ' + $t('nav.priceLists')"
    :subtitle="isEdit ? form.name : ''"
    :actions="formActions"
    :loading="loading"
    back-to="/price-lists"
    :back-label="$t('nav.priceLists')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.name" :label="$t('common.name')" :rules="[rules.required]" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-select v-model="form.currency" :label="$t('common.currency')" :items="['EUR','USD','GBP','CHF','MKD','BGN','RSD']" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-switch v-model="form.isActive" :label="$t('common.active')" color="primary" density="compact" />
        </v-col>
      </v-row>
      <v-row>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.validFrom" :label="$t('warehouse.validFrom')" type="date" density="compact" />
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field v-model="form.validTo" :label="$t('warehouse.validTo')" type="date" density="compact" />
        </v-col>
      </v-row>

      <!-- Price Items -->
      <div class="d-flex align-center mt-4 mb-2">
        <span class="text-subtitle-2">{{ $t('warehouse.priceItems') }}</span>
        <v-spacer />
        <v-btn variant="outlined" size="small" prepend-icon="mdi-plus" @click="addItem">{{ $t('warehouse.addItem') }}</v-btn>
      </div>
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ $t('warehouse.product') }}</th>
            <th class="text-end" style="width:120px">{{ $t('warehouse.price') }}</th>
            <th class="text-end" style="width:120px">{{ $t('warehouse.minQuantity') }}</th>
            <th class="text-end" style="width:100px">{{ $t('invoicing.discount') }}</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, idx) in form.items" :key="idx">
            <td style="min-width:280px">
              <div class="d-flex align-center ga-1">
                <ProductSearch
                  :org-url="appStore.orgUrl()"
                  :initial-product="item.productId ? { _id: item.productId, name: productNames[item.productId] || '' } : null"
                  class="flex-grow-1"
                  @product-selected="onItemProduct(idx, $event)"
                  @product-cleared="item.productId = ''"
                />
                <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" tabindex="-1" :title="$t('invoicing.browseProducts')" @click="openPicker(idx)" />
              </div>
            </td>
            <td><v-text-field v-model.number="item.price" type="number" step="0.01" density="compact" hide-details variant="underlined" /></td>
            <td><v-text-field v-model.number="item.minQuantity" type="number" density="compact" hide-details variant="underlined" /></td>
            <td><v-text-field v-model.number="item.discount" type="number" suffix="%" density="compact" hide-details variant="underlined" /></td>
            <td><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.items.splice(idx, 1)" /></td>
          </tr>
        </tbody>
      </v-table>
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>

    <ProductPickerDialog v-model="pickerOpen" :org-url="appStore.orgUrl()" @select="onPickerSelect" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import ProductSearch from 'ui-shared/components/ProductSearch'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const productNames = ref<Record<string, string>>({})
const pickerOpen = ref(false)
const pickerIdx = ref(-1)

function onItemProduct(idx: number, p: any) {
  form.value.items[idx].productId = p._id
  productNames.value[p._id] = p.name
  if (!form.value.items[idx].price) form.value.items[idx].price = p.sellingPrice || 0
}
function openPicker(idx: number) { pickerIdx.value = idx; pickerOpen.value = true }
function onPickerSelect(p: any) {
  if (pickerIdx.value < 0) return
  onItemProduct(pickerIdx.value, p)
}

const emptyItem = () => ({ productId: '', price: 0, minQuantity: 1, discount: 0 })
const form = ref({
  name: '', currency: 'EUR', validFrom: '', validTo: '', isActive: true,
  items: [emptyItem()] as any[],
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'inventory',
  entityType: 'priceList',
  icon: 'mdi-tag-multiple',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [{ label: 'Name', value: form.value.name }],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

const formActions = computed<FormAction[]>(() => [
  { label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value },
])

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/price-list/${route.params.id}`)
    const item = data.priceList || data
    form.value = {
      name: item.name, currency: item.currency, validFrom: item.validFrom?.split('T')[0] || '',
      validTo: item.validTo?.split('T')[0] || '', isActive: item.isActive,
      items: item.items || [emptyItem()],
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

function addItem() { form.value.items.push(emptyItem()) }

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    if (isEdit.value) {
      await httpClient.put(`${appStore.orgUrl()}/warehouse/price-list/${route.params.id}`, form.value)
    } else {
      const { data } = await httpClient.post(`${appStore.orgUrl()}/warehouse/price-list`, form.value)
      const newId = data.priceList?._id || data._id
      if (newId) {
        markSaved()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'inventory.price-lists.edit', params: { id: newId } })
        return
      }
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function fetchItemProductNames() {
  // Resolve names for products already referenced (edit mode) so ProductSearch shows a
  // chip. Fetched by id (the list endpoint has no bulk-id filter); counts are small.
  const ids = [...new Set(form.value.items.map((i: any) => i.productId).filter(Boolean))] as string[]
  await Promise.all(ids.map(async (id) => {
    if (productNames.value[id]) return
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product/${id}`)
      const p = data.product || data
      if (p?.name) productNames.value[id] = p.name
    } catch { /* stays blank until re-picked */ }
  }))
}

onMounted(async () => {
  if (tryRestore()) { await fetchItemProductNames(); return }
  await fetchItem()
  await fetchItemProductNames()
})
</script>
