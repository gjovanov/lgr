import type { TenantEntity } from '../types.js'

// ── Journal ──

export interface IJournal extends TenantEntity {
  name: string
  code: string
  type: string
  defaultDebitAccountId?: string
  defaultCreditAccountId?: string
  bankAccountId?: string
  currency?: string
  sequencePrefix?: string
  isActive: boolean
  deactivatedAt?: Date
}

// ── PaymentTerm ──

export interface IPaymentTermLine {
  type: string
  value: number
  days: number
  dayOfMonth?: number
  earlyDiscountPercent?: number
  earlyDiscountDays?: number
}

export interface IPaymentTerm extends TenantEntity {
  name: string
  description?: string
  lines: IPaymentTermLine[]
  isActive: boolean
  deactivatedAt?: Date
}

// ── FiscalPosition ──

export interface IFiscalPositionTaxMap {
  sourceTaxRate: number
  destinationTaxRate: number
  destinationAccountId?: string
}

export interface IFiscalPosition extends TenantEntity {
  name: string
  autoApply: boolean
  country?: string
  taxMaps: IFiscalPositionTaxMap[]
  isActive: boolean
  deactivatedAt?: Date
}

// ── Account ──

export interface IAccount extends TenantEntity {
  code: string
  name: string
  type: string
  subType: string
  parentId?: string
  currency?: string
  description?: string
  isSystem: boolean
  isActive: boolean
  balance: number
  tags?: string[]
}

// ── FiscalYear ──

export interface IFiscalYear extends TenantEntity {
  name: string
  startDate: Date
  endDate: Date
  status: string
  closingEntryId?: string
}

// ── FiscalPeriod ──

export interface IFiscalPeriod extends TenantEntity {
  fiscalYearId: string
  name: string
  number: number
  startDate: Date
  endDate: Date
  status: string
}

// ── JournalEntry ──

export interface IJournalEntryLine {
  id?: string
  accountId: string
  description?: string
  debit: number
  credit: number
  currency: string
  exchangeRate: number
  baseDebit: number
  baseCredit: number
  contactId?: string
  projectId?: string
  costCenterId?: string
  tags?: string[]
}

export interface IJournalEntry extends TenantEntity {
  journalId?: string
  entryNumber: string
  date: Date
  fiscalPeriodId: string
  description: string
  reference?: string
  type: string
  status: string
  lines: IJournalEntryLine[]
  totalDebit: number
  totalCredit: number
  attachments: string[]
  sourceModule?: string
  sourceId?: string
  createdBy: string
  postedBy?: string
  postedAt?: Date
}

// ── FixedAsset ──

export interface IDepreciationEntry {
  id?: string
  date: Date
  amount: number
  accumulatedAmount: number
  bookValue: number
  journalEntryId?: string
}

export interface IFixedAsset extends TenantEntity {
  code: string
  name: string
  description?: string
  category: string
  accountId: string
  depreciationAccountId: string
  accumulatedDepAccountId: string
  purchaseDate: Date
  purchasePrice: number
  currency: string
  salvageValue: number
  usefulLifeMonths: number
  depreciationMethod: string
  currentValue: number
  status: string
  disposalDate?: Date
  disposalPrice?: number
  depreciationSchedule: IDepreciationEntry[]
  location?: string
  assignedTo?: string
}

// ── BankAccount ──

export interface IBankAccount extends TenantEntity {
  name: string
  bankName: string
  accountNumber: string
  iban?: string
  swift?: string
  currency: string
  accountId: string
  balance: number
  isDefault: boolean
  isActive: boolean
  lastReconciledDate?: Date
}

// ── BankReconciliation ──

export interface IBankReconciliationItem {
  id?: string
  date: Date
  description: string
  amount: number
  type: string
  matched: boolean
  journalEntryId?: string
  bankReference?: string
}

export interface IBankReconciliation extends TenantEntity {
  bankAccountId: string
  statementDate: Date
  statementBalance: number
  bookBalance: number
  difference: number
  status: string
  items: IBankReconciliationItem[]
  reconciledBy?: string
  reconciledAt?: Date
}

// ── TaxReturn ──

export interface ITaxReturnLine {
  id?: string
  description: string
  taxableAmount: number
  taxRate: number
  taxAmount: number
  accountId: string
}

export interface ITaxReturn extends TenantEntity {
  type: string
  period: { from: Date; to: Date }
  status: string
  totalTax: number
  totalInput: number
  totalOutput: number
  netPayable: number
  lines: ITaxReturnLine[]
  filedAt?: Date
  filedBy?: string
  attachments: string[]
}

// ── ExchangeRate ──

export interface IExchangeRate extends TenantEntity {
  fromCurrency: string
  toCurrency: string
  rate: number
  date: Date
  source: string
}
