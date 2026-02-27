<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ isEdit ? $t('invoicing.editInvoice') : $t('invoicing.newInvoice') }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <!-- Header Fields -->
          <v-row>
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="form.contactId"
                :label="$t('invoicing.contact')"
                :items="contacts"
                item-title="companyName"
                item-value="_id"
                :rules="[rules.required]"
                :loading="loadingContacts"
                @update:model-value="onContactChange"
              />
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

          <!-- Billing Address -->
          <p class="text-subtitle-1 font-weight-bold mt-6 mb-2">{{ $t('invoicing.billingAddress') }}</p>
          <v-row>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="form.billingAddress.street"
                :label="$t('invoicing.street')"
                :rules="[rules.required]"
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="form.billingAddress.city"
                :label="$t('invoicing.city')"
                :rules="[rules.required]"
              />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="form.billingAddress.state"
                :label="$t('invoicing.state')"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="form.billingAddress.postalCode"
                :label="$t('invoicing.postalCode')"
                :rules="[rules.required]"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="form.billingAddress.country"
                :label="$t('invoicing.country')"
                :rules="[rules.required]"
              />
            </v-col>
          </v-row>

          <!-- Line Items -->
          <div class="d-flex align-center mt-6 mb-2">
            <p class="text-subtitle-1 font-weight-bold">{{ $t('invoicing.lineItems') }}</p>
            <v-spacer />
            <v-btn color="primary" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">
              {{ $t('invoicing.addLine') }}
            </v-btn>
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end" style="width:80px">{{ $t('invoicing.qty') }}</th>
                <th style="width:80px">{{ $t('invoicing.unit') }}</th>
                <th class="text-end" style="width:110px">{{ $t('invoicing.unitPrice') }}</th>
                <th class="text-end" style="width:80px">{{ $t('invoicing.discount') }}</th>
                <th class="text-end" style="width:80px">{{ $t('invoicing.taxRate') }}</th>
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
                <td>
                  <v-text-field v-model.number="line.quantity" type="number" min="0" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model="line.unit" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model.number="line.unitPrice" type="number" min="0" step="0.01" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model.number="line.discount" type="number" min="0" max="100" suffix="%" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model.number="line.taxRate" type="number" min="0" suffix="%" density="compact" hide-details variant="underlined" />
                </td>
                <td class="text-end">{{ fmtCurrency(computeLineTotal(line)) }}</td>
                <td>
                  <v-btn icon="mdi-close" size="x-small" variant="text" @click="form.lines.splice(idx, 1)" />
                </td>
              </tr>
            </tbody>
          </v-table>

          <!-- Totals -->
          <v-row class="mt-4">
            <v-col cols="12" md="6">
              <v-textarea v-model="form.notes" :label="$t('invoicing.notes')" rows="2" />
              <v-textarea v-model="form.terms" :label="$t('invoicing.terms')" rows="2" />
              <v-text-field v-model="form.footer" :label="$t('invoicing.footer')" />
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

          <div class="d-flex justify-end mt-4">
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
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ProductLineDescription from '../../components/ProductLineDescription.vue'

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
const { formatCurrency } = useCurrency()

const formRef = ref()
const loading = ref(false)
const loadingContacts = ref(false)
const contacts = ref<Contact[]>([])
const isEdit = computed(() => !!route.params.id)
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

function onContactChange(contactId: string) {
  const contact = contacts.value.find((c) => c._id === contactId)
  if (!contact || !contact.addresses || contact.addresses.length === 0) return

  // Find default billing address, or first billing address, or first address
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
    }
  })
}

function onProductSelected(idx: number, product: any) {
  const line = form.lines[idx]
  if (!line) return
  line.unitPrice = product.sellingPrice ?? 0
  line.unit = product.unit || line.unit
  line.taxRate = product.taxRate ?? line.taxRate
}

function onProductCleared(idx: number) {
  const line = form.lines[idx]
  if (!line) return
  line.productId = undefined
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
    }

    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
    } else {
      await httpClient.post(`${orgUrl()}/invoices`, payload)
    }
    router.push({ name: 'invoicing.sales' })
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

onMounted(async () => {
  await fetchContacts()
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${route.params.id}`)
      const inv = data.invoice
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
        })),
      })
    } catch {
      /* handle error */
    }
  }
})
</script>
