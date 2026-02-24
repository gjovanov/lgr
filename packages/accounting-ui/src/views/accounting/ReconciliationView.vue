<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.reconciliation') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
    </div>

    <!-- Bank Account & Statement Inputs -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <v-col cols="12" md="4">
            <v-select
              v-model="selectedBankAccount"
              :label="$t('accounting.bankAccount')"
              :items="store.bankAccounts"
              item-title="name"
              item-value="_id"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model="statementDate"
              :label="$t('accounting.statementDate')"
              type="date"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field
              v-model.number="statementBalance"
              :label="$t('accounting.statementBalance')"
              type="number"
            />
          </v-col>
          <v-col cols="12" md="2" class="d-flex align-center">
            <v-btn color="primary" block :loading="loading" @click="loadTransactions">
              {{ $t('common.load') }}
            </v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Two-column matching view -->
    <v-row v-if="bankTxns.length > 0 || ledgerTxns.length > 0">
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title>{{ $t('accounting.bankTransactions') }}</v-card-title>
          <v-card-text>
            <v-list>
              <v-list-item
                v-for="txn in unmatchedBank"
                :key="txn._id"
                :class="{ 'bg-green-lighten-5': txn.selected }"
                @click="toggleItem(txn)"
              >
                <v-list-item-title>{{ txn.description }}</v-list-item-title>
                <v-list-item-subtitle>{{ txn.date?.split('T')[0] }}</v-list-item-subtitle>
                <template #prepend>
                  <v-checkbox-btn
                    :model-value="txn.selected"
                    @update:model-value="txn.selected = $event"
                  />
                </template>
                <template #append>
                  <span :class="txn.amount >= 0 ? 'text-success' : 'text-error'">
                    {{ formatCurrency(txn.amount, currency, localeCode) }}
                  </span>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title>{{ $t('accounting.ledgerTransactions') }}</v-card-title>
          <v-card-text>
            <v-list>
              <v-list-item
                v-for="txn in unmatchedLedger"
                :key="txn._id"
                :class="{ 'bg-green-lighten-5': txn.selected }"
                @click="toggleItem(txn)"
              >
                <v-list-item-title>{{ txn.description }}</v-list-item-title>
                <v-list-item-subtitle>{{ txn.date?.split('T')[0] }}</v-list-item-subtitle>
                <template #prepend>
                  <v-checkbox-btn
                    :model-value="txn.selected"
                    @update:model-value="txn.selected = $event"
                  />
                </template>
                <template #append>
                  <span :class="txn.amount >= 0 ? 'text-success' : 'text-error'">
                    {{ formatCurrency(txn.amount, currency, localeCode) }}
                  </span>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Summary & Actions -->
    <v-card v-if="bankTxns.length > 0" class="mt-4">
      <v-card-text class="d-flex justify-space-between align-center">
        <div>
          <span class="text-subtitle-1">{{ $t('accounting.difference') }}: </span>
          <span
            class="text-h6"
            :class="difference === 0 ? 'text-success' : 'text-error'"
          >
            {{ formatCurrency(difference, currency, localeCode) }}
          </span>
        </div>
        <div>
          <v-btn
            color="primary"
            class="mr-2"
            :disabled="!hasSelection"
            @click="matchSelected"
          >
            {{ $t('accounting.match') }}
          </v-btn>
          <v-btn
            color="success"
            :disabled="difference !== 0"
            @click="completeReconciliation"
          >
            {{ $t('accounting.complete') }}
          </v-btn>
        </div>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import ExportMenu from 'ui-shared/components/ExportMenu'

interface RecTxn {
  _id: string
  date: string
  description: string
  amount: number
  matched: boolean
  selected: boolean
}

const appStore = useAppStore()
const store = useAccountingStore()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const selectedBankAccount = ref('')
const statementDate = ref(new Date().toISOString().split('T')[0])
const statementBalance = ref(0)
const loading = ref(false)
const bankTxns = ref<RecTxn[]>([])
const ledgerTxns = ref<RecTxn[]>([])

const unmatchedBank = computed(() => bankTxns.value.filter(t => !t.matched))
const unmatchedLedger = computed(() => ledgerTxns.value.filter(t => !t.matched))
const hasSelection = computed(() =>
  bankTxns.value.some(t => t.selected) || ledgerTxns.value.some(t => t.selected)
)

const difference = computed(() => {
  const bTotal = unmatchedBank.value.reduce((s, t) => s + t.amount, 0)
  const lTotal = unmatchedLedger.value.reduce((s, t) => s + t.amount, 0)
  return Math.round((statementBalance.value - lTotal - bTotal) * 100) / 100
})

function orgUrl() {
  return `/org/${appStore.currentOrg?.id}`
}

function toggleItem(txn: RecTxn) {
  txn.selected = !txn.selected
}

async function loadTransactions() {
  if (!selectedBankAccount.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/accounting/reconciliation/transactions`, {
      params: { bankAccountId: selectedBankAccount.value, date: statementDate.value },
    })
    bankTxns.value = (data.bankTransactions || []).map((t: RecTxn) => ({ ...t, selected: false }))
    ledgerTxns.value = (data.ledgerTransactions || []).map((t: RecTxn) => ({ ...t, selected: false }))
  } finally {
    loading.value = false
  }
}

async function matchSelected() {
  const bIds = bankTxns.value.filter(t => t.selected).map(t => t._id)
  const lIds = ledgerTxns.value.filter(t => t.selected).map(t => t._id)
  await httpClient.post(`${orgUrl()}/accounting/reconciliation/match`, { bankIds: bIds, ledgerIds: lIds })
  bankTxns.value.filter(t => t.selected).forEach(t => { t.matched = true; t.selected = false })
  ledgerTxns.value.filter(t => t.selected).forEach(t => { t.matched = true; t.selected = false })
}

async function completeReconciliation() {
  await httpClient.post(`${orgUrl()}/accounting/reconciliation/complete`, {
    bankAccountId: selectedBankAccount.value,
    statementDate: statementDate.value,
    statementBalance: statementBalance.value,
  })
}

onMounted(() => {
  store.fetchBankAccounts()
})
</script>
