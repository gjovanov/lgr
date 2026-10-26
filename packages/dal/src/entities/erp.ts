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

// FR-21.27: the POSTransaction entity is gone. A till sale is a cash-register document (`Invoice`);
// `postransactions` is frozen and read only by migrations and the restore, through the driver.

export interface IPriceStep {
  type: 'base' | 'category' | 'tag' | 'contact' | 'tier' | 'override'
  label: string
  price: number
}
