import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from '../composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Account {
  _id: string
  code: string
  name: string
  type: string
  parentId?: string
  currency?: string
  isActive: boolean
  balance: number
}

export interface JournalEntry {
  _id: string
  number: string
  date: string
  description: string
  lines: JournalLine[]
  status: 'draft' | 'posted' | 'voided'
  createdAt: string
}

export interface JournalLine {
  accountId: string
  accountName?: string
  debit: number
  credit: number
  description?: string
}

export interface FiscalYear {
  _id: string
  name: string
  startDate: string
  endDate: string
  status: 'open' | 'closed'
}

export interface FiscalPeriod {
  _id: string
  fiscalYearId: string
  name: string
  startDate: string
  endDate: string
  status: 'open' | 'closed'
}

export interface FixedAsset {
  _id: string
  name: string
  code: string
  category: string
  acquisitionDate: string
  acquisitionCost: number
  depreciationMethod: string
  usefulLife: number
  currentValue: number
  status: string
}

export interface BankAccount {
  _id: string
  name: string
  bank: string
  accountNumber: string
  currency: string
  balance: number
  isActive: boolean
}

export interface Reconciliation {
  _id: string
  bankAccountId: string
  bankAccountName?: string
  statementDate: string
  statementBalance: number
  reconciledBalance: number
  difference: number
  status: 'in_progress' | 'completed'
}

export interface TaxReturn {
  _id: string
  name: string
  period: string
  type: string
  totalTax: number
  status: 'draft' | 'filed' | 'paid'
  dueDate: string
  filedDate?: string
}

export interface ExchangeRate {
  _id: string
  fromCurrency: string
  toCurrency: string
  rate: number
  date: string
}

export interface TrialBalanceRow {
  accountId: string
  accountCode: string
  accountName: string
  debit: number
  credit: number
  balance: number
}

export const useAccountingStore = defineStore('accounting', () => {
  const appStore = useAppStore()

  // State
  const accounts = ref<Account[]>([])
  const journalEntries = ref<JournalEntry[]>([])
  const fiscalYears = ref<FiscalYear[]>([])
  const fiscalPeriods = ref<FiscalPeriod[]>([])
  const fixedAssets = ref<FixedAsset[]>([])
  const bankAccounts = ref<BankAccount[]>([])
  const reconciliations = ref<Reconciliation[]>([])
  const taxReturns = ref<TaxReturn[]>([])
  const exchangeRates = ref<ExchangeRate[]>([])
  const trialBalance = ref<TrialBalanceRow[]>([])
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const activeAccounts = computed(() =>
    accounts.value.filter(a => a.isActive)
  )

  const totalDebits = computed(() =>
    trialBalance.value.reduce((sum, row) => sum + row.debit, 0)
  )

  const totalCredits = computed(() =>
    trialBalance.value.reduce((sum, row) => sum + row.credit, 0)
  )

  const draftEntries = computed(() =>
    journalEntries.value.filter(e => e.status === 'draft')
  )

  // --- Accounts ---
  async function fetchAccounts() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/account`)
      accounts.value = data.accounts
    } finally {
      loading.value = false
    }
  }

  async function createAccount(payload: Partial<Account>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/account`, payload)
      accounts.value.push(data.account)
      return data.account
    } finally {
      loading.value = false
    }
  }

  async function updateAccount(id: string, payload: Partial<Account>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/account/${id}`, payload)
      const idx = accounts.value.findIndex(a => a._id === id)
      if (idx !== -1) accounts.value[idx] = data.account
      return data.account
    } finally {
      loading.value = false
    }
  }

  async function deleteAccount(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/account/${id}`)
      accounts.value = accounts.value.filter(a => a._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Journal Entries ---
  async function fetchJournalEntries(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/journal`, { params: filters })
      journalEntries.value = data.journalEntries
    } finally {
      loading.value = false
    }
  }

  async function createJournalEntry(payload: Partial<JournalEntry>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/journal`, payload)
      journalEntries.value.unshift(data.journalEntry)
      return data.journalEntry
    } finally {
      loading.value = false
    }
  }

  async function updateJournalEntry(id: string, payload: Partial<JournalEntry>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/journal/${id}`, payload)
      const idx = journalEntries.value.findIndex(e => e._id === id)
      if (idx !== -1) journalEntries.value[idx] = data.journalEntry
      return data.journalEntry
    } finally {
      loading.value = false
    }
  }

  async function deleteJournalEntry(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/journal/${id}`)
      journalEntries.value = journalEntries.value.filter(e => e._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function postJournalEntry(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/journal/${id}/post`)
      const idx = journalEntries.value.findIndex(e => e._id === id)
      if (idx !== -1) journalEntries.value[idx] = data.journalEntry
      return data.journalEntry
    } finally {
      loading.value = false
    }
  }

  async function voidJournalEntry(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/journal/${id}/void`)
      const idx = journalEntries.value.findIndex(e => e._id === id)
      if (idx !== -1) journalEntries.value[idx] = data.journalEntry
      return data.journalEntry
    } finally {
      loading.value = false
    }
  }

  // --- Fiscal Years ---
  async function fetchFiscalYears() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/fiscal-year`)
      fiscalYears.value = data.fiscalYears
    } finally {
      loading.value = false
    }
  }

  async function createFiscalYear(payload: Partial<FiscalYear>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/fiscal-year`, payload)
      fiscalYears.value.push(data.fiscalYear)
      return data.fiscalYear
    } finally {
      loading.value = false
    }
  }

  async function updateFiscalYear(id: string, payload: Partial<FiscalYear>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/fiscal-year/${id}`, payload)
      const idx = fiscalYears.value.findIndex(f => f._id === id)
      if (idx !== -1) fiscalYears.value[idx] = data.fiscalYear
      return data.fiscalYear
    } finally {
      loading.value = false
    }
  }

  async function deleteFiscalYear(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/fiscal-year/${id}`)
      fiscalYears.value = fiscalYears.value.filter(f => f._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Fiscal Periods ---
  async function fetchFiscalPeriods(fiscalYearId?: string) {
    loading.value = true
    try {
      const params = fiscalYearId ? { fiscalYearId } : undefined
      const { data } = await httpClient.get(`${orgUrl()}/accounting/fiscal-period`, { params })
      fiscalPeriods.value = data.fiscalPeriods
    } finally {
      loading.value = false
    }
  }

  async function createFiscalPeriod(payload: Partial<FiscalPeriod>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/fiscal-period`, payload)
      fiscalPeriods.value.push(data.fiscalPeriod)
      return data.fiscalPeriod
    } finally {
      loading.value = false
    }
  }

  async function updateFiscalPeriod(id: string, payload: Partial<FiscalPeriod>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/fiscal-period/${id}`, payload)
      const idx = fiscalPeriods.value.findIndex(p => p._id === id)
      if (idx !== -1) fiscalPeriods.value[idx] = data.fiscalPeriod
      return data.fiscalPeriod
    } finally {
      loading.value = false
    }
  }

  async function deleteFiscalPeriod(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/fiscal-period/${id}`)
      fiscalPeriods.value = fiscalPeriods.value.filter(p => p._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Fixed Assets ---
  async function fetchFixedAssets() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/fixed-asset`)
      fixedAssets.value = data.fixedAssets
    } finally {
      loading.value = false
    }
  }

  async function createFixedAsset(payload: Partial<FixedAsset>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/fixed-asset`, payload)
      fixedAssets.value.push(data.fixedAsset)
      return data.fixedAsset
    } finally {
      loading.value = false
    }
  }

  async function updateFixedAsset(id: string, payload: Partial<FixedAsset>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/fixed-asset/${id}`, payload)
      const idx = fixedAssets.value.findIndex(a => a._id === id)
      if (idx !== -1) fixedAssets.value[idx] = data.fixedAsset
      return data.fixedAsset
    } finally {
      loading.value = false
    }
  }

  async function deleteFixedAsset(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/fixed-asset/${id}`)
      fixedAssets.value = fixedAssets.value.filter(a => a._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Bank Accounts ---
  async function fetchBankAccounts() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/bank-account`)
      bankAccounts.value = data.bankAccounts
    } finally {
      loading.value = false
    }
  }

  async function createBankAccount(payload: Partial<BankAccount>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/bank-account`, payload)
      bankAccounts.value.push(data.bankAccount)
      return data.bankAccount
    } finally {
      loading.value = false
    }
  }

  async function updateBankAccount(id: string, payload: Partial<BankAccount>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/bank-account/${id}`, payload)
      const idx = bankAccounts.value.findIndex(b => b._id === id)
      if (idx !== -1) bankAccounts.value[idx] = data.bankAccount
      return data.bankAccount
    } finally {
      loading.value = false
    }
  }

  async function deleteBankAccount(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/bank-account/${id}`)
      bankAccounts.value = bankAccounts.value.filter(b => b._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Reconciliations ---
  async function fetchReconciliations(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/reconciliation`, { params: filters })
      reconciliations.value = data.reconciliations
    } finally {
      loading.value = false
    }
  }

  async function createReconciliation(payload: Partial<Reconciliation>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/reconciliation`, payload)
      reconciliations.value.unshift(data.reconciliation)
      return data.reconciliation
    } finally {
      loading.value = false
    }
  }

  async function updateReconciliation(id: string, payload: Partial<Reconciliation>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/reconciliation/${id}`, payload)
      const idx = reconciliations.value.findIndex(r => r._id === id)
      if (idx !== -1) reconciliations.value[idx] = data.reconciliation
      return data.reconciliation
    } finally {
      loading.value = false
    }
  }

  async function deleteReconciliation(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/reconciliation/${id}`)
      reconciliations.value = reconciliations.value.filter(r => r._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Tax Returns ---
  async function fetchTaxReturns(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/tax-return`, { params: filters })
      taxReturns.value = data.taxReturns
    } finally {
      loading.value = false
    }
  }

  async function createTaxReturn(payload: Partial<TaxReturn>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/tax-return`, payload)
      taxReturns.value.unshift(data.taxReturn)
      return data.taxReturn
    } finally {
      loading.value = false
    }
  }

  async function updateTaxReturn(id: string, payload: Partial<TaxReturn>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/tax-return/${id}`, payload)
      const idx = taxReturns.value.findIndex(t => t._id === id)
      if (idx !== -1) taxReturns.value[idx] = data.taxReturn
      return data.taxReturn
    } finally {
      loading.value = false
    }
  }

  async function deleteTaxReturn(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/tax-return/${id}`)
      taxReturns.value = taxReturns.value.filter(t => t._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Exchange Rates ---
  async function fetchExchangeRates() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/exchange-rate`)
      exchangeRates.value = data.exchangeRates
    } finally {
      loading.value = false
    }
  }

  async function createExchangeRate(payload: Partial<ExchangeRate>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/accounting/exchange-rate`, payload)
      exchangeRates.value.unshift(data.exchangeRate)
      return data.exchangeRate
    } finally {
      loading.value = false
    }
  }

  async function updateExchangeRate(id: string, payload: Partial<ExchangeRate>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/accounting/exchange-rate/${id}`, payload)
      const idx = exchangeRates.value.findIndex(r => r._id === id)
      if (idx !== -1) exchangeRates.value[idx] = data.exchangeRate
      return data.exchangeRate
    } finally {
      loading.value = false
    }
  }

  async function deleteExchangeRate(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/accounting/exchange-rate/${id}`)
      exchangeRates.value = exchangeRates.value.filter(r => r._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Reports ---
  async function getTrialBalance(params?: { date?: string; fiscalYearId?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/report/trial-balance`, { params })
      trialBalance.value = data.rows
      return data
    } finally {
      loading.value = false
    }
  }

  async function getProfitLoss(params?: { startDate?: string; endDate?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/report/profit-loss`, { params })
      return data
    } finally {
      loading.value = false
    }
  }

  async function getBalanceSheet(params?: { date?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/accounting/report/balance-sheet`, { params })
      return data
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    accounts,
    journalEntries,
    fiscalYears,
    fiscalPeriods,
    fixedAssets,
    bankAccounts,
    reconciliations,
    taxReturns,
    exchangeRates,
    trialBalance,
    loading,
    // Getters
    activeAccounts,
    totalDebits,
    totalCredits,
    draftEntries,
    // Actions - Accounts
    fetchAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
    // Actions - Journal Entries
    fetchJournalEntries,
    createJournalEntry,
    updateJournalEntry,
    deleteJournalEntry,
    postJournalEntry,
    voidJournalEntry,
    // Actions - Fiscal Years
    fetchFiscalYears,
    createFiscalYear,
    updateFiscalYear,
    deleteFiscalYear,
    // Actions - Fiscal Periods
    fetchFiscalPeriods,
    createFiscalPeriod,
    updateFiscalPeriod,
    deleteFiscalPeriod,
    // Actions - Fixed Assets
    fetchFixedAssets,
    createFixedAsset,
    updateFixedAsset,
    deleteFixedAsset,
    // Actions - Bank Accounts
    fetchBankAccounts,
    createBankAccount,
    updateBankAccount,
    deleteBankAccount,
    // Actions - Reconciliations
    fetchReconciliations,
    createReconciliation,
    updateReconciliation,
    deleteReconciliation,
    // Actions - Tax Returns
    fetchTaxReturns,
    createTaxReturn,
    updateTaxReturn,
    deleteTaxReturn,
    // Actions - Exchange Rates
    fetchExchangeRates,
    createExchangeRate,
    updateExchangeRate,
    deleteExchangeRate,
    // Actions - Reports
    getTrialBalance,
    getProfitLoss,
    getBalanceSheet,
  }
})
