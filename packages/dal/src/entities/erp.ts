import type { TenantEntity } from '../types.js'

// ── FiscalDevice ──

export interface IFiscalDeviceConnectionParams {
  port?: string
  baudRate?: number
  ip?: string
  tcpPort?: number
  usbPath?: string
}

export interface IFiscalDevice extends TenantEntity {
  deviceNumber: string
  name: string
  manufacturer: string
  connectionType: string
  connectionParams: IFiscalDeviceConnectionParams
  warehouseId: string
  workstationId?: string
  status: string
  lastCommunicationAt?: Date
  firmwareVersion?: string
  isActive: boolean
  deactivatedAt?: Date
}

// ── Workstation ──

export interface IWorkstation extends TenantEntity {
  code: string
  name: string
  warehouseId: string
  fiscalDeviceId?: string
  isActive: boolean
  deactivatedAt?: Date
}

// ── POSPaymentMethod ──

export interface IPOSPaymentMethod extends TenantEntity {
  name: string
  code: string
  type: string
  journalId?: string
  isCashCount: boolean
  isActive: boolean
  deactivatedAt?: Date
}

// ── POSSession ──

export interface IPOSSession extends TenantEntity {
  warehouseId: string
  cashierId: string
  sessionNumber: string
  openedAt: Date
  closedAt?: Date
  status: string
  openingBalance: number
  closingBalance?: number
  expectedBalance?: number
  difference?: number
  currency: string
  totalSales: number
  totalReturns: number
  totalCash: number
  totalCard: number
  transactionCount: number
}

// ── POSTransaction ──

export interface IPriceStep {
  type: 'base' | 'tag' | 'contact' | 'override'
  label: string
  price: number
}

export interface IPOSTransactionLine {
  id?: string
  productId: string
  name: string
  quantity: number
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
  priceExplanation?: IPriceStep[]
}

export interface IPOSTransactionPayment {
  id?: string
  method: string
  amount: number
  reference?: string
}

export interface IPOSTransaction extends TenantEntity {
  sessionId: string
  transactionNumber: string
  type: string
  status: string
  customerId?: string
  lines: IPOSTransactionLine[]
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
  payments: IPOSTransactionPayment[]
  changeDue: number
  invoiceId?: string
  movementId?: string
  // Fiscal / SUPTO
  unpNumber?: string
  fiscalReceiptNumber?: string
  fiscalDeviceNumber?: string
  printedAt?: Date
  isFiscal: boolean
  // Storno
  originalUNP?: string
  originalFiscalReceiptNumber?: string
  originalTransactionDate?: Date
  originalTransactionId?: string
  stornoReason?: string
  createdBy: string
}
