<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.reconciliation') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
        <!-- #675: the bank's lines come from a statement file, or are entered by hand where there is none. -->
        <v-btn
          v-cap="['reconciliation.create', 'reconciliation.edit']"
          variant="outlined"
          prepend-icon="mdi-file-upload-outline"
          :disabled="!selectedBankAccount"
          :loading="importing"
          data-testid="rec-import"
          @click="fileInput?.click()"
        >
          {{ $t('accounting.reconciliationUi.importStatement') }}
        </v-btn>
        <v-btn
          v-cap="['reconciliation.create', 'reconciliation.edit']"
          variant="outlined"
          prepend-icon="mdi-plus"
          :disabled="!selectedBankAccount"
          data-testid="rec-add-line"
          @click="openLineDialog"
        >
          {{ $t('accounting.reconciliationUi.addLine') }}
        </v-btn>
        <input ref="fileInput" type="file" accept=".csv,.txt,text/csv,text/plain" class="d-none" @change="importFile">
      </div>
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
              @update:model-value="loadTransactions"
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
            <v-btn color="primary" block :loading="loading" :disabled="!selectedBankAccount" @click="loadTransactions">
              {{ $t('common.load') }}
            </v-btn>
          </v-col>
        </v-row>
        <p class="text-caption text-medium-emphasis mb-0">{{ $t('accounting.reconciliationUi.importHint') }}</p>
      </v-card-text>
    </v-card>

    <!-- Two-column matching view -->
    <v-row v-if="loaded">
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title>{{ $t('accounting.bankTransactions') }}</v-card-title>
          <v-card-text>
            <p v-if="!unmatchedBank.length" class="text-body-2 text-medium-emphasis">{{ $t('accounting.reconciliationUi.noBankLines') }}</p>
            <v-list>
              <v-list-item
                v-for="txn in unmatchedBank"
                :key="txn._id"
                :class="{ 'bg-green-lighten-5': txn.selected }"
                data-testid="rec-bank-line"
                @click="toggleItem(txn)"
              >
                <v-list-item-title>{{ txn.description }}</v-list-item-title>
                <v-list-item-subtitle>{{ txn.date?.split('T')[0] }}<span v-if="txn.bankReference"> · {{ txn.bankReference }}</span></v-list-item-subtitle>
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
                  <v-btn
                    v-cap="['reconciliation.create', 'reconciliation.edit']"
                    icon="mdi-delete-outline"
                    size="small"
                    variant="text"
                    :title="$t('accounting.reconciliationUi.removeLine')"
                    @click.stop="removeLine(txn)"
                  />
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
                data-testid="rec-ledger-line"
                @click="toggleItem(txn)"
              >
                <v-list-item-title>{{ txn.description }}</v-list-item-title>
                <v-list-item-subtitle>{{ txn.date?.split('T')[0] }}<span v-if="txn.reference"> · {{ txn.reference }}</span></v-list-item-subtitle>
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

    <!-- What is matched, and a way to undo it -->
    <v-card v-if="loaded && matchedBank.length" class="mt-4">
      <v-card-title>{{ $t('accounting.reconciliationUi.matched') }}</v-card-title>
      <v-card-text>
        <v-list density="compact">
          <v-list-item v-for="txn in matchedBank" :key="txn._id" :title="txn.description" :subtitle="txn.date?.split('T')[0]">
            <template #append>
              <span class="mr-2">{{ formatCurrency(txn.amount, currency, localeCode) }}</span>
              <v-btn v-cap="['reconciliation.create', 'reconciliation.edit']" size="small" variant="text" @click="unmatch(txn)">
                {{ $t('accounting.reconciliationUi.unmatch') }}
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>

    <!-- Summary & Actions -->
    <v-card v-if="loaded" class="mt-4">
      <v-card-text class="d-flex justify-space-between align-center flex-wrap ga-2">
        <div>
          <span class="text-subtitle-1">{{ $t('accounting.reconciliationUi.bookBalance') }}: </span>
          <span class="text-subtitle-1 mr-6">{{ formatCurrency(bookBalance, currency, localeCode) }}</span>
          <span class="text-subtitle-1">{{ $t('accounting.difference') }}: </span>
          <span class="text-h6" :class="difference === 0 ? 'text-success' : 'text-error'" data-testid="rec-difference">
            {{ formatCurrency(difference, currency, localeCode) }}
          </span>
        </div>
        <div>
          <v-btn
            v-cap="['reconciliation.create', 'reconciliation.edit']"
            color="primary"
            class="mr-2"
            :disabled="!hasSelection"
            @click="matchSelected"
          >
            {{ $t('accounting.match') }}
          </v-btn>
          <v-btn
            v-cap="['reconciliation.create', 'reconciliation.edit']"
            color="success"
            :disabled="difference !== 0 || !reconciliationId"
            @click="completeReconciliation"
          >
            {{ $t('accounting.complete') }}
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- A bank line entered by hand -->
    <v-dialog v-model="lineDialog" max-width="480">
      <v-card>
        <v-card-title>{{ $t('accounting.reconciliationUi.addLine') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="line.date" :label="$t('accounting.reconciliationUi.lineDate')" type="date" density="compact" />
          <v-text-field v-model="line.description" :label="$t('accounting.reconciliationUi.lineDescription')" density="compact" />
          <v-text-field
            v-model.number="line.amount"
            :label="$t('accounting.reconciliationUi.lineAmount')"
            :hint="$t('accounting.reconciliationUi.lineAmountHint')"
            persistent-hint
            type="number"
            density="compact"
          />
          <v-text-field v-model="line.bankReference" :label="$t('accounting.reconciliationUi.lineReference')" density="compact" class="mt-2" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="lineDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :disabled="!line.date || !line.description || !line.amount" :loading="saving" @click="addLine">
            {{ $t('common.save') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ExportMenu from 'ui-shared/components/ExportMenu'

interface RecTxn {
  _id: string
  date: string
  description: string
  amount: number
  matched: boolean
  selected: boolean
  bankReference?: string
  reference?: string
}

const { t } = useI18n()
const appStore = useAppStore()
const store = useAccountingStore()
const { showSuccess, showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }
  return map[appStore.locale] || 'en-US'
})

const selectedBankAccount = ref('')
const statementDate = ref(new Date().toISOString().split('T')[0])
const statementBalance = ref(0)
const loading = ref(false)
const loaded = ref(false)
const importing = ref(false)
const saving = ref(false)
const reconciliationId = ref<string | null>(null)
const bookBalance = ref(0)
const bankTxns = ref<RecTxn[]>([])
const ledgerTxns = ref<RecTxn[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

const unmatchedBank = computed(() => bankTxns.value.filter(x => !x.matched))
const matchedBank = computed(() => bankTxns.value.filter(x => x.matched))
const unmatchedLedger = computed(() => ledgerTxns.value.filter(x => !x.matched))
const hasSelection = computed(() =>
  bankTxns.value.some(x => x.selected) && ledgerTxns.value.some(x => x.selected)
)

/**
 * #675, as the server completes it: (statement balance − ledger lines not on the statement) − (book balance + bank
 * lines not in the ledger). Zero: the reconciliation balances.
 */
const difference = computed(() => {
  const openLedger = unmatchedLedger.value.reduce((s, x) => s + x.amount, 0)
  const openBank = unmatchedBank.value.reduce((s, x) => s + x.amount, 0)
  return Math.round(((Number(statementBalance.value) || 0) - openLedger - (bookBalance.value + openBank)) * 100) / 100
})

const url = () => `/org/${appStore.currentOrg?.id}/accounting/reconciliation`
const fail = (e: any) => showError(e?.response?.data?.message || t('common.operationFailed'))

function toggleItem(txn: RecTxn) {
  txn.selected = !txn.selected
}

async function loadTransactions() {
  if (!selectedBankAccount.value) return
  loading.value = true
  try {
    const { data } = await httpClient.get(`${url()}/transactions`, {
      params: { bankAccountId: selectedBankAccount.value, date: statementDate.value },
    })
    reconciliationId.value = data.reconciliationId
    bookBalance.value = data.bookBalance || 0
    bankTxns.value = (data.bankTransactions || []).map((x: RecTxn) => ({ ...x, selected: false }))
    ledgerTxns.value = (data.ledgerTransactions || []).map((x: RecTxn) => ({ ...x, selected: false }))
    loaded.value = true
  } catch (e) {
    fail(e)
  } finally {
    loading.value = false
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !selectedBankAccount.value) return
  importing.value = true
  try {
    const content = await file.text()
    const { data } = await httpClient.post(`${url()}/import`, { bankAccountId: selectedBankAccount.value, statementDate: statementDate.value, content })
    showSuccess(t('accounting.reconciliationUi.imported', { added: data.added, skipped: data.skipped, unrecognized: data.unrecognized }))
    await loadTransactions()
  } catch (e) {
    fail(e)
  } finally {
    importing.value = false
  }
}

const lineDialog = ref(false)
const line = reactive({ date: '', description: '', amount: 0, bankReference: '' })
function openLineDialog() {
  Object.assign(line, { date: statementDate.value, description: '', amount: 0, bankReference: '' })
  lineDialog.value = true
}

async function addLine() {
  saving.value = true
  try {
    await httpClient.post(`${url()}/lines`, {
      bankAccountId: selectedBankAccount.value,
      statementDate: statementDate.value,
      line: { date: line.date, description: line.description, amount: Number(line.amount), ...(line.bankReference ? { bankReference: line.bankReference } : {}) },
    })
    lineDialog.value = false
    await loadTransactions()
  } catch (e) {
    fail(e)
  } finally {
    saving.value = false
  }
}

async function removeLine(txn: RecTxn) {
  try {
    await httpClient.delete(`${url()}/lines/${txn._id}`, { params: { bankAccountId: selectedBankAccount.value } })
    await loadTransactions()
  } catch (e) {
    fail(e)
  }
}

async function matchSelected() {
  try {
    await httpClient.post(`${url()}/match`, {
      bankAccountId: selectedBankAccount.value,
      bankIds: bankTxns.value.filter(x => x.selected).map(x => x._id),
      ledgerIds: ledgerTxns.value.filter(x => x.selected).map(x => x._id),
    })
    await loadTransactions()
  } catch (e) {
    fail(e)
  }
}

async function unmatch(txn: RecTxn) {
  try {
    await httpClient.post(`${url()}/unmatch`, { bankAccountId: selectedBankAccount.value, bankIds: [txn._id] })
    await loadTransactions()
  } catch (e) {
    fail(e)
  }
}

async function completeReconciliation() {
  try {
    await httpClient.post(`${url()}/complete`, {
      bankAccountId: selectedBankAccount.value,
      statementDate: statementDate.value,
      statementBalance: Number(statementBalance.value) || 0,
    })
    showSuccess(t('accounting.reconciliationUi.completed'))
    await loadTransactions()
  } catch (e) {
    fail(e)
  }
}

onMounted(() => {
  store.fetchBankAccounts()
})
</script>
