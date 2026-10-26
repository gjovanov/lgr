<template>
  <!-- FR-22.30: a new article without leaving the document. Compact on purpose: the name came from
       the line's search, everything else starts at what the org would choose. -->
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="close">
    <v-card data-testid="quick-product-dialog">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon color="primary">mdi-package-variant-plus</v-icon>
        {{ $t('warehouse.newProduct') }}
      </v-card-title>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="create">
          <v-defaults-provider :defaults="{
            VTextField: { density: 'compact', variant: 'outlined' },
            VAutocomplete: { density: 'compact', variant: 'outlined' },
          }">
            <v-text-field
              v-model="form.name"
              :label="`${$t('common.name')} *`"
              :rules="[required]"
              :autofocus="!initialName"
              data-testid="quick-product-name"
            />
            <v-row dense>
              <v-col cols="6">
                <v-autocomplete v-model="form.unit" :label="$t('warehouse.unit')" :items="uomOptions" item-title="title" item-value="value" />
              </v-col>
              <v-col cols="6">
                <TaxRateCombobox
                  v-model="form.taxRate"
                  :org-url="orgUrl"
                  :default-rate="defaultVatRate"
                  :label="$t('invoicing.taxRate')"
                />
              </v-col>
            </v-row>
            <v-autocomplete
              v-model="form.categoryId"
              :label="$t('warehouse.category')"
              :items="categoryItems"
              item-title="name"
              item-value="_id"
              :hint="form.categoryId ? '' : (defaultCategoryExists ? '' : $t('warehouse.quickProduct.defaultCategoryNew', { name: DEFAULT_CATEGORY }))"
              persistent-hint
              class="mt-2"
            />
            <v-row dense class="mt-2">
              <v-col cols="6">
                <v-text-field
                  ref="purchaseRef"
                  v-model.number="form.purchasePrice"
                  type="number"
                  min="0"
                  step="0.0001"
                  :label="$t('warehouse.purchasePrice')"
                  data-testid="quick-product-purchase"
                />
              </v-col>
              <v-col cols="6">
                <v-text-field
                  v-model.number="form.sellingPrice"
                  type="number"
                  min="0"
                  step="0.0001"
                  :label="$t('warehouse.sellingPrice')"
                  data-testid="quick-product-selling"
                />
              </v-col>
            </v-row>
            <div class="text-caption text-medium-emphasis">{{ $t('warehouse.quickProduct.skuHint') }}</div>
          </v-defaults-provider>
        </v-form>
        <!-- The catalog has it already: take that one rather than fork it. -->
        <v-alert v-if="existing" type="warning" variant="tonal" density="compact" class="mt-3" data-testid="quick-product-exists">
          {{ $t('warehouse.quickProduct.exists', { sku: existing.sku || '', name: existing.name || '' }) }}
          <template #append>
            <v-btn size="small" variant="flat" color="warning" @click="useExisting">{{ $t('warehouse.quickProduct.useExisting') }}</v-btn>
          </template>
        </v-alert>
        <v-alert v-else-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="close(false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" data-testid="quick-product-create" @click="create">{{ $t('common.create') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../composables/useHttpClient'
import { useProductUnits } from '../composables/useProductUnits'
import TaxRateCombobox from './TaxRateCombobox.vue'

/** Where a new article lands until it is recategorised — the server's default (quick-product.service). */
const DEFAULT_CATEGORY = 'Общи'

const props = defineProps<{
  modelValue: boolean
  orgUrl: string
  /** What the user typed in the line's article search. */
  initialName?: string
  /** A starting purchase price (the line's unit cost, when it has one). */
  initialPurchasePrice?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** The article the line should take: the one created, or the catalog's own when it had it. */
  created: [product: any]
}>()

const { t } = useI18n()
const { uomOptions } = useProductUnits()

const formRef = ref<any>()
const purchaseRef = ref<any>()
const saving = ref(false)
const error = ref('')
const existing = ref<any | null>(null)
const categories = ref<Array<{ _id: string; name: string }>>([])
const defaultVatRate = ref<number | null>(null)

const form = reactive({
  name: '',
  unit: 'pcs',
  taxRate: null as number | null,
  categoryId: '' as string,
  purchasePrice: null as number | null,
  sellingPrice: null as number | null,
})

const required = (v: string) => !!String(v || '').trim() || t('validation.required')

const defaultCategoryExists = computed(() => categories.value.some(c => c.name.toLocaleLowerCase('bg') === DEFAULT_CATEGORY.toLocaleLowerCase('bg')))
/** „Общи" first — picked unless the user chooses another; listed even before it exists. */
const categoryItems = computed(() => {
  const own = categories.value.filter(c => c.name.toLocaleLowerCase('bg') !== DEFAULT_CATEGORY.toLocaleLowerCase('bg'))
  return [{ _id: '', name: DEFAULT_CATEGORY }, ...own]
})

let loaded = false
async function loadOnce() {
  if (loaded) return
  loaded = true
  const [cats, org] = await Promise.allSettled([
    httpClient.get(`${props.orgUrl}/warehouse/product-category`, { params: { size: 0 } }),
    httpClient.get(props.orgUrl),
  ])
  if (cats.status === 'fulfilled') categories.value = cats.value.data?.productCategories || []
  if (org.status === 'fulfilled') {
    const rate = (org.value.data?.org?.settings || org.value.data?.settings)?.taxConfig?.defaultVatRate
    if (typeof rate === 'number') defaultVatRate.value = rate
  }
  if (form.taxRate === null && defaultVatRate.value !== null) form.taxRate = defaultVatRate.value
}

watch(() => props.modelValue, async (open) => {
  if (!open) return
  error.value = ''
  existing.value = null
  form.name = String(props.initialName || '').trim()
  form.unit = 'pcs'
  form.categoryId = ''
  form.purchasePrice = props.initialPurchasePrice ? props.initialPurchasePrice : null
  form.sellingPrice = null
  form.taxRate = defaultVatRate.value
  await loadOnce()
  // The name is already there: the caret goes where the typing is.
  if (form.name) {
    await nextTick()
    purchaseRef.value?.focus?.()
  }
}, { immediate: true })

function close(open: boolean) {
  if (!open) emit('update:modelValue', false)
}

async function create() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  error.value = ''
  existing.value = null
  try {
    const body: Record<string, any> = { name: form.name.trim(), unit: form.unit || 'pcs' }
    if (form.categoryId) body.categoryId = form.categoryId
    if (form.taxRate !== null && form.taxRate !== undefined) body.taxRate = Number(form.taxRate)
    if (form.purchasePrice !== null && String(form.purchasePrice) !== '') body.purchasePrice = Number(form.purchasePrice) || 0
    if (form.sellingPrice !== null && String(form.sellingPrice) !== '') body.sellingPrice = Number(form.sellingPrice) || 0
    const { data } = await httpClient.post(`${props.orgUrl}/warehouse/product/quick`, body)
    emit('created', data.product)
    emit('update:modelValue', false)
  } catch (e: any) {
    const res = e?.response?.data
    if (res?.code === 'product_exists' && res.product) existing.value = res.product
    else error.value = res?.message || t('common.operationFailed')
  } finally {
    saving.value = false
  }
}

function useExisting() {
  if (!existing.value) return
  emit('created', existing.value)
  emit('update:modelValue', false)
}
</script>
