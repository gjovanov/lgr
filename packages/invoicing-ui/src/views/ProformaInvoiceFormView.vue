<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editProformaInvoice') : $t('invoicing.newProformaInvoice')"
    :subtitle="isEdit ? invoiceNumber : ''"
    :status="isEdit ? { steps: ['Draft', 'Sent', 'Converted'], current: statusLabel } : undefined"
    :actions="formActions"
    :loading="loading"
    :entity-id="isEdit ? (route.params.id as string) : undefined"
    back-to="/proforma"
  >
    <div v-if="isEdit" class="d-flex justify-end mb-2">
      <v-btn variant="outlined" prepend-icon="mdi-download" @click="showExportDialog = true" :loading="exportLoading">{{ $t('common.export') }}</v-btn>
    </div>
    <ExportDialog v-model="showExportDialog" :loading="exportLoading" default-mode="detailed" @confirm="onExportSingle" />
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <v-row>
            <v-col cols="12" md="4">
              <v-autocomplete v-model="form.contactId" :label="$t('invoicing.contact')" :items="contacts" item-title="companyName" item-value="_id" :rules="[rules.required]" @update:model-value="onContactChange" />
              <v-btn v-if="form.contactId" icon="mdi-book-open-variant" size="x-small" variant="text" color="info" class="ml-1" @click="ledgerDialog = true" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.validUntil" :label="$t('invoicing.validUntil')" type="date" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="4">
              <v-select v-model="form.currency" :label="$t('common.currency')" :items="currencies" />
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
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end" style="width:80px">{{ $t('invoicing.qty') }}</th>
                <th class="text-end" style="width:110px">{{ $t('invoicing.unitPrice') }}</th>
                <th class="text-end" style="width:80px">{{ $t('invoicing.discount') }}</th>
                <th class="text-end" style="width:110px">{{ $t('invoicing.taxRate') }}</th>
                <th style="width:180px">{{ $t('warehouse.warehouse') }}</th>
                <th class="text-end" style="width:110px">{{ $t('common.total') }}</th>
                <th style="width:40px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, idx) in form.lines" :key="idx">
                <td style="min-width:160px">
                  <ProductLineDescription
                    :description="line.description"
                    :product-id="line.productId"
                    price-field="sellingPrice"
                    @update:description="line.description = $event"
                    @update:product-id="line.productId = $event"
                    @product-selected="onProductSelected(idx, $event)"
                    @product-cleared="onProductCleared(idx)"
                  />
                </td>
                <td><v-text-field v-model.number="line.quantity" type="number" density="compact" hide-details variant="underlined" /></td>
                <td>
                  <PriceCombobox
                    :model-value="line.unitPrice"
                    :product-id="line.productId"
                    :contact-id="form.contactId"
                    :quantity="line.quantity"
                    :org-url="orgUrl()"
                    :currency="form.currency"
                    :resolved-price="line.resolvedPrice"
                    :price-explanation="line.priceExplanation"
                    @update:model-value="updateLinePrice(idx, $event)"
                    @update:price-explanation="line.priceExplanation = $event"
                  />
                </td>
                <td><v-text-field v-model.number="line.discount" type="number" suffix="%" density="compact" hide-details variant="underlined" /></td>
                <td><TaxRateCombobox v-model="line.taxRate" :rates="vatRates" :default-rate="defaultVatRate" :org-url="appStore.orgUrl()" /></td>
                <td><v-autocomplete v-model="line.warehouseId" :items="warehouses" item-title="name" item-value="_id" density="compact" hide-details variant="underlined" clearable /></td>
                <td class="text-end" style="white-space: nowrap; min-width: 120px;">
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
            </v-col>
            <v-col cols="12" md="6">
              <v-card variant="outlined">
                <v-card-text>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('invoicing.subtotal') }}</span>
                    <span class="font-weight-medium">{{ fmtCurrency(subtotal) }}</span>
                  </div>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('invoicing.discountTotal') }}</span>
                    <span class="text-error">-{{ fmtCurrency(discountTotal) }}</span>
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

        </v-form>

    <template #sidebar>
      <EntityNotesPanel :org-url="orgUrl()" entity-type="proformaInvoice" :entity-id="isEdit ? (route.params.id as string) : undefined" />
    </template>

    <ContactLedgerDialog v-model="ledgerDialog" :contact-id="form.contactId" :org-url="orgUrl()" :selectable="true" @add-lines="onAddLedgerLines" />
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
import PriceExplainButton from 'ui-shared/components/PriceExplainButton.vue'
import PriceCombobox from 'ui-shared/components/PriceCombobox.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import TaxRateCombobox from 'ui-shared/components/TaxRateCombobox'
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
  discount: number
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

const formRef = ref()
const loading = ref(false)
const ledgerDialog = ref(false)
const contacts = ref<{ _id: string; companyName: string }[]>([])
const warehouses = ref<{ _id: string; name: string }[]>([])
const isEdit = computed(() => !!route.params.id)

const showExportDialog = ref(false)
const { loading: exportLoading, exportOne } = useInvoicingExport(() => appStore.orgUrl())

async function onExportSingle(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed' }) {
  const id = route.params.id as string
  if (!id) return
  try {
    await exportOne(id, (form.value as any).invoiceNumber || invoiceNumber.value || id, opts.format, opts.mode)
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
  if (s === 'sent') return 'Sent'
  if (s === 'converted') return 'Converted'
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
  return { description: '', quantity: 1, unitPrice: 0, discount: 0, taxRate: defaultVatRate.value }
}

const form = ref({
  contactId: '',
  issueDate: new Date().toISOString().split('T')[0],
  validUntil: '',
  currency: baseCurrency.value,
  exchangeRate: 1,
  notes: '',
  lines: [emptyLine()] as Line[],
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'proformaInvoice',
  icon: 'mdi-file-document-outline',
  getFormData: () => ({ ...form.value }),
  getPreviewFields: () => [
    { label: 'Date', value: form.value.issueDate || '' },
    { label: 'Currency', value: form.value.currency || '' },
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

function lineSubtotal(l: Line) { return l.quantity * l.unitPrice }
function lineDiscount(l: Line) { return lineSubtotal(l) * (l.discount / 100) }
function computeLineTotal(l: Line) {
  const taxable = lineSubtotal(l) - lineDiscount(l)
  return taxable + taxable * (l.taxRate / 100)
}

const subtotal = computed(() => form.value.lines.reduce((s, l) => s + lineSubtotal(l), 0))
const discountTotal = computed(() => form.value.lines.reduce((s, l) => s + lineDiscount(l), 0))
const taxTotal = computed(() => form.value.lines.reduce((s, l) => {
  const taxable = lineSubtotal(l) - lineDiscount(l)
  return s + taxable * (l.taxRate / 100)
}, 0))
const invoiceTotal = computed(() => subtotal.value - discountTotal.value + taxTotal.value)

function addLine() { form.value.lines.push(emptyLine()) }

function onAddLedgerLines(ledgerEntries: any[]) {
  for (const entry of ledgerEntries) {
    form.value.lines.push({
      productId: entry.productId || undefined,
      description: entry.productName || '',
      quantity: entry.quantity || 1,
      unitPrice: entry.unitPrice || 0,
      discount: 0,
      taxRate: entry.taxRate || 0,
      warehouseId: entry.warehouseId || undefined,
    })
  }
}

async function onProductSelected(idx: number, product: any) {
  const line = form.value.lines[idx]
  if (!line) return
  line.unitPrice = product.sellingPrice ?? 0
  line.discount = 0
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

function updateLinePrice(idx: number, price: number) {
  const line = form.value.lines[idx]
  if (!line) return
  line.unitPrice = price
  if (line.resolvedPrice !== undefined && price !== line.resolvedPrice && line.priceExplanation?.length) {
    const steps = line.priceExplanation.filter(s => s.type !== 'override')
    steps.push({ type: 'override', label: 'User override', price })
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
      discount: l.discount,
      taxRate: l.taxRate,
      taxAmount: +((lineSubtotal(l) - lineDiscount(l)) * l.taxRate / 100).toFixed(2),
      lineTotal: +computeLineTotal(l).toFixed(2),
      warehouseId: l.warehouseId || undefined,
      priceExplanation: l.priceExplanation || undefined,
    }))
    const payload = {
      ...form.value,
      lines,
      subtotal: +subtotal.value.toFixed(2),
      total: +invoiceTotal.value.toFixed(2),
      direction: 'outgoing',
      type: 'proforma',
    }
    if (isEdit.value) await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
    else await httpClient.post(`${orgUrl()}/invoices`, payload)
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'invoicing.proforma' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

async function fetchContacts() {
  try { const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`); contacts.value = data.contacts || [] } catch { /* */ }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(async () => {
  await Promise.all([fetchContacts(), fetchWarehouses()])
  if (tryRestore()) return
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${route.params.id}`)
      const inv = data.invoice
      invoiceStatus.value = inv.status || 'draft'
      invoiceNumber.value = inv.invoiceNumber || ''
      form.value = {
        contactId: inv.contactId?._id || inv.contactId || '',
        issueDate: inv.issueDate?.split('T')[0] || '',
        validUntil: inv.validUntil?.split('T')[0] || '',
        currency: inv.currency || baseCurrency.value,
        exchangeRate: inv.exchangeRate || 1,
        notes: inv.notes || '',
        lines: (inv.lines || []).map((l: any) => ({
          productId: l.productId || undefined,
          description: l.description || '',
          quantity: l.quantity || 1,
          unitPrice: l.unitPrice || 0,
          discount: l.discount || 0,
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
