<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ isEdit ? $t('purchase.editOrder') : $t('purchase.newOrder') }}</h1>
      <v-spacer />
      <v-chip v-if="isEdit && order" :color="stateColor(order.state)" class="ml-2" variant="tonal">
        {{ $t(`purchase.state.${order.state}`) }}
      </v-chip>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef" @submit.prevent="handleSubmit">
          <!-- Header Fields -->
          <v-row>
            <v-col cols="12" md="4">
              <v-autocomplete
                v-model="form.vendorId"
                :items="contacts"
                item-title="companyName"
                item-value="_id"
                :label="$t('purchase.vendor')"
                :rules="[rules.required]"
                :loading="loadingContacts"
                clearable
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field v-model="form.datePlanned" :label="$t('purchase.datePlanned')" type="date" />
            </v-col>
            <v-col cols="12" md="4">
              <v-select
                v-model="form.currency"
                :label="$t('common.currency')"
                :items="['EUR', 'USD', 'GBP', 'CHF', 'MKD', 'BGN', 'RSD']"
              />
            </v-col>
          </v-row>
          <v-row>
            <v-col cols="12" md="4">
              <v-text-field
                v-model.number="form.exchangeRate"
                :label="$t('invoicing.exchangeRate')"
                type="number"
                step="0.0001"
                min="0"
              />
            </v-col>
            <v-col cols="12" md="8">
              <v-textarea v-model="form.notes" :label="$t('common.notes')" rows="1" auto-grow />
            </v-col>
          </v-row>

          <!-- Line Items -->
          <div class="d-flex align-center mt-6 mb-2">
            <p class="text-subtitle-1 font-weight-bold">{{ $t('purchase.lineItems') }}</p>
            <v-spacer />
            <v-btn color="primary" variant="outlined" size="small" prepend-icon="mdi-plus" @click="addLine">
              {{ $t('purchase.addLine') }}
            </v-btn>
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.product') }}</th>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end" style="width:80px">{{ $t('purchase.qty') }}</th>
                <th style="width:80px">{{ $t('purchase.uom') }}</th>
                <th class="text-end" style="width:110px">{{ $t('purchase.priceUnit') }}</th>
                <th class="text-end" style="width:80px">{{ $t('purchase.taxRate') }}</th>
                <th class="text-end" style="width:110px">{{ $t('purchase.subtotal') }}</th>
                <th class="text-end" style="width:90px">{{ $t('purchase.tax') }}</th>
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
            <v-col cols="12" md="6" />
            <v-col cols="12" md="6">
              <v-card variant="outlined">
                <v-card-text>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('purchase.amountUntaxed') }}</span>
                    <span class="font-weight-medium">{{ fmtCurrency(amountUntaxed) }}</span>
                  </div>
                  <div class="d-flex justify-space-between mb-2">
                    <span>{{ $t('purchase.amountTax') }}</span>
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

            <template v-if="isEdit && order">
              <v-btn
                v-if="order.state === 'draft'"
                color="info"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('send')"
              >{{ $t('purchase.sendRFQ') }}</v-btn>

              <v-btn
                v-if="order.state === 'draft' || order.state === 'sent'"
                color="warning"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('request-approval')"
              >{{ $t('purchase.requestApproval') }}</v-btn>

              <v-btn
                v-if="order.state === 'to_approve'"
                color="success"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('approve')"
              >{{ $t('purchase.approve') }}</v-btn>

              <v-btn
                v-if="order.state === 'to_approve'"
                color="error"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('reject')"
              >{{ $t('purchase.reject') }}</v-btn>

              <v-btn
                v-if="order.state === 'draft' || order.state === 'sent'"
                color="success"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('confirm')"
              >{{ $t('purchase.confirmOrder') }}</v-btn>

              <v-btn
                v-if="order.state === 'confirmed' && order.receiptStatus !== 'received'"
                color="primary"
                variant="outlined"
                :loading="actionLoading"
                @click="receiptDialog = true"
              >{{ $t('purchase.recordReceipt') }}</v-btn>

              <v-btn
                v-if="order.state === 'confirmed'"
                color="primary"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('bill')"
              >{{ $t('purchase.createBill') }}</v-btn>

              <v-btn
                v-if="['draft', 'sent', 'to_approve', 'confirmed'].includes(order.state)"
                color="error"
                variant="outlined"
                :loading="actionLoading"
                @click="doAction('cancel')"
              >{{ $t('purchase.cancelOrder') }}</v-btn>
            </template>

            <v-btn
              v-if="!isEdit || (order && ['draft', 'sent'].includes(order.state))"
              type="submit"
              color="primary"
              :loading="loading"
            >{{ $t('common.save') }}</v-btn>
          </div>
        </v-form>
      </v-card-text>
    </v-card>

    <!-- Receipt Dialog -->
    <v-dialog v-model="receiptDialog" max-width="700" persistent>
      <v-card>
        <v-card-title>{{ $t('purchase.recordReceipt') }}</v-card-title>
        <v-card-text>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('common.product') }}</th>
                <th>{{ $t('common.description') }}</th>
                <th class="text-end">{{ $t('purchase.qtyOrdered') }}</th>
                <th class="text-end">{{ $t('purchase.qtyReceived') }}</th>
                <th class="text-end" style="width:120px">{{ $t('purchase.newQtyReceived') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, idx) in receiptLines" :key="idx">
                <td>{{ getProductName(line.productId) }}</td>
                <td>{{ line.name }}</td>
                <td class="text-end">{{ line.quantity }}</td>
                <td class="text-end">{{ line.qtyReceived || 0 }}</td>
                <td>
                  <v-text-field
                    v-model.number="line.newQtyReceived"
                    type="number"
                    min="0"
                    :max="line.quantity - (line.qtyReceived || 0)"
                    density="compact"
                    hide-details
                    variant="underlined"
                  />
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="receiptDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="actionLoading" @click="doRecordReceipt">{{ $t('purchase.confirm') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
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
  taxRate: number
}

interface ReceiptLine {
  productId?: string
  name: string
  quantity: number
  qtyReceived: number
  newQtyReceived: number
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
const receiptDialog = ref(false)
const receiptLines = ref<ReceiptLine[]>([])
const isEdit = computed(() => !!route.params.id)
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

function emptyLine(): Line {
  return { name: '', quantity: 1, uom: 'pcs', priceUnit: 0, taxRate: 0 }
}

const form = reactive({
  vendorId: '',
  datePlanned: '',
  currency: 'EUR',
  exchangeRate: 1,
  notes: '',
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
  return l.quantity * l.priceUnit
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
    line.priceUnit = product.purchasePrice ?? 0
    line.uom = product.unit || line.uom
    line.taxRate = product.taxRate ?? line.taxRate
  }
}

function getProductName(productId?: string) {
  if (!productId) return '-'
  const p = products.value.find(pr => pr._id === productId)
  return p?.name || productId
}

function stateColor(state: string): string {
  switch (state) {
    case 'draft': return 'grey'
    case 'sent': return 'info'
    case 'to_approve': return 'warning'
    case 'confirmed': return 'success'
    case 'done': return 'primary'
    case 'cancelled': return 'error'
    default: return 'grey'
  }
}

function buildReceiptLines() {
  if (!order.value?.lines) return
  receiptLines.value = order.value.lines
    .filter((l: any) => l.productId)
    .map((l: any) => ({
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      qtyReceived: l.qtyReceived || 0,
      newQtyReceived: l.quantity - (l.qtyReceived || 0),
    }))
}

async function handleSubmit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return

  loading.value = true
  try {
    const payload: Record<string, any> = {
      vendorId: form.vendorId,
      currency: form.currency,
      exchangeRate: form.exchangeRate || 1,
      notes: form.notes || undefined,
      tags: form.tags,
      lines: form.lines.map(l => ({
        productId: l.productId || undefined,
        name: l.name,
        quantity: l.quantity,
        uom: l.uom,
        priceUnit: l.priceUnit,
        taxRate: l.taxRate || 0,
      })),
    }
    if (form.datePlanned) payload.datePlanned = form.datePlanned

    if (isEdit.value) {
      const result = await httpClient.put(`${orgUrl()}/purchase/orders/${route.params.id}`, payload)
      order.value = result.data
    } else {
      const result = await httpClient.post(`${orgUrl()}/purchase/orders`, payload)
      order.value = result.data
    }
    showSuccess(t('common.savedSuccessfully'))
    if (!isEdit.value && order.value) {
      router.replace({ name: 'purchase.orders.edit', params: { id: order.value._id || order.value.id } })
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
    const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/${action}`)
    order.value = data
    buildReceiptLines()
    showSuccess(t('common.operationSuccessful'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    actionLoading.value = false
  }
}

async function doRecordReceipt() {
  actionLoading.value = true
  try {
    const id = route.params.id as string
    const lines = receiptLines.value
      .filter(l => l.newQtyReceived > 0 && l.productId)
      .map(l => ({ productId: l.productId!, qtyReceived: l.newQtyReceived }))

    if (!lines.length) {
      showError(t('purchase.noReceiptLines'))
      actionLoading.value = false
      return
    }

    const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/receive`, { lines })
    order.value = data
    buildReceiptLines()
    receiptDialog.value = false
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
      const { data } = await httpClient.get(`${orgUrl()}/purchase/orders/${route.params.id}`)
      order.value = data
      Object.assign(form, {
        vendorId: data.vendorId || '',
        datePlanned: data.datePlanned?.split('T')[0] || '',
        currency: data.currency || baseCurrency.value,
        exchangeRate: data.exchangeRate || 1,
        notes: data.notes || '',
        tags: data.tags || [],
        lines: (data.lines || []).map((l: any) => ({
          productId: l.productId || undefined,
          name: l.name || '',
          quantity: l.quantity || 1,
          uom: l.uom || 'pcs',
          priceUnit: l.priceUnit || 0,
          taxRate: l.taxRate || 0,
        })),
      })
      buildReceiptLines()
    } catch { /* */ }
  }
})
</script>
