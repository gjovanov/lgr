<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ isEdit ? $t('invoicing.editCreditNote') : $t('invoicing.newCreditNote') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <v-row>
            <v-col cols="12" md="4">
              <ContactAutocompleteWithCreate
                v-model="form.contactId"
                :contacts="contacts"
                :label="$t('invoicing.contact')"
                :required="true"
                @contact-created="onContactCreated"
                @update:model-value="onContactChange"
              />
              <v-btn v-if="form.contactId" icon="mdi-book-open-variant" size="x-small" variant="text" color="info" class="ml-1" @click="ledgerDialog = true" />
            </v-col>
            <v-col cols="12" md="4">
              <v-autocomplete v-model="form.relatedInvoiceId" :label="$t('invoicing.relatedInvoice')" :items="invoices" item-title="invoiceNumber" item-value="_id" clearable />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.date" :label="$t('common.date')" type="date" :rules="[rules.required]" />
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
                <th class="text-end" style="width:80px">{{ $t('invoicing.taxRate') }}</th>
                <th style="width:160px">{{ $t('warehouse.warehouse') }}</th>
                <th class="text-end" style="width:110px">{{ $t('common.total') }}</th>
                <th style="width:40px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, idx) in form.lines" :key="idx">
                <td style="min-width:200px">
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
                <td><v-text-field v-model.number="line.unitPrice" type="number" step="0.01" density="compact" hide-details variant="underlined" @change="onUnitPriceManualChange(idx)" /></td>
                <td><v-text-field v-model.number="line.taxRate" type="number" suffix="%" density="compact" hide-details variant="underlined" /></td>
                <td><v-autocomplete v-model="line.warehouseId" :items="warehouses" item-title="name" item-value="_id" density="compact" hide-details variant="underlined" clearable /></td>
                <td class="text-end">
                  <span>{{ fmtCurrency(computeLineTotal(line)) }}</span>
                  <PriceExplainButton v-if="line.priceExplanation?.length" :steps="line.priceExplanation" :currency="form.currency" />
                </td>
                <td><v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" /></td>
              </tr>
            </tbody>
          </v-table>

          <!-- Totals & Reason -->
          <v-row class="mt-4">
            <v-col cols="12" md="6">
              <v-textarea v-model="form.reason" :label="$t('invoicing.reason')" rows="2" />
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

          <div class="d-flex justify-end mt-4">
            <v-btn variant="text" class="mr-2" @click="router.back()">{{ $t('common.cancel') }}</v-btn>
            <v-btn type="submit" color="primary" :loading="loading">{{ $t('common.save') }}</v-btn>
          </div>
        </v-form>
      </v-card-text>
    </v-card>
    <ContactLedgerDialog v-model="ledgerDialog" :contact-id="form.contactId" :org-url="orgUrl()" />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ProductLineDescription from '../../components/ProductLineDescription.vue'
import ContactAutocompleteWithCreate from '../../components/ContactAutocompleteWithCreate.vue'
import PriceExplainButton from 'ui-shared/components/PriceExplainButton.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'

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
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const formRef = ref()
const loading = ref(false)
const ledgerDialog = ref(false)
const contacts = ref<{ _id: string; companyName: string }[]>([])
const invoices = ref<{ _id: string; invoiceNumber: string }[]>([])
const warehouses = ref<{ _id: string; name: string }[]>([])
const isEdit = computed(() => !!route.params.id)
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

function emptyLine(): Line {
  return { description: '', quantity: 1, unitPrice: 0, taxRate: 0 }
}

const form = ref({
  contactId: '',
  relatedInvoiceId: '',
  date: new Date().toISOString().split('T')[0],
  currency: baseCurrency.value,
  exchangeRate: 1,
  reason: '',
  lines: [emptyLine()] as Line[],
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

async function onProductSelected(idx: number, product: any) {
  const line = form.value.lines[idx]
  if (!line) return
  line.unitPrice = product.sellingPrice ?? 0
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

function onContactCreated(contact: any) {
  contacts.value.push(contact)
  form.value.contactId = contact._id || contact.id
  onContactChange()
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

// Auto-populate lines from related invoice
watch(() => form.value.relatedInvoiceId, async (newId) => {
  if (!newId || isEdit.value) return
  try {
    const { data } = await httpClient.get(`${orgUrl()}/invoices/${newId}`)
    const invoice = data.invoice
    if (invoice?.lines?.length) {
      form.value.lines = invoice.lines.map((l: any) => ({
        productId: l.productId || undefined,
        description: l.description || '',
        quantity: l.quantity || 1,
        unitPrice: l.unitPrice || 0,
        taxRate: l.taxRate || 0,
        warehouseId: l.warehouseId || undefined,
      }))
    }
  } catch { /* */ }
})

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
      issueDate: form.value.date,
      subtotal: +subtotal.value.toFixed(2),
      total: +invoiceTotal.value.toFixed(2),
      direction: 'outgoing',
      type: 'credit_note',
    }
    if (isEdit.value) await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
    else await httpClient.post(`${orgUrl()}/invoices`, payload)
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'invoicing.credit-notes' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

async function fetchContacts() {
  try { const { data } = await httpClient.get(`${orgUrl()}/invoicing/contact`); contacts.value = data.contacts || [] } catch { /* */ }
}

async function fetchInvoices() {
  try { const { data } = await httpClient.get(`${orgUrl()}/invoices`, { params: { type: 'invoice' } }); invoices.value = data.invoices || [] } catch { /* */ }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(async () => {
  await Promise.all([fetchContacts(), fetchInvoices(), fetchWarehouses()])
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${route.params.id}`)
      const inv = data.invoice
      form.value = {
        contactId: inv.contactId?._id || inv.contactId || '',
        relatedInvoiceId: inv.relatedInvoiceId || '',
        date: inv.issueDate?.split('T')[0] || inv.date?.split('T')[0] || '',
        currency: inv.currency || baseCurrency.value,
        exchangeRate: inv.exchangeRate || 1,
        reason: inv.reason || '',
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
