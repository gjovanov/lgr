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
  balanceSide?: 'debit' | 'credit' | 'both'
  analyticRoots?: string[]
  quantitative?: boolean
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
  opNo?: number
  side?: 'debit' | 'credit'
  analyticId?: string
  quantity?: number
  unit?: string
  settles?: { docType: string; docNumber: string }[]
  branchOrgId?: string
  fx?: { currency: string; rate?: number; amount?: number }
  journalCode?: string
  taxCode?: string
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
  ledger?: 'books' | 'shadow'
  docType?: string
  docNumber?: string
  docDate?: Date
  vatKind?: string
  docTotal?: number
  docVat?: number
  docCurrency?: string
  partnerAnalyticId?: string
  branchOrgId?: string
  sourceOrgId?: string
  // FR-25a: the accountant's document header, as the model has it.
  paymentCode?: string
  paidAmount?: number
  paidCash?: number
  taxEventDate?: Date
  vatRate?: number
  vatRule?: string
  vatExemptionReason?: string
  registerDocType?: string
  protocolType?: string
  reasonRef?: string
  customsRef?: string
  bankOperation?: string
  reportingMonth?: string
  links?: { docType: string; docNumber: string; date?: Date; amount?: number; amountFx?: number }[]
  docOptions?: Record<string, string>
  source?: { createdBy?: string; createdAt?: Date; modifiedBy?: string; modifiedAt?: Date; version?: string }
  importBatchId?: string
  importKey?: string
  importHash?: string
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
  // FR-25a: the tax side (ЗКПО).
  taxCategory?: string
  inServiceDate?: Date
  taxDepreciationRate?: number
  taxValue?: number
  taxUsefulLifeMonths?: number
  params?: { key: string; value: string }[]
  // FR-25a §4.2: set by the books import on an asset it made from a ДА analytic, and only there.
  sourceModule?: string
  importKey?: string
  analyticId?: string
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

export interface ITaxReturnFile {
  name: string
  fileId?: string
  sha256: string
  bytes: number
}

export interface ITaxReturnDeclarant {
  vatId: string
  name: string
  filer: string
  vies?: { id?: string; name: string; city: string; postcode: string; address: string; kind: string; companyAddress: string }
}

export interface ITaxReturn extends TenantEntity {
  type: string
  kind?: string
  periodCode?: string
  cells?: Record<string, number>
  rowCounts?: { sales: number; purchase: number }
  declarant?: ITaxReturnDeclarant
  files?: ITaxReturnFile[]
  source?: string
  ack?: { number: string; fileId?: string }
  supersedesId?: string
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

// ── VatRegisterEntry ──

export interface IVatRegisterEntry extends TenantEntity {
  period: string
  side: string
  ledger: string
  rowNo: number
  docTypeCode: string
  docNumber: string
  docDate: Date
  partnerVat?: string
  partnerName?: string
  description?: string
  branch?: number
  code?: string
  cells: Record<string, number>
  source?: { orgId?: string; kind?: string; id?: string }
  frozen: boolean
}

// ── ExchangeRate ──

export interface IExchangeRate extends TenantEntity {
  fromCurrency: string
  toCurrency: string
  rate: number
  date: Date
  source: string
}
