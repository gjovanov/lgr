<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.push({ name: 'pos.orders' })" />
      <h1 class="text-h5 ml-2">
        Transaction {{ transaction?.transactionNumber || '' }}
      </h1>
    </div>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <template v-if="transaction">
      <!-- Info Card -->
      <v-card class="mb-4">
        <v-card-title>Transaction Info</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Type</div>
              <v-chip size="small" label :color="typeColor(transaction.type)">{{ transaction.type }}</v-chip>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Status</div>
              <v-chip size="small" label :color="statusColor(transaction.status)">{{ transaction.status }}</v-chip>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">UNP Number</div>
              <div>{{ transaction.unpNumber || '-' }}</div>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Fiscal Receipt #</div>
              <div>{{ transaction.fiscalReceiptNumber || '-' }}</div>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Device Number</div>
              <div>{{ transaction.fiscalDeviceNumber || '-' }}</div>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Fiscal</div>
              <v-chip size="small" label :color="transaction.isFiscal ? 'success' : 'grey'">{{ transaction.isFiscal ? 'Yes' : 'No' }}</v-chip>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Created At</div>
              <div>{{ formatDateTime(transaction.createdAt) }}</div>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Printed At</div>
              <div>{{ transaction.printedAt ? formatDateTime(transaction.printedAt) : '-' }}</div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Storno Info -->
      <v-card v-if="transaction.type === 'storno'" class="mb-4">
        <v-card-title>Storno Details</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" md="4">
              <div class="text-caption text-medium-emphasis">Original Transaction</div>
              <entity-link
                v-if="transaction.originalTransactionId"
                :label="transaction.originalUNP || transaction.originalTransactionId"
                :to="{ name: 'pos.orders.detail', params: { id: transaction.originalTransactionId } }"
              />
              <span v-else>-</span>
            </v-col>
            <v-col cols="12" md="4">
              <div class="text-caption text-medium-emphasis">Original Fiscal Receipt #</div>
              <div>{{ transaction.originalFiscalReceiptNumber || '-' }}</div>
            </v-col>
            <v-col cols="12" md="4">
              <div class="text-caption text-medium-emphasis">Reason</div>
              <v-chip size="small" label color="error">{{ formatStornoReason(transaction.stornoReason) }}</v-chip>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Line Items -->
      <v-card class="mb-4">
        <v-card-title>Line Items</v-card-title>
        <v-card-text>
          <v-table density="compact">
            <thead>
              <tr>
                <th>Name</th>
                <th class="text-end">Qty</th>
                <th class="text-end">Unit Price</th>
                <th class="text-end">Discount %</th>
                <th class="text-end">Tax Rate %</th>
                <th class="text-end">Line Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, idx) in transaction.lines" :key="idx">
                <td>{{ line.name }}</td>
                <td class="text-end">{{ line.quantity }}</td>
                <td class="text-end">{{ fmtCurrency(line.unitPrice, undefined, 4) }}</td>
                <td class="text-end">{{ line.discount || 0 }}</td>
                <td class="text-end">{{ line.taxRate || 0 }}</td>
                <td class="text-end">{{ fmtCurrency(line.lineTotal) }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
      </v-card>

      <!-- Payments -->
      <v-card class="mb-4">
        <v-card-title>Payments</v-card-title>
        <v-card-text>
          <v-table density="compact">
            <thead>
              <tr>
                <th>Method</th>
                <th class="text-end">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(payment, idx) in transaction.payments" :key="idx">
                <td>{{ payment.method }}</td>
                <td class="text-end">{{ fmtCurrency(payment.amount) }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
      </v-card>

      <!-- Totals -->
      <v-card>
        <v-card-title>Totals</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Subtotal</div>
              <div class="text-h6">{{ fmtCurrency(transaction.subtotal) }}</div>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Discount</div>
              <div class="text-h6">{{ fmtCurrency(transaction.discountTotal) }}</div>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Tax</div>
              <div class="text-h6">{{ fmtCurrency(transaction.taxTotal) }}</div>
            </v-col>
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Total</div>
              <div class="text-h6 font-weight-bold">{{ fmtCurrency(transaction.total) }}</div>
            </v-col>
          </v-row>
          <v-row v-if="transaction.changeDue > 0">
            <v-col cols="12" md="3">
              <div class="text-caption text-medium-emphasis">Change Due</div>
              <div class="text-h6">{{ fmtCurrency(transaction.changeDue) }}</div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import EntityLink from 'ui-shared/components/EntityLink'

const route = useRoute()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const { showError } = useSnackbar()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const transaction = ref<any>(null)
const loading = ref(false)

function fmtCurrency(amount: number, currency?: string, maxDecimals = 2) {
  return formatCurrency(amount, currency || baseCurrency.value, localeCode.value, maxDecimals)
}

function formatDateTime(dateStr: string) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleString()
}

function typeColor(type: string) {
  const map: Record<string, string> = {
    sale: 'success',
    return: 'warning',
    exchange: 'info',
    storno: 'error',
  }
  return map[type] || 'grey'
}

function statusColor(s: string) {
  const map: Record<string, string> = {
    completed: 'success',
    cancelled: 'grey-darken-1',
  }
  return map[s] || 'grey'
}

function formatStornoReason(reason: string) {
  if (!reason) return '-'
  return reason.replace(/_/g, ' ')
}

async function fetchTransaction() {
  const id = route.params.id as string
  if (!id) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/trade/pos/transactions/${id}`)
    transaction.value = data.transaction
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Failed to load transaction')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchTransaction()
})
</script>
