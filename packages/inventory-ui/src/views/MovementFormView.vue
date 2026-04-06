<template>
  <EntityFormShell
    :title="isEdit ? $t('warehouse.viewMovement') : $t('common.create') + ' ' + $t('nav.stockMovements')"
    :subtitle="isEdit ? (movement.number || '') : ''"
    :status="isEdit ? { steps: ['draft', 'confirmed', 'completed'], current: movement.status } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/movements"
    :back-label="$t('nav.stockMovements')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="3">
          <v-select v-model="form.type" :label="$t('common.type')" :items="['receipt', 'shipment', 'transfer', 'adjustment']" :rules="[rules.required]" :disabled="isEdit" density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <v-select v-model="form.fromWarehouseId" :label="$t('warehouse.fromWarehouse')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="isEdit" density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <v-select v-model="form.toWarehouseId" :label="$t('warehouse.toWarehouse')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="isEdit" density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" :disabled="isEdit" density="compact" />
        </v-col>
      </v-row>
      <v-autocomplete v-model="form.contactId" :label="$t('invoicing.contact')" :items="contacts" item-title="name" item-value="_id" clearable :disabled="isEdit" density="compact" />

      <div class="d-flex align-center mt-4 mb-2">
        <span class="text-subtitle-2">{{ $t('invoicing.lineItems') }}</span>
        <v-spacer />
        <v-btn v-if="!isEdit" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">{{ $t('invoicing.addLine') }}</v-btn>
      </div>
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ $t('warehouse.product') }}</th>
            <th style="width:100px">{{ $t('warehouse.stock') }}</th>
            <th class="text-end" style="width:100px">{{ $t('warehouse.quantity') }}</th>
            <th class="text-end" style="width:120px">{{ $t('warehouse.unitCost') }}</th>
            <th class="text-end" style="width:120px">{{ $t('common.total') }}</th>
            <th v-if="!isEdit" style="width:40px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(line, idx) in form.lines" :key="idx">
            <td style="min-width:200px">
              <ProductSearch
                v-if="!isEdit"
                :org-url="appStore.orgUrl()"
                :initial-product="line.productId ? { _id: line.productId, name: line.productName || '' } : null"
                @product-selected="onLineProductSelected(idx, $event)"
                @product-cleared="onLineProductCleared(idx)"
              />
              <span v-else>{{ line.productName || line.productId }}</span>
            </td>
            <td>
              <v-chip v-if="line.stockQty != null" size="small" label color="info" variant="tonal">{{ line.stockQty }}</v-chip>
              <span v-else class="text-grey">&mdash;</span>
            </td>
            <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" :disabled="isEdit" /></td>
            <td><v-text-field v-model.number="line.unitCost" type="number" step="0.01" density="compact" hide-details variant="underlined" :disabled="isEdit" /></td>
            <td class="text-end">{{ fmtCurrency(line.quantity * (line.unitCost || 0)) }}</td>
            <td v-if="!isEdit"><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td :colspan="isEdit ? 4 : 4" class="text-end text-subtitle-2">{{ $t('common.total') }}</td>
            <td class="text-end text-subtitle-2">{{ fmtCurrency(computedTotal) }}</td>
            <td v-if="!isEdit"></td>
          </tr>
        </tfoot>
      </v-table>

      <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" :disabled="isEdit" density="compact" />
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>
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
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell'
import ProductSearch from 'ui-shared/components/ProductSearch.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

interface Warehouse { _id: string; name: string }
interface Contact { _id: string; name: string }

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const warehouses = ref<Warehouse[]>([])
const contacts = ref<Contact[]>([])
const movement = ref<{ number?: string; status: string }>({ status: 'draft' })

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))
function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

const emptyLine = () => ({ productId: '', productName: '', quantity: 0, unitCost: 0, stockQty: null as number | null })
const form = ref({
  type: 'receipt', fromWarehouseId: '', toWarehouseId: '', contactId: '' as string | undefined,
  date: new Date().toISOString().split('T')[0], notes: '',
  lines: [emptyLine()] as any[],
})

const computedTotal = computed(() => form.value.lines.reduce((s: number, l: any) => s + l.quantity * (l.unitCost || 0), 0))

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'inventory',
  entityType: 'stockMovement',
  icon: 'mdi-swap-horizontal',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Type', value: form.value.type },
    { label: 'Date', value: form.value.date },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

const formActions = computed<FormAction[]>(() => {
  const actions: FormAction[] = []
  if (!isEdit.value) {
    actions.push({ label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value })
  }
  if (isEdit.value && movement.value.status === 'draft') {
    actions.push({ label: t('warehouse.confirm'), color: 'success', icon: 'mdi-check', handler: confirmMovement, loading: saving.value })
  }
  return actions
})

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/movement/${route.params.id}`)
    const detail = data.stockMovement || data
    movement.value = { number: detail.number, status: detail.status || 'draft' }
    form.value = {
      type: detail.type, fromWarehouseId: detail.fromWarehouseId || '', toWarehouseId: detail.toWarehouseId || '',
      contactId: detail.contactId || undefined, date: detail.date?.split('T')[0] || '', notes: detail.notes || '',
      lines: (detail.lines || []).map((l: any) => ({ productId: l.productId, productName: l.productName || '', quantity: l.quantity, unitCost: l.unitCost, stockQty: null })),
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    const payload = {
      type: form.value.type,
      date: form.value.date,
      fromWarehouseId: form.value.fromWarehouseId || undefined,
      toWarehouseId: form.value.toWarehouseId || undefined,
      contactId: form.value.contactId || undefined,
      notes: form.value.notes || undefined,
      totalAmount: computedTotal.value,
      lines: form.value.lines.map(l => ({
        productId: l.productId,
        quantity: l.quantity,
        unitCost: l.unitCost || 0,
        totalCost: l.quantity * (l.unitCost || 0),
      })),
    }
    const { data } = await httpClient.post(`${appStore.orgUrl()}/warehouse/movement`, payload)
    const newId = data.stockMovement?._id || data._id
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    if (newId) {
      router.replace({ name: 'inventory.movements.view', params: { id: newId } })
    } else {
      router.push('/movements')
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function confirmMovement() {
  saving.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/warehouse/movement/${route.params.id}/confirm`)
    movement.value.status = 'confirmed'
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

function addLine() { form.value.lines.push(emptyLine()) }

async function fetchLineStock(idx: number) {
  const line = form.value.lines[idx]
  if (!line?.productId || !form.value.fromWarehouseId) {
    if (line) line.stockQty = null
    return
  }
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level`, {
      params: { productId: line.productId, warehouseId: form.value.fromWarehouseId, size: 1 },
    })
    const sl = data.stockLevels?.[0]
    if (sl) {
      line.stockQty = sl.availableQuantity ?? sl.quantity ?? 0
      line.quantity = line.stockQty
      line.unitCost = sl.avgCost || line.unitCost
    } else {
      line.stockQty = 0
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
  await fetchLineStock(idx)
}

function onLineProductCleared(idx: number) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = ''
  line.productName = ''
  line.stockQty = null
}

watch(() => form.value.fromWarehouseId, () => {
  form.value.lines.forEach((_line: any, idx: number) => {
    if (_line.productId) fetchLineStock(idx)
  })
})

function contactDisplayName(c: any): string {
  if (c.companyName) return c.companyName
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

async function fetchContacts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`)
    contacts.value = (data.contacts || []).map((c: any) => ({ ...c, name: contactDisplayName(c) }))
  } catch { /* */ }
}

onMounted(async () => {
  await Promise.all([fetchWarehouses(), fetchContacts()])
  if (tryRestore()) return
  fetchItem()
})
</script>
