<template>
  <EntityFormShell
    :title="isEdit ? $t('invoicing.editInvoice') : $t('invoicing.newInvoice')"
    :subtitle="isEdit ? invoiceNumber : ''"
    :status="isEdit ? { steps: ['Draft', 'Sent', 'Paid'], current: statusLabel } : undefined"
    :actions="formActions"
    :smart-buttons="isEdit ? smartButtons : undefined"
    :loading="loading"
    back-to="/sales-invoices"
  >
    <v-form ref="formRef" @submit.prevent="handleSubmit">
      <!-- Header Fields (always visible above tabs) -->
      <v-row>
        <v-col cols="12" md="4">
          <ContactAutocompleteWithCreate
            v-model="form.contactId"
            :contacts="contacts"
            :label="$t('invoicing.contact')"
            :required="true"
            @update:model-value="onContactChange"
            @contact-created="onContactCreated"
          />
          <v-btn v-if="form.contactId" icon="mdi-book-open-variant" size="x-small" variant="text" color="info" class="ml-1" @click="ledgerDialog = true" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :rules="[rules.required]" />
        </v-col>
        <v-col cols="12" md="4">
          <v-text-field v-model="form.dueDate" :label="$t('invoicing.dueDate')" type="date" />
        </v-col>
      </v-row>
      <v-row>
        <v-col cols="12" md="3">
          <v-select v-model="form.type" :label="$t('invoicing.type')" :items="invoiceTypes" item-title="text" item-value="value" />
        </v-col>
        <v-col cols="12" md="3">
          <v-select v-model="form.currency" :label="$t('common.currency')" :items="['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']" />
        </v-col>
        <v-col cols="12" md="3">
          <v-text-field v-model.number="form.exchangeRate" :label="$t('invoicing.exchangeRate')" type="number" step="0.0001" min="0" />
        </v-col>
        <v-col cols="12" md="3">
          <v-select v-model="form.direction" :label="$t('invoicing.direction')" :items="invoiceDirections" item-title="text" item-value="value" />
        </v-col>
      </v-row>

      <v-tabs v-model="activeTab" density="compact" class="mt-4 mb-2">
        <v-tab value="lines">{{ $t('invoicing.lineItems') }}</v-tab>
        <v-tab value="info">{{ $t('invoicing.otherInfo') }}</v-tab>
      </v-tabs>

      <v-tabs-window v-model="activeTab">
        <!-- Tab 1: Invoice Lines -->
        <v-tabs-window-item value="lines">
          <div class="d-flex align-center mt-2 mb-2">
            <v-spacer />
            <v-btn color="primary" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">
              {{ $t('invoicing.addLine') }}
            </v-btn>
          </div>
          <!-- Header Fields -->
          <v-row>
            <v-col cols="12" md="4">
              <ContactAutocompleteWithCreate
                v-model="form.contactId"
                :contacts="contacts"
                :label="$t('invoicing.contact')"
                :required="true"
                @update:model-value="onContactChange"
                @contact-created="onContactCreated"
              />
              <v-btn v-if="form.contactId" icon="mdi-book-open-variant" size="x-small" variant="text" color="info" class="ml-1" @click="ledgerDialog = true" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.issueDate" :label="$t('invoicing.issueDate')" type="date" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.dueDate" :label="$t('invoicing.dueDate')" type="date" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="3">
              <v-select
                v-model="form.type"
                :label="$t('invoicing.type')"
                :items="invoiceTypes"
                item-title="text"
                item-value="value"
              />
            </v-col>
            <v-col cols="12" md="3">
              <v-select
                v-model="form.currency"
                :label="$t('common.currency')"
                :items="['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']"
              />
            </v-col>
            <v-col cols="12" md="3">
              <v-text-field
                v-model.number="form.exchangeRate"
                :label="$t('invoicing.exchangeRate')"
                type="number"
                step="0.0001"
                min="0"
              />
            </v-col>
            <v-col cols="12" md="3">
              <v-select
                v-model="form.direction"
                :label="$t('invoicing.direction')"
                :items="invoiceDirections"
                item-title="text"
                item-value="value"
              />
            </v-col>
          </v-row>

          <!-- Totals -->
          <v-row class="mt-4">
            <v-col cols="12" md="6" />
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
        </v-tabs-window-item>

        <!-- Tab 2: Other Info -->
        <v-tabs-window-item value="info">
          <p class="text-subtitle-1 font-weight-bold mt-4 mb-2">{{ $t('invoicing.billingAddress') }}</p>
          <v-row>
            <v-col cols="12" md="6">
              <v-text-field v-model="form.billingAddress.street" :label="$t('invoicing.street')" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field v-model="form.billingAddress.city" :label="$t('invoicing.city')" :rules="[rules.required]" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.billingAddress.state" :label="$t('invoicing.state')" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.billingAddress.postalCode" :label="$t('invoicing.postalCode')" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.billingAddress.country" :label="$t('invoicing.country')" :rules="[rules.required]" />
            </v-col>
          </v-row>

          <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" class="mt-4" />
          <v-textarea v-model="form.terms" :label="$t('invoicing.terms')" rows="2" />
          <v-text-field v-model="form.footer" :label="$t('invoicing.footer')" />
          <TagInput v-model="form.tags" type="invoice" :org-url="orgUrl()" class="mt-2" />
        </v-tabs-window-item>
      </v-tabs-window>
    </v-form>

    <ContactLedgerDialog v-model="ledgerDialog" :contact-id="form.contactId" :org-url="orgUrl()" :selectable="true" @add-lines="onAddLedgerLines" />
  </EntityFormShell>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ProductLineDescription from '../components/ProductLineDescription.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import PriceExplainButton from 'ui-shared/components/PriceExplainButton.vue'
import PriceCombobox from 'ui-shared/components/PriceCombobox.vue'
import ContactAutocompleteWithCreate from '../components/ContactAutocompleteWithCreate.vue'
import ContactLedgerDialog from 'ui-shared/components/ContactLedgerDialog.vue'
import { usePendingChanges } from 'ui-shared/composables/usePendingChanges'
import EntityFormShell from 'ui-shared/components/EntityFormShell.vue'
import type { FormAction, SmartButtonDef } from 'ui-shared/components/EntityFormShell.vue'

interface PriceStep {
  type: 'base' | 'tag' | 'contact' | 'override'
  label: string
  price: number
}

interface Line {
  productId?: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
  accountId?: string
  warehouseId?: string
  priceExplanation?: PriceStep[]
  resolvedPrice?: number
}

interface BillingAddress {
  street: string
  city: string
  state: string
  postalCode: string
  country: string
}

interface ContactAddress {
  type: string
  street: string
  street2?: string
  city: string
  state?: string
  postalCode: string
  country: string
  isDefault: boolean
}

interface Contact {
  _id: string
  companyName: string
  addresses?: ContactAddress[]
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
const loadingContacts = ref(false)
const contacts = ref<Contact[]>([])
const warehouses = ref<{ _id: string; name: string }[]>([])
const isEdit = computed(() => !!route.params.id)
const invoiceStatus = ref('draft')
const invoiceNumber = ref('')
const activeTab = ref('lines')
const invoiceData = ref<any>(null)

const statusLabel = computed(() => {
  const s = invoiceStatus.value
  if (s === 'draft') return 'Draft'
  if (s === 'sent' || s === 'received') return 'Sent'
  if (s === 'paid' || s === 'partially_paid') return 'Paid'
  return 'Draft'
})

const formActions = computed<FormAction[]>(() => {
  if (!isEdit.value) {
    return [{ label: t('common.save'), color: 'primary', handler: handleSubmit, loading: loading.value }]
  }
  const s = invoiceStatus.value
  const actions: FormAction[] = []
  if (s === 'draft') {
    actions.push({ label: t('common.save'), color: 'primary', handler: handleSubmit, loading: loading.value })
  }
  return actions
})

const smartButtons = computed<SmartButtonDef[]>(() => {
  if (!invoiceData.value) return []
  const btns: SmartButtonDef[] = []
  if (invoiceData.value.journalEntryId) {
    btns.push({ label: 'Journal Entry', value: 1, icon: 'mdi-book-open-variant', to: `/accounting/journal-entries` })
  }
  const payments = invoiceData.value.payments || []
  if (payments.length > 0) {
    const totalPaid = payments.reduce((s: number, p: any) => s + (p.amount || 0), 0)
    btns.push({ label: 'Payments', value: fmtCurrency(totalPaid), icon: 'mdi-cash-multiple' })
  }
  const transferIds = invoiceData.value.pendingTransferIds || []
  if (transferIds.length > 0) {
    btns.push({ label: 'Deliveries', value: transferIds.length, icon: 'mdi-truck-delivery', to: `/movements` })
  }
  return btns
})
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const invoiceTypes = [
  { value: 'invoice', text: t('invoicing.typeInvoice') },
  { value: 'proforma', text: t('invoicing.typeProforma') },
  { value: 'credit_note', text: t('invoicing.typeCreditNote') },
  { value: 'debit_note', text: t('invoicing.typeDebitNote') },
]

const invoiceDirections = [
  { value: 'outgoing', text: t('invoicing.directionOutgoing') },
  { value: 'incoming', text: t('invoicing.directionIncoming') },
]

function emptyBillingAddress(): BillingAddress {
  return { street: '', city: '', state: '', postalCode: '', country: '' }
}

function emptyLine(): Line {
  return {
    description: '',
    quantity: 1,
    unit: 'pcs',
    unitPrice: 0,
    discount: 0,
    taxRate: 0,
    taxAmount: 0,
    lineTotal: 0,
  }
}

const form = reactive({
  contactId: '',
  type: 'invoice' as string,
  direction: 'outgoing' as string,
  issueDate: new Date().toISOString().split('T')[0],
  dueDate: '',
  currency: baseCurrency.value,
  exchangeRate: 1,
  notes: '',
  terms: '',
  footer: '',
  billingAddress: emptyBillingAddress(),
  lines: [] as Line[],
  tags: [] as string[],
})

const { markSaved, tryRestore } = usePendingChanges({
  appId: 'invoicing',
  entityType: 'salesInvoice',
  icon: 'mdi-receipt-text-outline',
  getFormData: () => ({ ...form, lines: [...form.lines] }),
  getPreviewFields: () => [
    { label: 'Date', value: form.issueDate },
    { label: 'Currency', value: form.currency },
  ],
  setFormData: (data) => Object.assign(form, data),
  isEdit: () => isEdit.value,
  entityId: () => route.params.id as string,
})

const rules = {
  required: (v: string) => !!v || t('validation.required'),
}

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function fmtCurrency(amount: number) {
  return formatCurrency(amount, form.currency || baseCurrency.value, localeCode.value)
}

function addLine() {
  form.lines.push(emptyLine())
}

function onAddLedgerLines(ledgerEntries: any[]) {
  for (const entry of ledgerEntries) {
    form.lines.push({
      productId: entry.productId || undefined,
      description: entry.productName || '',
      quantity: entry.quantity || 1,
      unit: 'pcs',
      unitPrice: entry.unitPrice || 0,
      discount: 0,
      taxRate: entry.taxRate || 0,
      taxAmount: 0,
      lineTotal: 0,
      accountId: undefined,
      warehouseId: entry.warehouseId || undefined,
    })
  }
}

function removeLine(idx: number) {
  form.lines.splice(idx, 1)
}

function lineSubtotal(l: Line) {
  return l.quantity * l.unitPrice
}

function lineDiscount(l: Line) {
  return lineSubtotal(l) * (l.discount / 100)
}

function computeLineTaxAmount(l: Line) {
  return (lineSubtotal(l) - lineDiscount(l)) * (l.taxRate / 100)
}

function computeLineTotal(l: Line) {
  return lineSubtotal(l) - lineDiscount(l) + computeLineTaxAmount(l)
}

const subtotal = computed(() => form.lines.reduce((s, l) => s + lineSubtotal(l), 0))
const discountTotal = computed(() => form.lines.reduce((s, l) => s + lineDiscount(l), 0))
const taxTotal = computed(() => form.lines.reduce((s, l) => s + computeLineTaxAmount(l), 0))
const invoiceTotal = computed(() => form.lines.reduce((s, l) => s + computeLineTotal(l), 0))

function onLineUnitPriceChange(idx: number, price: number) {
  const line = form.lines[idx]
  if (!line) return
  line.unitPrice = price
  // If user manually changed from resolved, add override step
  if (line.resolvedPrice !== undefined && price !== line.resolvedPrice && line.priceExplanation?.length) {
    const steps = line.priceExplanation.filter(s => s.type !== 'override')
    steps.push({ type: 'override', label: 'User override', price })
    line.priceExplanation = steps
  }
}

function onContactCreated(contact: any) {
  contacts.value.push(contact)
  form.contactId = contact._id || contact.id
  onContactChange(form.contactId)
}

function onContactChange(contactId: string) {
  const contact = contacts.value.find((c) => c._id === contactId)
  if (!contact || !contact.addresses || contact.addresses.length === 0) return

  const billingAddr =
    contact.addresses.find((a) => a.type === 'billing' && a.isDefault) ||
    contact.addresses.find((a) => a.type === 'billing') ||
    contact.addresses.find((a) => a.isDefault) ||
    contact.addresses[0]

  if (billingAddr) {
    form.billingAddress.street = billingAddr.street || ''
    form.billingAddress.city = billingAddr.city || ''
    form.billingAddress.state = billingAddr.state || ''
    form.billingAddress.postalCode = billingAddr.postalCode || ''
    form.billingAddress.country = billingAddr.country || ''
  }
}

async function onProductSelected(idx: number, product: any) {
  const line = form.lines[idx]
  if (!line) return
  line.unitPrice = product.sellingPrice ?? 0
  line.unit = product.unit || line.unit
  line.taxRate = product.taxRate ?? line.taxRate

  if (line.productId) {
    await resolvePriceForLine(idx)
  }
}

function onProductCleared(idx: number) {
  const line = form.lines[idx]
  if (!line) return
  line.productId = undefined
  line.priceExplanation = undefined
  line.resolvedPrice = undefined
}

async function resolvePriceForLine(idx: number) {
  const line = form.lines[idx]
  if (!line?.productId) return

  try {
    const params: Record<string, string> = { productId: line.productId }
    if (form.contactId) params.contactId = form.contactId
    if (line.quantity) params.quantity = String(line.quantity)

    const { data } = await httpClient.get(`${orgUrl()}/pricing/resolve`, { params })
    line.unitPrice = data.finalPrice
    line.priceExplanation = data.steps
    line.resolvedPrice = data.finalPrice
  } catch {
    // Fallback: keep existing price, no explanation
  }
}

function buildPayloadLines(): any[] {
  return form.lines.map((l) => {
    const taxAmount = +(computeLineTaxAmount(l).toFixed(2))
    const lineTotal = +(computeLineTotal(l).toFixed(2))
    return {
      productId: l.productId || undefined,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      discount: l.discount,
      taxRate: l.taxRate,
      taxAmount,
      lineTotal,
      accountId: l.accountId || undefined,
      warehouseId: l.warehouseId || undefined,
      priceExplanation: l.priceExplanation || undefined,
    }
  })
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    const lines = buildPayloadLines()
    const computedSubtotal = +subtotal.value.toFixed(2)
    const computedDiscountTotal = +discountTotal.value.toFixed(2)
    const computedTaxTotal = +taxTotal.value.toFixed(2)
    const computedTotal = +invoiceTotal.value.toFixed(2)
    const exchangeRate = form.exchangeRate || 1
    const computedTotalBase = +(computedTotal * exchangeRate).toFixed(2)

    const payload: Record<string, any> = {
      contactId: form.contactId,
      type: form.type,
      direction: form.direction,
      issueDate: form.issueDate,
      dueDate: form.dueDate || form.issueDate,
      currency: form.currency,
      exchangeRate,
      lines,
      subtotal: computedSubtotal,
      discountTotal: computedDiscountTotal,
      taxTotal: computedTaxTotal,
      total: computedTotal,
      totalBase: computedTotalBase,
      notes: form.notes || undefined,
      terms: form.terms || undefined,
      footer: form.footer || undefined,
      billingAddress: {
        street: form.billingAddress.street,
        city: form.billingAddress.city,
        state: form.billingAddress.state || undefined,
        postalCode: form.billingAddress.postalCode,
        country: form.billingAddress.country,
      },
      tags: form.tags,
    }

    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
    } else {
      await httpClient.post(`${orgUrl()}/invoices`, payload)
    }
    markSaved()
    showSuccess(t('common.savedSuccessfully'))
    router.push({ name: 'invoicing.sales' })
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
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

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`)
    warehouses.value = data.warehouses || []
  } catch { /* */ }
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
      invoiceData.value = inv
      Object.assign(form, {
        contactId: inv.contactId?._id || inv.contactId || '',
        type: inv.type || 'invoice',
        direction: inv.direction || 'outgoing',
        issueDate: inv.issueDate?.split('T')[0] || '',
        dueDate: inv.dueDate?.split('T')[0] || '',
        currency: inv.currency || baseCurrency.value,
        exchangeRate: inv.exchangeRate || 1,
        notes: inv.notes || '',
        terms: inv.terms || '',
        footer: inv.footer || '',
        billingAddress: inv.billingAddress
          ? {
              street: inv.billingAddress.street || '',
              city: inv.billingAddress.city || '',
              state: inv.billingAddress.state || '',
              postalCode: inv.billingAddress.postalCode || '',
              country: inv.billingAddress.country || '',
            }
          : emptyBillingAddress(),
        tags: inv.tags || [],
        lines: (inv.lines || []).map((l: any) => ({
          productId: l.productId || undefined,
          description: l.description || '',
          quantity: l.quantity || 0,
          unit: l.unit || 'pcs',
          unitPrice: l.unitPrice || 0,
          discount: l.discount || 0,
          taxRate: l.taxRate || 0,
          taxAmount: l.taxAmount || 0,
          lineTotal: l.lineTotal || 0,
          accountId: l.accountId || undefined,
          warehouseId: l.warehouseId || undefined,
          priceExplanation: l.priceExplanation || undefined,
          resolvedPrice: l.unitPrice || undefined,
        })),
      })

    } catch {
      /* handle error */
    }
  }
})
</script>
