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
            <v-col cols="12" md="6">
              <v-text-field v-model="form.reference" :label="$t('invoicing.reference')" />
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
                <th>{{ $t('invoicing.product') }}</th>
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
                <td style="min-width:140px">
                  <v-text-field v-model="line.product" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model="line.description" density="compact" hide-details variant="underlined" />
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
                <td class="text-end">{{ fmtCurrency(lineTotal(line)) }}</td>
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
import { httpClient } from '../../composables/useHttpClient'
import { useCurrency } from '../../composables/useCurrency'
import { useSnackbar } from '../../composables/useSnackbar'
import { useValidation } from '../../composables/useValidation'

interface Line {
  product: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number
  taxRate: number
}

interface Contact {
  _id: string
  companyName: string
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const { showSuccess, showError } = useSnackbar()
const { rules } = useValidation()

const formRef = ref()
const loading = ref(false)
const loadingContacts = ref(false)
const contacts = ref<Contact[]>([])
const isEdit = computed(() => !!route.params.id)
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const form = reactive({
  contactId: '',
  issueDate: new Date().toISOString().split('T')[0],
  dueDate: '',
  currency: baseCurrency.value,
  exchangeRate: 1,
  reference: '',
  notes: '',
  terms: '',
  footer: '',
  lines: [] as Line[],
})

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function fmtCurrency(amount: number) {
  return formatCurrency(amount, form.currency || baseCurrency.value, localeCode.value)
}

function addLine() {
  form.lines.push({
    product: '',
    description: '',
    quantity: 1,
    unit: 'pcs',
    unitPrice: 0,
    discount: 0,
    taxRate: 0,
  })
}

function lineSubtotal(l: Line) {
  return l.quantity * l.unitPrice
}

function lineDiscount(l: Line) {
  return lineSubtotal(l) * (l.discount / 100)
}

function lineTax(l: Line) {
  return (lineSubtotal(l) - lineDiscount(l)) * (l.taxRate / 100)
}

function lineTotal(l: Line) {
  return lineSubtotal(l) - lineDiscount(l) + lineTax(l)
}

const subtotal = computed(() => form.lines.reduce((s, l) => s + lineSubtotal(l), 0))
const discountTotal = computed(() => form.lines.reduce((s, l) => s + lineDiscount(l), 0))
const taxTotal = computed(() => form.lines.reduce((s, l) => s + lineTax(l), 0))
const invoiceTotal = computed(() => form.lines.reduce((s, l) => s + lineTotal(l), 0))

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    const payload = {
      ...form,
      subtotal: subtotal.value,
      taxAmount: taxTotal.value,
      total: invoiceTotal.value,
      direction: 'outgoing',
      type: 'invoice',
    }
    if (isEdit.value) {
      await httpClient.put(`${orgUrl()}/invoices/${route.params.id}`, payload)
    } else {
      await httpClient.post(`${orgUrl()}/invoices`, payload)
    }
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

onMounted(async () => {
  await fetchContacts()
  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/invoices/${route.params.id}`)
      const inv = data.invoice
      Object.assign(form, {
        contactId: inv.contactId || '',
        issueDate: inv.issueDate?.split('T')[0] || '',
        dueDate: inv.dueDate?.split('T')[0] || '',
        currency: inv.currency || baseCurrency.value,
        exchangeRate: inv.exchangeRate || 1,
        reference: inv.reference || '',
        notes: inv.notes || '',
        terms: inv.terms || '',
        footer: inv.footer || '',
        lines: inv.lines || [],
      })
    } catch {
      /* handle error */
    }
  }
})
</script>
