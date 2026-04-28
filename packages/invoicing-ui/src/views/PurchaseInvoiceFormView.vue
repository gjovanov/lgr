<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editPurchaseInvoice') : $t('invoicing.newPurchaseInvoice')"
    :subtitle="isEdit ? invoiceNumber : ''"
    :status="isEdit ? { steps: ['Draft', 'Received', 'Paid'], current: statusLabel } : undefined"
    :actions="formActions"
    :loading="loading"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
    back-to="/bills"
  >
    <div v-if="isEdit" class="d-flex justify-end mb-2">
      <v-btn variant="outlined" prepend-icon="mdi-download" @click="showExportDialog = true" :loading="exportLoading">{{ $t('common.export') }}</v-btn>
    </div>
    <ExportDialog v-model="showExportDialog" :loading="exportLoading" default-mode="detailed" @confirm="onExportSingle" />
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <v-defaults-provider :defaults="{
            VTextField: { density: 'compact', variant: 'outlined' },
            VSelect: { density: 'compact', variant: 'outlined' },
            VAutocomplete: { density: 'compact', variant: 'outlined' },
            VTextarea: { density: 'compact', variant: 'outlined' },
          }">
          <v-row dense>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.supplierInvoiceNumber" :label="$t('invoicing.supplierInvoiceNumber')" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="4">
              <v-autocomplete v-model="form.contactId" :label="$t('invoicing.supplier')" :items="suppliers" item-title="companyName" item-value="_id" :rules="[rules.required]" @update:model-value="onContactChange" />
              <v-btn v-if="form.contactId" icon="mdi-book-open-variant" size="x-small" variant="text" color="info" class="ml-1" @click="ledgerDialog = true" />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="form.currency" :label="$t('common.currency')" :items="currencies" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.dueDate" :label="$t('invoicing.dueDate')" type="date" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model.number="form.exchangeRate" :label="$t('invoicing.exchangeRate')" type="number" step="0.0001" />
            </v-col>
          </v-row>

          <!-- Line Items -->
          <div class="d-flex align-center mt-6 mb-2">
            <p class="text-subtitle-1 font-weight-bold">{{ $t('invoicing.lineItems') }}</p>
            <v-spacer />
            <v-btn color="primary" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">{{ $t('invoicing.addLine') }}</v-btn>
            <v-btn class="ml-2" variant="outlined" size="small" icon="mdi-cog" :title="$t('invoicing.linePicker.title')" @click="columnPickerOpen = true" />
          </div>
          <LineColumnPickerDialog
            v-model="columnPickerOpen"
            :selected="selectedCols"
            :available-columns="availableLineColumns"
            @toggle="toggleCol"
            @select-all="selectAllCols"
            @select-none="selectNoCols"
            @reset-defaults="resetColDefaults"
          />
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.description') }}</th>
                <th
                  v-for="col in activeLineColumns.filter(c => c.key !== 'description')"
                  :key="col.key"
                  :class="col.align === 'end' ? 'text-end' : ''"
                  :style="col.width ? `width:${col.width}` : ''"
                >{{ $t(col.i18n) }}</th>
                <th style="width:40px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, idx) in form.lines" :key="idx">
                <td style="min-width:160px">
                  <div class="d-flex align-center ga-1">
                    <ProductLineDescription
                      :description="line.description"
                      :product-id="line.productId"
                      price-field="purchasePrice"
                      class="flex-grow-1"
                      @update:description="line.description = $event"
                      @update:product-id="line.productId = $event"
                      @product-selected="onProductSelected(idx, $event)"
                      @product-cleared="onProductCleared(idx)"
                    />
                    <v-btn icon="mdi-magnify-expand" size="x-small" variant="text" :title="$t('invoicing.browseProducts')" @click="openProductPicker(idx)" />
                  </div>
                </td>
                <td v-if="isColActive('qty')"><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" /></td>
                <td v-if="isColActive('unitPrice')"><v-text-field v-model.number="line.unitPrice" type="number" step="0.01" density="compact" hide-details variant="underlined" @change="onUnitPriceManualChange(idx)" /></td>
                <td v-if="isColActive('taxRate')"><TaxRateCombobox v-model="line.taxRate" :rates="vatRates" :default-rate="defaultVatRate" :org-url="appStore.orgUrl()" /></td>
                <td v-if="isColActive('warehouse')"><v-autocomplete v-model="line.warehouseId" :items="warehouses" item-title="name" item-value="_id" density="compact" hide-details variant="underlined" clearable /></td>
                <td v-if="isColActive('lineTotal')" class="text-end">
                  <span>{{ fmtCurrency(computeLineTotal(line)) }}</span>
                  <PriceExplainButton v-if="line.priceExplanation?.length" :steps="line.priceExplanation" :currency="form.currency" />
                </td>
                <td><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
              </tr>
            </tbody>
          </v-table>

          <!-- Totals -->
          <v-row class="mt-4">
            <v-col cols="12" md="6">
              <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" />
              <TagInput v-model="form.tags" type="invoice" :org-url="appStore.orgUrl()" class="mt-2" />
            </v-col>
            <v-col cols="12" md="6">
              <v-card variant="outlined">
                <v-card-text>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('invoicing.subtotal') }}</span>
                    <span class="font-weight-medium">{{ fmtCurrency(subtotal) }}</span>
                  </div>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('invoicing.taxTotal') }}</span>
                    <span>{{ fmtCurrency(taxTotal) }}</span>
                  </div>
                  <v-divider class="my-2" />
                  <div class="d-flex justify-space-between text-h6">
                    <span>{{ $t('common.total') }}</span>
                    <span>{{ fmtCurrency(invoiceTotal) }}</span>
                  </div>
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>
          </v-defaults-provider>
        </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="purchaseInvoice" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ContactLedgerDialog v-model="ledgerDialog" :contact-id="form.contactId" :org-url="orgUrl()" :selectable="true" @add-lines="onAddLedgerLines" />
    <ProductPickerDialog v-model="productPickerOpen" :org-url="orgUrl()" :base-currency="baseCurrency" :locale="localeCode" @select="onProductPicked" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ExportDialog from 'ui-shared/components/ExportDialog'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ProductLineDescription from '../components/ProductLineDescription.vue'
import ProductPickerDialog from 'ui-shared/components/ProductPickerDialog'
import PriceExplainButton from 'ui-shared/components/PriceExplainButton.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import TaxRateCombobox from 'ui-shared/components/TaxRateCombobox'
import LineColumnPickerDialog from 'ui-shared/components/LineColumnPickerDialog.vue'
import { useInvoiceLineColumns } from 'ui-shared/composables/useInvoiceLineColumns'
import TagInput from 'ui-shared/components/TagInput.vue'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import EntityNotesPanel from 'ui-shared/components/EntityNotesPanel.vue'
import type { FormAction } from 'ui-shared/components/EntityFormShell.vue'

const currencies = ['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']

interface PriceStep {
  type: 'base' | 'tag' | 'contact' | 'override'
  label: string
  price: number
}

interface Line {
  productId?: string
  description: string
  quantity: number
  unitPrice: number
  taxRate: number
  warehouseId?: string
  priceExplanation?: PriceStep[]
  resolvedPrice?: number
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const vatRates = computed(() => appStore.currentOrg?.settings?.taxConfig?.vatRates ?? [])
const defaultVatRate = computed(() => appStore.currentOrg?.settings?.taxConfig?.defaultVatRate ?? 0)
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const columnPickerOpen = ref(false)
const {
  selected: selectedCols,
  availableColumns: availableLineColumns,
  activeColumns: activeLineColumns,
  toggle: toggleCol,
  selectAll: selectAllCols,
  selectNone: selectNoCols,
  resetDefaults: resetColDefaults,
} = useInvoiceLineColumns('purchase_invoice', {
  userId: () => (appStore.user as any)?._id,
  orgId: () => appStore.currentOrg?.id,
})
const isColActive = (key: string) => selectedCols.value.includes(key)

const formRef = ref()
const loading = ref(false)
const ledgerDialog = ref(false)
const productPickerOpen = ref(false)
const productPickerRowIdx = ref(-1)
const suppliers = ref<{ _id: string; companyName: string }[]>([])
const warehouses = ref<{ _id: string; name: string }[]>([])
const isEdit = computed(() => !!route.params.id)

const showExportDialog = ref(false)
const { loading: exportLoading, exportOne } = useInvoicingExport(() => appStore.orgUrl())

async function onExportSingle(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed' }) {
  const id = route.params.id as string
  if (!id) return
  try {
    await exportOne(id, (form.value as any).invoiceNumber || invoiceNumber.value || id, opts.format, opts.mode, undefined, appStore.locale)
    showExportDialog.value = false
    showSuccess(t('export.success'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('export.failed'))
  }
}
const invoiceStatus = ref('draft')
const invoiceNumber = ref('')
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const statusLabel = computed(() => {
  const s = invoiceStatus.value
  if (s === 'draft') return 'Draft'
  if (s === 'received') return 'Received'
  if (s === 'paid' || s === 'partially_paid') return 'Paid'
  return 'Draft'
})

const formActions = computed<FormAction[]>(() => {
  if (!isEdit.value) {
    return [{ label: t('common.save'), color: 'primary', handler: handleSubmit, loading: loading.value }]
  }
  const actions: FormAction[] = []
  actions.push({ label: t('common.save'), color: 'primary', handler: handleSubmit, loading: loading.value })
  return actions
})

function emptyLine(): Line {
  return { description: '', quantity: 1, unitPrice: 0, taxRate: defaultVatRate.value }
}

const form = ref({
  supplierInvoiceNumber: '',
  contactId: '',
  issueDate: new Date().toISOString().split('T')[0],
  dueDate: '',
  currency: baseCurrency.value,
  exchangeRate: 1,
  notes: '',
  tags: [] as string[],
  lines: [emptyLine()] as Line[],
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'purchaseInvoice',
  icon: 'mdi-receipt-text',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Ref', value: form.value.supplierInvoiceNumber || '' },
    { label: 'Date', value: form.value.issueDate || '' },
  ],
  setFormData: (data) => { form.value = { ...form.value, ...data } },
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = { required: (v: string) => !!v || t('validation.required') }

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

function fmtCurrency(amount: number) {
  return formatCurrency(amount, form.value.currency || baseCurrency.value, localeCode.value)
}

function computeLineTotal(l: Line) { return l.quantity * l.unitPrice * (1 + l.taxRate / 100) }
const subtotal = computed(() => form.value.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0))
const taxTotal = computed(() => form.value.lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.taxRate / 100), 0))
const invoiceTotal = computed(() => subtotal.value + taxTotal.value)

function addLine() { form.value.lines.push(emptyLine()) }

function onAddLedgerLines(ledgerEntries: any[]) {
  for (const entry of ledgerEntries) {
    form.value.lines.push({
      productId: entry.productId || undefined,
      description: entry.productName || '',
      quantity: entry.quantity || 1,
      unitPrice: entry.unitPrice || 0,
      taxRate: entry.taxRate || 0,
      warehouseId: entry.warehouseId || undefined,
    })
  }
}

async function onProductSelected(idx: number, product: any) {
  const line = form.value.lines[idx]
  if (!line) return
  line.unitPrice = product.purchasePrice ?? 0
  line.taxRate = product.taxRate ?? line.taxRate
  await resolvePriceForLine(idx)
}

function onProductCleared(idx: number) {
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = undefined
  line.priceExplanation = undefined
  line.resolvedPrice = undefined
}

function openProductPicker(idx: number) {
  productPickerRowIdx.value = idx
  productPickerOpen.value = true
}

async function onProductPicked(product: any) {
  const idx = productPickerRowIdx.value
  productPickerRowIdx.value = -1
  if (idx < 0) return
  const line = form.value.lines[idx]
  if (!line) return
  line.productId = product._id
  line.description = product.name
  await onProductSelected(idx, product)
}

function onContactChange() {
  form.value.lines.forEach((_, i) => {
    if (form.value.lines[i]?.productId) resolvePriceForLine(i)
  })
}

async function resolvePriceForLine(idx: number) {
  const line = form.value.lines[idx]
  if (!line?.productId) return
  try {
    const params: Record<string, string> = { productId: line.productId }
    if (form.value.contactId) params.contactId = form.value.contactId
    if (line.quantity) params.quantity = String(line.quantity)
    const { data } = await httpClient.get(`${orgUrl()}/pricing/resolve`, { params })
    line.unitPrice = data.finalPrice
    line.priceExplanation = data.steps
    line.resolvedPrice = data.finalPrice
  } catch { }
}

function onUnitPriceManualChange(idx: number) {
  const line = form.value.lines[idx]
  if (!line || !line.priceExplanation?.length) return
  if (line.resolvedPrice !== undefined && line.unitPrice !== line.resolvedPrice) {
    const steps = line.priceExplanation.filter(s => s.type !== 'override')
    steps.push({ type: 'override', label: 'User override', price: line.unitPrice })
    line.priceExplanation = steps
  }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    const lines = form.value.lines.map(l => ({
      productId: l.productId || undefined,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
      taxAmount: +(l.quantity * l.unitPrice * l.taxRate / 100).toFixed(2),
      lineTotal: +computeLineTotal(l).toFixed(2),
      warehouseId: l.warehouseId || undefined,
      priceExplanation: l.priceExplanation || undefined,
    }))
    const payload = {
      ...form.value,
      lines,
      subtotal: +subtotal.value.toFixed(2),
      total: +invoiceTotal.value.toFixed(2),
      direction: 'incoming',
      type: 'invoice',
    }
    if (isEdit.value) await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
    else await httpClient.post(`${orgUrl()}/invoices`, payload)
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'invoicing.purchases' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

async function fetchSuppliers() {
  try { const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`, { params: { type: 'supplier' } }); suppliers.value = data.contacts || [] } catch { /* */ }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(async () => {
  await Promise.all([fetchSuppliers(), fetchWarehouses()])
  if (tryRestore()) return
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${route.params.id}`)
      const inv = data.invoice
      invoiceStatus.value = inv.status || 'draft'
      invoiceNumber.value = inv.invoiceNumber || ''
      form.value = {
        supplierInvoiceNumber: inv.supplierInvoiceNumber || '',
        contactId: inv.contactId?._id || inv.contactId || '',
        issueDate: inv.issueDate?.split('T')[0] || '',
        dueDate: inv.dueDate?.split('T')[0] || '',
        currency: inv.currency || baseCurrency.value,
        exchangeRate: inv.exchangeRate || 1,
        notes: inv.notes || '',
        tags: inv.tags || [],
        lines: (inv.lines || []).map((l: any) => ({
          productId: l.productId || undefined,
          description: l.description || '',
          quantity: l.quantity || 1,
          unitPrice: l.unitPrice || 0,
          taxRate: l.taxRate || 0,
          warehouseId: l.warehouseId || undefined,
          priceExplanation: l.priceExplanation || undefined,
          resolvedPrice: l.unitPrice || undefined,
        })),
      }
    } catch { /* */ }
  }
})
</script>
