<template>
  <EntityFormShell
    :title="isEdit ? $t('common.edit') + ' ' + $t('nav.inventoryCount') : $t('common.create') + ' ' + $t('nav.inventoryCount')"
    :subtitle="isEdit ? (countNumber || '') : ''"
    :status="isEdit ? { steps: ['draft', 'in_progress', 'completed'], current: countStatus } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/inventory-counts"
    :back-label="$t('nav.inventoryCount')"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="4">
          <v-select v-model="form.warehouseId" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" :rules="[rules.required]" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" density="compact" />
        </v-col>
        <v-col cols="12" md="4">
          <v-select v-model="form.type" :label="$t('common.type')" :items="['full', 'partial', 'cycle']" density="compact" />
        </v-col>
      </v-row>

      <!-- Count Lines -->
      <div class="d-flex align-center mt-4 mb-2">
        <span class="text-subtitle-2">{{ $t('warehouse.countItems') }}</span>
        <v-spacer />
        <v-btn v-if="!isEdit" variant="outlined" size="small" prepend-icon="mdi-refresh" @click="loadProducts">
          {{ $t('warehouse.loadProducts') }}
        </v-btn>
      </div>
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ $t('warehouse.product') }}</th>
            <th class="text-end" style="width:120px">{{ $t('warehouse.systemQty') }}</th>
            <th class="text-end" style="width:120px">{{ $t('warehouse.countedQty') }}</th>
            <th class="text-end" style="width:120px">{{ $t('warehouse.variance') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(line, idx) in form.lines" :key="idx">
            <td>{{ line.productName || line.productId }}</td>
            <td class="text-end">{{ line.systemQuantity }}</td>
            <td>
              <v-text-field v-model.number="line.countedQuantity" type="number" min="0" density="compact" hide-details variant="underlined" />
            </td>
            <td class="text-end" :class="(line.countedQuantity - line.systemQuantity) !== 0 ? 'text-error font-weight-bold' : 'text-success'">
              {{ line.countedQuantity - line.systemQuantity }}
            </td>
          </tr>
        </tbody>
      </v-table>

      <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" density="compact" />
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>
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

interface Warehouse { _id: string; name: string }

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const isEdit = computed(() => !!route.params.id)
const loading = ref(false)
const saving = ref(false)
const formRef = ref()
const warehouses = ref<Warehouse[]>([])
const countNumber = ref('')
const countStatus = ref('draft')

const form = ref({
  warehouseId: '', date: new Date().toISOString().split('T')[0], type: 'full', notes: '',
  lines: [] as Array<{ productId: string; productName: string; systemQuantity: number; countedQuantity: number; avgCost: number }>,
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'inventory',
  entityType: 'inventoryCount',
  icon: 'mdi-clipboard-check',
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
  const actions: FormAction[] = [
    { label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value },
  ]
  if (isEdit.value && countStatus.value === 'in_progress') {
    actions.push({ label: t('warehouse.completeCount'), color: 'success', icon: 'mdi-check-all', handler: completeCount, loading: saving.value })
  }
  return actions
})

async function fetchItem() {
  if (!isEdit.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/inventory-count/${route.params.id}`)
    const detail = data.inventoryCount || data.item || data
    countNumber.value = detail.number || ''
    countStatus.value = detail.status || 'draft'
    form.value = {
      warehouseId: detail.warehouseId || '', date: detail.date?.split('T')[0] || '', type: detail.type || 'full',
      notes: detail.notes || '',
      lines: (detail.lines || []).map((l: any) => ({
        productId: l.productId,
        productName: l.productName || '',
        systemQuantity: l.systemQuantity ?? 0,
        countedQuantity: l.countedQuantity ?? 0,
        avgCost: l.avgCost || 0,
      })),
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function loadProducts() {
  if (!form.value.warehouseId) return
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level`, { params: { warehouseId: form.value.warehouseId } })
    form.value.lines = (data.stockLevels || []).map((s: any) => ({
      productId: s.productId,
      productName: s.productName || s.productSku,
      systemQuantity: s.quantity || 0,
      countedQuantity: s.quantity || 0,
      avgCost: s.avgCost || 0,
    }))
  } catch { /* */ }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    const payload = {
      ...form.value,
      itemCount: form.value.lines.length,
      varianceCount: form.value.lines.filter(l => l.countedQuantity !== l.systemQuantity).length,
      lines: form.value.lines.map(l => ({
        productId: l.productId,
        systemQuantity: l.systemQuantity,
        countedQuantity: l.countedQuantity,
        variance: l.countedQuantity - l.systemQuantity,
        varianceCost: (l.countedQuantity - l.systemQuantity) * (l.avgCost || 0),
      })),
    }
    if (isEdit.value) {
      await httpClient.put(`${appStore.orgUrl()}/warehouse/inventory-count/${route.params.id}`, payload)
    } else {
      const { data } = await httpClient.post(`${appStore.orgUrl()}/warehouse/inventory-count`, payload)
      const newId = data.inventoryCount?._id || data._id
      if (newId) {
        markSaved()
        showSuccess(t('common.savedSuccessfully'))
        router.replace({ name: 'inventory.inventory-counts.edit', params: { id: newId } })
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

async function completeCount() {
  saving.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/warehouse/inventory-count/${route.params.id}/complete`)
    countStatus.value = 'completed'
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } }); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(async () => {
  await fetchWarehouses()
  if (tryRestore()) return
  fetchItem()
})
</script>
