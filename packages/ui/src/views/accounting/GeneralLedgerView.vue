<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.generalLedger') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="4">
            <v-select
              v-model="selectedAccount"
              :label="$t('accounting.account')"
              :items="accountOptions"
              item-title="label"
              item-value="_id"
              clearable
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="dateFrom"
              :label="$t('common.dateFrom')"
              type="date"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="dateTo"
              :label="$t('common.dateTo')"
              type="date"
            />
          </v-col>
          <v-col cols="12" md="2" class="d-flex align-center">
            <v-btn color="primary" block :loading="loading" @click="fetchLedger">
              {{ $t('common.filter') }}
            </v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Ledger Table -->
    <v-card>
      <v-card-text>
        <v-data-table
          :headers="headers"
          :items="ledgerItems"
          :loading="loading"
        >
          <template #item.date="{ item }">
            {{ item.date?.split('T')[0] }}
          </template>
          <template #item.debit="{ item }">
            {{ item.debit ? formatCurrency(item.debit, currency, localeCode) : '' }}
          </template>
          <template #item.credit="{ item }">
            {{ item.credit ? formatCurrency(item.credit, currency, localeCode) : '' }}
          </template>
          <template #item.balance="{ item }">
            {{ formatCurrency(item.balance, currency, localeCode) }}
          </template>
          <template #bottom>
            <tr v-if="ledgerItems.length > 0" class="font-weight-bold bg-grey-lighten-4">
              <td colspan="3" class="text-subtitle-2 pa-3">{{ $t('common.total') }}</td>
              <td class="text-end text-subtitle-2 pa-3">
                {{ formatCurrency(totals.debit, currency, localeCode) }}
              </td>
              <td class="text-end text-subtitle-2 pa-3">
                {{ formatCurrency(totals.credit, currency, localeCode) }}
              </td>
              <td class="text-end text-subtitle-2 pa-3">
                {{ formatCurrency(totals.balance, currency, localeCode) }}
              </td>
            </tr>
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { httpClient } from '../../composables/useHttpClient'
import { formatCurrency } from '../../composables/useCurrency'
import { useSnackbar } from '../../composables/useSnackbar'
import ExportMenu from '../../components/shared/ExportMenu.vue'

const appStore = useAppStore()
const store = useAccountingStore()
const { t } = useI18n()
const { showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const selectedAccount = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const loading = ref(false)

interface LedgerItem {
  date: string
  entryNumber: string
  description: string
  debit: number
  credit: number
  balance: number
}

const ledgerItems = ref<LedgerItem[]>([])

const accountOptions = computed(() =>
  store.accounts.map(a => ({ _id: a._id, label: `${a.code} - ${a.name}` }))
)

const headers = [
  { title: 'Date', key: 'date' },
  { title: 'Entry #', key: 'entryNumber' },
  { title: 'Description', key: 'description' },
  { title: 'Debit', key: 'debit', align: 'end' as const },
  { title: 'Credit', key: 'credit', align: 'end' as const },
  { title: 'Balance', key: 'balance', align: 'end' as const },
]

const totals = computed(() => {
  const debit = ledgerItems.value.reduce((s, i) => s + (i.debit || 0), 0)
  const credit = ledgerItems.value.reduce((s, i) => s + (i.credit || 0), 0)
  const last = ledgerItems.value[ledgerItems.value.length - 1]
  return { debit, credit, balance: last?.balance || 0 }
})

async function fetchLedger() {
  if (!selectedAccount.value) return
  loading.value = true
  try {
    const orgId = appStore.currentOrg?.id
    const { data } = await httpClient.get(`/org/${orgId}/reports/general-ledger`, {
      params: {
        accountId: selectedAccount.value,
        dateFrom: dateFrom.value || undefined,
        dateTo: dateTo.value || undefined,
      },
    })
    ledgerItems.value = data.items || []
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  store.fetchAccounts()
})
</script>
