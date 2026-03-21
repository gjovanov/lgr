<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ isEdit ? $t('sales.editOrder') : $t('sales.newOrder') }}</h1>
      <v-spacer />
      <v-chip v-if="isEdit && order" :color="stateColor(order.state)" class="ml-2" variant="tonal">
        {{ $t(`sales.state.${order.state}`) }}
      </v-chip>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <!-- Header Fields -->
          <v-row>
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="form.partnerId"
                :items="contacts"
                item-title="companyName"
                item-value="_id"
                :label="$t('sales.partner')"
                :rules="[rules.required]"
                :loading="loadingContacts"
                clearable
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.validityDate" :label="$t('sales.validityDate')" type="date" />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.commitmentDate" :label="$t('sales.commitmentDate')" type="date" />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="4">
              <v-select
                v-model="form.currency"
                :label="$t('common.currency')"
                :items="['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model.number="form.exchangeRate"
                :label="$t('invoicing.exchangeRate')"
                type="number"
                step="0.0001"
                min="0"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="1" auto-grow />
            </v-col>
          </v-row>

          <!-- Line Items -->
          <div class="d-flex align-center mt-6 mb-2">
            <p class="text-subtitle-1 font-weight-bold">{{ $t('sales.lineItems') }}</p>
            <v-spacer />
            <v-btn color="primary" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">
              {{ $t('sales.addLine') }}
            </v-btn>
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.product') }}</th>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end" style="width:80px">{{ $t('sales.qty') }}</th>
                <th style="width:80px">{{ $t('sales.uom') }}</th>
                <th class="text-end" style="width:110px">{{ $t('sales.priceUnit') }}</th>
                <th class="text-end" style="width:80px">{{ $t('sales.discount') }}</th>
                <th class="text-end" style="width:80px">{{ $t('sales.taxRate') }}</th>
                <th class="text-end" style="width:110px">{{ $t('sales.subtotal') }}</th>
                <th class="text-end" style="width:90px">{{ $t('sales.tax') }}</th>
                <th class="text-end" style="width:110px">{{ $t('common.total') }}</th>
                <th style="width:40px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, idx) in form.lines" :key="idx">
                <td style="min-width:180px">
                  <v-autocomplete
                    v-model="line.productId"
                    :items="products"
                    item-title="name"
                    item-value="_id"
                    density="compact"
                    hide-details
                    variant="underlined"
                    clearable
                    @update:model-value="onProductSelected(idx)"
                  />
                </td>
                <td style="min-width:150px">
                  <v-text-field v-model="line.name" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model.number="line.quantity" type="number" min="0" step="0.001" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model="line.uom" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model.number="line.priceUnit" type="number" min="0" step="0.01" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model.number="line.discount" type="number" min="0" max="100" suffix="%" density="compact" hide-details variant="underlined" />
                </td>
                <td>
                  <v-text-field v-model.number="line.taxRate" type="number" min="0" suffix="%" density="compact" hide-details variant="underlined" />
                </td>
                <td class="text-end">{{ fmtCurrency(lineSubtotal(line)) }}</td>
                <td class="text-end">{{ fmtCurrency(lineTaxAmount(line)) }}</td>
                <td class="text-end font-weight-medium">{{ fmtCurrency(lineTotal(line)) }}</td>
                <td>
                  <v-btn icon="mdi-close" size="x-small" variant="text" @click="removeLine(idx)" />
                </td>
              </tr>
            </tbody>
          </v-table>

          <!-- Totals -->
          <v-row class="mt-4">
            <v-col cols="12" md="6">
              <v-textarea v-model="form.termsAndConditions" :label="$t('sales.termsAndConditions')" rows="2" />
            </v-col>
            <v-col cols="12" md="6">
              <v-card variant="outlined">
                <v-card-text>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('sales.amountUntaxed') }}</span>
                    <span class="font-weight-medium">{{ fmtCurrency(amountUntaxed) }}</span>
                  </div>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('sales.amountTax') }}</span>
                    <span>{{ fmtCurrency(amountTax) }}</span>
                  </div>
                  <v-divider class="my-2" />
                  <div class="d-flex justify-space-between text-h6">
                    <span>{{ $t('common.total') }}</span>
                    <span>{{ fmtCurrency(amountTotal) }}</span>
                  </div>
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>

          <!-- Action Buttons -->
          <div class="d-flex justify-end mt-4 ga-2">
            <v-btn variant="text" @click="router.back()">{{ $t('common.cancel') }}</v-btn>

            <!-- State-dependent actions -->
            <template v-if="isEdit && order">
              <v-btn
                v-if="order.state === 'draft'"
                color="info"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('send')"
              >{{ $t('sales.sendQuotation') }}</v-btn>

              <v-btn
                v-if="order.state === 'draft' || order.state === 'sent'"
                color="success"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('confirm')"
              >{{ $t('sales.confirmOrder') }}</v-btn>

              <v-btn
                v-if="order.state === 'confirmed'"
                color="primary"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('invoice')"
              >{{ $t('sales.createInvoice') }}</v-btn>

              <v-btn
                v-if="['draft', 'sent', 'confirmed'].includes(order.state)"
                color="error"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('cancel')"
              >{{ $t('common.cancel') }}</v-btn>

              <v-btn
                v-if="order.invoiceStatus === 'invoiced'"
                color="primary"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('done')"
              >{{ $t('sales.markDone') }}</v-btn>
            </template>

            <v-btn
              v-if="!isEdit || (order && (order.state === 'draft' || order.state === 'sent'))"
              type="submit"
              color="primary"
              :loading="loading"
            >{{ $t('common.save') }}</v-btn>
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
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'

interface Line {
  productId?: string
  name: string
  quantity: number
  uom: string
  priceUnit: number
  discount: number
  taxRate: number
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

const formRef = ref()
const loading = ref(false)
const actionLoading = ref(false)
const loadingContacts = ref(false)
const contacts = ref<any[]>([])
const products = ref<any[]>([])
const order = ref<any>(null)
const isEdit = computed(() => !!route.params.id)
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

function emptyLine(): Line {
  return { name: '', quantity: 1, uom: 'pcs', priceUnit: 0, discount: 0, taxRate: 0 }
}

const form = reactive({
  partnerId: '',
  validityDate: '',
  commitmentDate: '',
  currency: 'EUR',
  exchangeRate: 1,
  notes: '',
  termsAndConditions: '',
  lines: [] as Line[],
  tags: [] as string[],
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

function removeLine(idx: number) {
  form.lines.splice(idx, 1)
}

function lineSubtotal(l: Line) {
  return l.quantity * l.priceUnit * (1 - (l.discount || 0) / 100)
}

function lineTaxAmount(l: Line) {
  return lineSubtotal(l) * (l.taxRate || 0) / 100
}

function lineTotal(l: Line) {
  return lineSubtotal(l) + lineTaxAmount(l)
}

const amountUntaxed = computed(() => form.lines.reduce((s, l) => s + lineSubtotal(l), 0))
const amountTax = computed(() => form.lines.reduce((s, l) => s + lineTaxAmount(l), 0))
const amountTotal = computed(() => amountUntaxed.value + amountTax.value)

function onProductSelected(idx: number) {
  const line = form.lines[idx]
  if (!line?.productId) return
  const product = products.value.find(p => p._id === line.productId)
  if (product) {
    line.name = product.name || ''
    line.priceUnit = product.sellingPrice ?? 0
    line.uom = product.unit || line.uom
    line.taxRate = product.taxRate ?? line.taxRate
  }
}

function stateColor(state: string): string {
  switch (state) {
    case 'draft': return 'grey'
    case 'sent': return 'info'
    case 'confirmed': return 'success'
    case 'done': return 'primary'
    case 'cancelled': return 'error'
    default: return 'grey'
  }
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    const payload: Record<string, any> = {
      partnerId: form.partnerId,
      currency: form.currency,
      exchangeRate: form.exchangeRate || 1,
      notes: form.notes || undefined,
      termsAndConditions: form.termsAndConditions || undefined,
      tags: form.tags,
      lines: form.lines.map(l => ({
        productId: l.productId || undefined,
        name: l.name,
        quantity: l.quantity,
        uom: l.uom,
        priceUnit: l.priceUnit,
        discount: l.discount || 0,
        taxRate: l.taxRate || 0,
      })),
    }
    if (form.validityDate) payload.validityDate = form.validityDate
    if (form.commitmentDate) payload.commitmentDate = form.commitmentDate

    if (isEdit.value) {
      const result = await httpClient.put(`${orgUrl()}/sales/orders/${route.params.id}`, payload)
      order.value = result.data
    } else {
      const result = await httpClient.post(`${orgUrl()}/sales/orders`, payload)
      order.value = result.data
    }
    showSuccess(t('common.savedSuccessfully'))
    if (!isEdit.value && order.value) {
      router.replace({ name: 'sales.orders.edit', params: { id: order.value._id || order.value.id } })
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function doAction(action: string) {
  actionLoading.value = true
  try {
    const id = route.params.id as string
    const { data } = await httpClient.post(`${orgUrl()}/sales/orders/${id}/${action}`)
    order.value = data
    showSuccess(t('common.operationSuccessful'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    actionLoading.value = false
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

async function fetchProducts() {
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/product`, { params: { size: 100 } })
    products.value = data.products || []
  } catch { /* */ }
}

onMounted(async () => {
  form.currency = baseCurrency.value
  await Promise.all([fetchContacts(), fetchProducts()])

  if (isEdit.value) {
    try {
      const { data } = await httpClient.get(`${orgUrl()}/sales/orders/${route.params.id}`)
      order.value = data
      Object.assign(form, {
        partnerId: data.partnerId || '',
        validityDate: data.validityDate?.split('T')[0] || '',
        commitmentDate: data.commitmentDate?.split('T')[0] || '',
        currency: data.currency || baseCurrency.value,
        exchangeRate: data.exchangeRate || 1,
        notes: data.notes || '',
        termsAndConditions: data.termsAndConditions || '',
        tags: data.tags || [],
        lines: (data.lines || []).map((l: any) => ({
          productId: l.productId || undefined,
          name: l.name || '',
          quantity: l.quantity || 1,
          uom: l.uom || 'pcs',
          priceUnit: l.priceUnit || 0,
          discount: l.discount || 0,
          taxRate: l.taxRate || 0,
        })),
      })
    } catch { /* */ }
  }
})
</script>
