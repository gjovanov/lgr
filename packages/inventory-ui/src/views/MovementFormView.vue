<template>
  <EntityFormShell
    :title="isEdit ? $t('warehouse.viewMovement') : $t('common.create') + ' ' + $t('warehouse.movementDoc')"
    :subtitle="isEdit ? (movement.number || '') : ''"
    :status="isEdit ? { steps: ['draft', 'confirmed', 'completed'], current: movement.status } : undefined"
    :actions="formActions"
    :loading="loading"
    back-to="/movements"
    :back-label="$t('nav.stockMovements')"
  >
    <!-- FR-04 (#11): the linked inventory count, when this adjustment has one. -->
    <v-alert v-if="movement.inventoryCountId" type="info" variant="tonal" density="compact" class="mb-3">
      {{ $t('nav.inventoryCount') }}:
      <router-link :to="{ name: 'inventory.inventory-counts.edit', params: { id: movement.inventoryCountId } }">
        {{ $t('common.view') }}
      </router-link>
    </v-alert>

    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <v-row>
        <v-col cols="12" md="3">
          <v-select v-model="form.type" :label="$t('common.type')" :items="['receipt', 'dispatch', 'transfer', 'adjustment']" :rules="[rules.required]" :disabled="isEdit" density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <v-select v-model="form.fromWarehouseId" :label="$t('warehouse.fromWarehouse')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="readonly" density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <v-select v-model="form.toWarehouseId" :label="$t('warehouse.toWarehouse')" :items="warehouses" item-title="name" item-value="_id" clearable :disabled="readonly" density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <DateField v-model="form.date" :label="$t('common.date')" :rules="[rules.required]" :disabled="readonly" density="compact" />
        </v-col>
      </v-row>
      <v-autocomplete v-model="form.contactId" :label="$t('invoicing.contact')" :items="contacts" item-title="name" item-value="_id" clearable :disabled="readonly" density="compact" />

      <div class="d-flex align-center mt-4 mb-2">
        <span class="text-subtitle-2">{{ $t('invoicing.lineItems') }}</span>
        <v-chip v-if="form.type === 'receipt' && !readonly" class="ml-3" size="small" :color="grWithUpdate ? 'primary' : undefined" :variant="grWithUpdate ? 'flat' : 'outlined'">
          <v-switch v-model="grWithUpdate" density="compact" hide-details class="mr-2" color="white" style="width: 36px" />
          {{ $t(grWithUpdate ? 'warehouse.withProductUpdate' : 'warehouse.withoutProductUpdate') }}
        </v-chip>
        <v-btn v-if="grWithUpdate && !readonly" class="ml-2" size="small" variant="outlined" prepend-icon="mdi-view-column-outline" @click="columnPickerOpen = true">
          {{ $t('warehouse.grPicker.button', { n: activeColumns.length }) }}
        </v-btn>
        <v-spacer />
        <v-btn v-if="!readonly" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">{{ $t('invoicing.addLine') }}</v-btn>
      </div>
      <div class="overflow-x-auto">
        <v-table density="compact">
          <thead>
            <tr>
              <th style="width:50%;min-width:50vw">{{ $t('warehouse.product') }}</th>
              <th style="width:90px;min-width:80px">{{ $t('warehouse.stock') }}</th>
              <th class="text-end" style="width:100px;min-width:90px">{{ $t('warehouse.quantity') }}</th>
              <th class="text-end" style="width:120px;min-width:110px">{{ $t('warehouse.unitCost') }}</th>
              <th class="text-end" style="width:120px;min-width:110px">{{ $t('common.total') }}</th>
              <th v-for="col in (grWithUpdate ? activeColumns : [])" :key="col.key" :class="col.align === 'end' ? 'text-end' : ''" style="min-width: 110px">
                {{ $t(col.i18n) }}
              </th>
              <th v-if="!readonly" style="width:40px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(line, idx) in form.lines" :key="idx">
              <td>
                <div v-if="!readonly" class="d-flex align-center ga-1">
                  <ProductSearch
                    :org-url="appStore.orgUrl()"
                    :initial-product="line.productId ? { _id: line.productId, name: line.productName || '' } : null"
                    class="flex-grow-1"
                    @product-selected="onLineProductSelected(idx, $event)"
                    @product-cleared="onLineProductCleared(idx)"
                  />
                  <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" :title="$t('invoicing.browseProducts')" @click="openProductPicker(idx)" />
                </div>
                <span v-else>{{ line.productName || line.productId }}</span>
              </td>
              <td>
                <v-chip v-if="line.stockQty != null" size="small" label color="info" variant="tonal">{{ line.stockQty }}</v-chip>
                <span v-else class="text-grey">&mdash;</span>
              </td>
              <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" :disabled="readonly" /></td>
              <td>
                <v-text-field
                  v-model.number="line.unitCost"
                  type="number"
                  step="0.0001"
                  density="compact"
                  hide-details
                  variant="underlined"
                  :disabled="readonly"
                  @update:model-value="onUnitCostChange(idx)"
                />
              </td>
              <td class="text-end">{{ fmtCurrency(line.quantity * (line.unitCost || 0)) }}</td>

              <!-- Extra product-update columns (only when grWithUpdate is ON) -->
              <td v-for="col in (grWithUpdate ? activeColumns : [])" :key="col.key" :class="col.align === 'end' ? 'text-end' : ''">
                <v-select
                  v-if="col.key === 'type'"
                  :model-value="productUpdateFor(line).type"
                  :items="['goods', 'service', 'raw_material', 'finished_product']"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setUpdate(line, 'type', $event)"
                />
                <v-autocomplete
                  v-else-if="col.key === 'categoryId'"
                  :model-value="productUpdateFor(line).categoryId"
                  :items="categories"
                  item-title="name"
                  item-value="_id"
                  density="compact"
                  hide-details
                  variant="underlined"
                  clearable
                  @update:model-value="setUpdate(line, 'categoryId', $event)"
                />
                <v-autocomplete
                  v-else-if="col.key === 'unit'"
                  :model-value="productUpdateFor(line).unit"
                  :items="uomOptions"
                  item-title="title"
                  item-value="value"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setUpdate(line, 'unit', $event)"
                />
                <v-text-field
                  v-else-if="col.tierIndex != null"
                  :model-value="tierFinalPrice(line, col.tierIndex)"
                  type="number"
                  step="0.0001"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setTierFinalPrice(line, col.tierIndex!, $event)"
                />
                <v-text-field
                  v-else
                  :model-value="productUpdateFor(line)[col.productField!]"
                  :type="col.inputType === 'number' ? 'number' : 'text'"
                  step="0.0001"
                  density="compact"
                  hide-details
                  variant="underlined"
                  @update:model-value="setUpdate(line, col.productField!, $event)"
                />
              </td>

              <td v-if="!readonly"><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td :colspan="4" class="text-end text-subtitle-2">{{ $t('common.total') }}</td>
              <td class="text-end text-subtitle-2">{{ fmtCurrency(computedTotal) }}</td>
              <td v-if="grWithUpdate" :colspan="activeColumns.length"></td>
              <td v-if="!readonly"></td>
            </tr>
          </tfoot>
        </v-table>
      </div>

      <GRColumnPicker v-model="columnPickerOpen" />

      <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" :disabled="readonly" density="compact" />
    </v-form>

    <template #sidebar>
      <div class="text-caption text-medium-emphasis pa-2">{{ $t('common.noData') }}</div>
    </template>

    <ProductPickerDialog v-model="productPickerOpen" :org-url="appStore.orgUrl()" :base-currency="baseCurrency" :locale="localeCode" @select="onProductPicked" />

    <!-- Single-document import: OCR one разписка and merge it into THIS movement.
         Nothing is booked — the user still has to save and confirm. -->
    <DocImportDialog
      v-model="importDialogOpen"
      :org-url="appStore.orgUrl()"
      target="movement"
      mode="single"
      :current-form="importCurrentForm"
      @apply="applyImportedMovement"
    />
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
import DateField from 'ui-shared/components/DateField.vue'
import ProductSearch from 'ui-shared/components/ProductSearch.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'
import GRColumnPicker from '../components/GRColumnPicker.vue'
import { useGRColumns } from '../composables/useGRColumns'

/**
 * Price-tier slots a product can hold: Доставна цена, Цена на едро, and Цена 0..Цена 10.
 * Must match the Product model's validator — truncating lower silently dropped the highest
 * tiers whenever a goods receipt wrote prices.
 */
const MAX_PRICE_TIERS = 13

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
// Draft movements stay editable; confirmed/completed are read-only (stock already applied).
const readonly = computed(() => isEdit.value && movement.value.status !== 'draft')

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))
function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

const emptyLine = () => ({
  productId: '', productName: '', quantity: 0, unitCost: 0, stockQty: null as number | null,
  // GR-with-update extras (only populated when grWithUpdate is ON)
  productUpdate: {} as Record<string, any>,
  // Snapshot of the product's existing priceTiers (10 entries) so we can edit finalPrice slot-by-slot.
  priceTiers: [] as Array<{ name: string; percent: number; finalPrice: number; manualOverride: boolean; contactIds?: string[]; tags?: string[] }>,
})
const form = ref({
  type: 'receipt', fromWarehouseId: '', toWarehouseId: '', contactId: '' as string | undefined,
  date: new Date().toISOString().split('T')[0], notes: '',
  lines: [emptyLine()] as any[],
})

// ── GR-with-update state ──
const grWithUpdate = ref(false)
const columnPickerOpen = ref(false)
const { activeColumns } = useGRColumns()
const categories = ref<Array<{ _id: string; name: string }>>([])
const uomCodes = ['pcs', 'pair', 'set', 'box', 'pack', 'dozen', 'g', 'kg', 'ton', 'lb', 'oz', 'ml', 'L', 'm3', 'gal', 'mm', 'cm', 'm', 'km', 'in', 'ft', 'm2', 'ha', 'hr', 'day', 'month']
const uomOptions = computed(() => uomCodes.map(code => ({ title: `${t(`warehouse.uom.${code}`, code)} (${code})`, value: code })))

// Auto-disable the toggle when type changes away from receipt.
watch(() => form.value.type, (t) => { if (t !== 'receipt') grWithUpdate.value = false })

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
  if (!readonly.value) {
    actions.push({ label: t('common.save'), color: 'primary', icon: 'mdi-content-save', handler: handleSubmit, loading: saving.value })
    // Importing onto a confirmed movement would be pointless — its stock is already applied.
    actions.push({
      label: t('docImport.importFile'),
      color: 'secondary',
      variant: 'outlined',
      icon: 'mdi-file-upload-outline',
      handler: () => { importDialogOpen.value = true },
    })
  }
  if (isEdit.value && movement.value.status === 'draft') {
    actions.push({ label: t('warehouse.confirm'), color: 'success', icon: 'mdi-check', handler: confirmMovement, loading: saving.value })
  }
  return actions
})

// ── single-document import ──
const importDialogOpen = ref(false)

/** The current form values, so the import dialog can show a field diff. */
const importCurrentForm = computed(() => ({ ...form.value }))

/**
 * Merge an imported разписка into THIS open movement. Fields and lines are assigned
 * directly: routing through `onLineProductSelected` would call `fetchLineStock`, which
 * overwrites the quantity with whatever is currently on hand — the opposite of what a
 * delivery note says.
 */
function applyImportedMovement(payload: { fields: Record<string, any>; lines: any[]; lineMode: 'replace' | 'append' | 'keep' }) {
  for (const [k, v] of Object.entries(payload.fields || {})) {
    if (v === undefined || v === null || v === '') continue
    ;(form.value as any)[k] = v
  }

  if (payload.lineMode !== 'keep' && payload.lines?.length) {
    const mapped = payload.lines.map((l: any) => ({
      productId: l.productId || '',
      productName: l.productName || l.sourceText || '',
      quantity: Number(l.quantity) || 0,
      unitCost: Number(l.unitCost) || 0,
      stockQty: null as number | null,
      productUpdate: l.productUpdate || {},
      priceTiers: l.priceTiers || [],
    }))
    const kept = payload.lineMode === 'append'
      ? form.value.lines.filter((l: any) => l.productId || l.productName)
      : []
    form.value.lines = [...kept, ...mapped, emptyLine()]
    // Delivered prices only make sense with the product-update columns visible.
    if (form.value.type === 'receipt' && mapped.some(l => Object.keys(l.productUpdate).length || l.priceTiers.length)) {
      grWithUpdate.value = true
    }
  }
  showSuccess(t('docImport.applied'))
}

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
      lines: (detail.lines || []).map((l: any) => ({ productId: l.productId, productName: l.productName || '', quantity: l.quantity, unitCost: l.unitCost, stockQty: null, productUpdate: {}, priceTiers: [] })),
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

function buildProductUpdates(): Array<Record<string, any>> {
  const updates: Array<Record<string, any>> = []
  for (const line of form.value.lines) {
    if (!line.productId) continue
    const u: Record<string, any> = { productId: line.productId }
    let hasChanges = false
    for (const [k, v] of Object.entries(line.productUpdate || {})) {
      if (v !== undefined && v !== '') { u[k] = v; hasChanges = true }
    }
    // Only attach priceTiers if the user actually touched them (manualOverride set or any non-empty filter).
    if (Array.isArray(line.priceTiers) && line.priceTiers.length > 0) {
      const anyTouched = line.priceTiers.some(t => t.manualOverride || (t.finalPrice || 0) > 0)
      if (anyTouched) {
        u.priceTiers = line.priceTiers.slice(0, MAX_PRICE_TIERS).map(t => ({
          name: t.name,
          percent: Number(t.percent) || 0,
          finalPrice: Number(t.finalPrice) || 0,
          manualOverride: !!t.manualOverride,
          contactIds: t.contactIds || [],
          tags: t.tags || [],
        }))
        hasChanges = true
      }
    }
    if (hasChanges) updates.push(u)
  }
  return updates
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  saving.value = true
  try {
    const basePayload: Record<string, any> = {
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

    if (grWithUpdate.value && form.value.type === 'receipt') {
      basePayload.productUpdates = buildProductUpdates()
    }

    if (isEdit.value) {
      // Draft edit: type is immutable after create — PUT does not accept it.
      const { type: _type, ...updateBody } = basePayload
      await httpClient.put(`${appStore.orgUrl()}/warehouse/movement/${route.params.id}`, updateBody)
      markSaved()
      showSuccess(t('common.savedSuccessfully'))
      await fetchItem()
    } else {
      const endpoint = grWithUpdate.value && form.value.type === 'receipt'
        ? `${appStore.orgUrl()}/warehouse/movement/with-update`
        : `${appStore.orgUrl()}/warehouse/movement`
      const { data } = await httpClient.post(endpoint, basePayload)
      const newId = data.stockMovement?._id || data._id
      markSaved()
      showSuccess(t('common.savedSuccessfully'))
      if (newId) {
        router.replace({ name: 'inventory.movements.view', params: { id: newId } })
      } else {
        router.push('/movements')
      }
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
    // FR-04 (#11): confirming a manual adjustment auto-creates its completed inventory
    // count server-side (createCount is UI-only — imports/skills stay count-free).
    const { data } = await httpClient.post(
      `${appStore.orgUrl()}/warehouse/movement/${route.params.id}/confirm`,
      form.value.type === 'adjustment' ? { createCount: true } : {},
    )
    // confirmMovement leaves the document 'completed', not 'confirmed'.
    movement.value.status = data?.stockMovement?.status || 'completed'
    if (data?.stockMovement?.inventoryCountId) movement.value.inventoryCountId = data.stockMovement.inventoryCountId
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
  line.productUpdate = {}
  line.priceTiers = []
  await fetchLineStock(idx)

  // When grWithUpdate is ON, load the full product so we can show/edit its fields.
  if (grWithUpdate.value) await seedLineProductUpdate(idx)
}

/** Load the full product and stage its current fields + tiers on the line (padded to 10 slots). */
async function seedLineProductUpdate(idx: number) {
  const line = form.value.lines[idx]
  if (!line?.productId) return
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product/${line.productId}`)
    const p = data.product || data
    line.productUpdate = {
      type: p.type,
      categoryId: p.categoryId || undefined,
      unit: p.unit,
      purchasePrice: p.purchasePrice ?? 0,
      sellingPrice: p.sellingPrice ?? 0,
      taxRate: p.taxRate ?? 0,
    }
    // Normalise priceTiers: pad to the full slot count so every tier column has a row to bind to.
    const existing = (p.priceTiers || []).map((t: any) => ({
      name: t.name || '',
      percent: Number(t.percent) || 0,
      finalPrice: Number(t.finalPrice) || 0,
      manualOverride: !!t.manualOverride,
      contactIds: (t.contactIds || []).map((id: any) => String(id)),
      tags: t.tags || [],
    }))
    while (existing.length < MAX_PRICE_TIERS) {
      existing.push({ name: `Price ${existing.length + 1}`, percent: 0, finalPrice: Number(p.sellingPrice) || 0, manualOverride: false, contactIds: [], tags: [] })
    }
    line.priceTiers = existing.slice(0, MAX_PRICE_TIERS)
  } catch { /* keep defaults if fetch fails */ }
}

// Toggling ON seeds any line that already has a product but no staged update yet (edit mode).
watch(grWithUpdate, async (on) => {
  if (!on) return
  const idxs = form.value.lines
    .map((l: any, i: number) => ({ l, i }))
    .filter(({ l }: any) => l.productId && (!l.productUpdate || Object.keys(l.productUpdate).length === 0))
    .map(({ i }: any) => i)
  await Promise.all(idxs.map(seedLineProductUpdate))
})

function onLineProductCleared(idx: number) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = ''
  line.productName = ''
  line.stockQty = null
}

const productPickerOpen = ref(false)
const productPickerRowIdx = ref(-1)

function openProductPicker(idx: number) {
  productPickerRowIdx.value = idx
  productPickerOpen.value = true
}

async function onProductPicked(product: any) {
  const idx = productPickerRowIdx.value
  productPickerRowIdx.value = -1
  if (idx < 0) return
  await onLineProductSelected(idx, product)
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
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 1000 } }); warehouses.value = data.warehouses || [] } catch { /* */ }
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-category?size=0`)
    categories.value = data.productCategories || []
  } catch { /* */ }
}

// ── GR-with-update helpers ──

function productUpdateFor(line: any): Record<string, any> {
  if (!line.productUpdate) line.productUpdate = {}
  return line.productUpdate
}

function setUpdate(line: any, field: string, value: any) {
  if (!line.productUpdate) line.productUpdate = {}
  line.productUpdate[field] = value === '' ? undefined : value
}

function tierFinalPrice(line: any, i: number): number | undefined {
  return line.priceTiers?.[i]?.finalPrice
}

function setTierFinalPrice(line: any, i: number, val: any) {
  if (!Array.isArray(line.priceTiers)) line.priceTiers = []
  while (line.priceTiers.length <= i) {
    line.priceTiers.push({ name: `Price ${line.priceTiers.length + 1}`, percent: 0, finalPrice: 0, manualOverride: false, contactIds: [], tags: [] })
  }
  const n = Number(val)
  if (!Number.isFinite(n)) return
  line.priceTiers[i].finalPrice = n
  line.priceTiers[i].manualOverride = true // direct edit overrides the cascade
}

/** When unitCost (purchase price for this receipt) changes, recompute each tier's finalPrice
 * from its stored percent unless the user has manually overridden that tier. */
function onUnitCostChange(idx: number) {
  const line = form.value.lines[idx]
  if (!line || !grWithUpdate.value) return
  const purchase = Number(line.unitCost) || 0
  if (!purchase) return
  for (const t of (line.priceTiers || [])) {
    if (!t.manualOverride) t.finalPrice = +(purchase * (1 + (t.percent || 0) / 100)).toFixed(4)
  }
  // Mirror purchasePrice into the product update so the backend persists it.
  setUpdate(line, 'purchasePrice', purchase)
}

async function fetchContacts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`)
    contacts.value = (data.contacts || []).map((c: any) => ({ ...c, name: contactDisplayName(c) }))
  } catch { /* */ }
}

onMounted(async () => {
  await Promise.all([fetchWarehouses(), fetchContacts(), fetchCategories()])
  if (tryRestore()) return
  fetchItem()
})
</script>
