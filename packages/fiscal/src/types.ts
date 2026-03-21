/**
 * Fiscal printer abstraction for Bulgarian SUPTO compliance (Ordinance Н-18, Appendix 29).
 *
 * All Bulgarian fiscal printers (Datecs, Daisy, Tremol, Incotex) support a similar
 * command protocol. This interface abstracts the differences.
 */

/** VAT groups used by Bulgarian fiscal printers */
export type VatGroup = 'А' | 'Б' | 'В' | 'Г'

/** Payment types recognized by fiscal printers */
export type FiscalPaymentType = 'cash' | 'card' | 'check' | 'voucher'

/** Status of the fiscal device */
export interface FiscalDeviceStatus {
  connected: boolean
  paperPresent: boolean
  fiscalMemoryOk: boolean
  dateTime?: Date
  serialNumber?: string
  firmwareVersion?: string
  lastReceiptNumber?: number
  dailyTotals?: {
    sales: number
    returns: number
    receiptsCount: number
  }
  errors?: string[]
}

/** Result of closing a fiscal receipt */
export interface FiscalReceiptResult {
  fiscalReceiptNumber: string
  dateTime: Date
}

/** Result of printing a storno receipt */
export interface FiscalStornoResult {
  fiscalReceiptNumber: string
  dateTime: Date
}

/** Result of a daily Z-report */
export interface ZReportResult {
  reportNumber: string
  dateTime: Date
  totalSales: number
  totalReturns: number
  receiptCount: number
}

/** Storno reason codes per Appendix 29 */
export type StornoReason = 'operator_error' | 'customer_return' | 'price_reduction' | 'tax_base_reduction'

/**
 * Abstract fiscal printer interface.
 * Each manufacturer (Datecs, Daisy, Tremol, Incotex) provides a concrete implementation.
 */
export interface IFiscalPrinter {
  /** Connect to the fiscal device */
  connect(): Promise<void>

  /** Disconnect from the fiscal device */
  disconnect(): Promise<void>

  /** Get the current status of the fiscal device */
  getStatus(): Promise<FiscalDeviceStatus>

  /** Open a new fiscal receipt */
  openFiscalReceipt(operatorCode: string, operatorName: string, unpNumber: string): Promise<void>

  /** Print a sale line on the current open fiscal receipt */
  printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number): Promise<void>

  /** Print subtotal on the current fiscal receipt */
  printSubtotal(): Promise<{ subtotal: number }>

  /** Print payment and close the fiscal receipt */
  printPayment(type: FiscalPaymentType, amount: number): Promise<void>

  /** Close the current fiscal receipt — returns the fiscal receipt number */
  closeFiscalReceipt(): Promise<FiscalReceiptResult>

  /** Print a storno (reversal) fiscal receipt */
  printStornoReceipt(
    operatorCode: string,
    operatorName: string,
    unpNumber: string,
    originalReceiptNumber: string,
    originalDate: Date,
    originalUNP: string,
    reason: StornoReason,
    lines: { name: string; quantity: number; price: number; vatGroup: VatGroup }[],
    payment: { type: FiscalPaymentType; amount: number },
  ): Promise<FiscalStornoResult>

  /** Print a daily Z-report (end-of-day fiscal closure) */
  printDailyZReport(): Promise<ZReportResult>

  /** Read the device's current date/time */
  readDateTime(): Promise<Date>

  /** Synchronize the device's clock with the given date/time */
  syncDateTime(dateTime: Date): Promise<void>
}

/**
 * Connection configuration for a fiscal printer.
 */
export interface FiscalConnectionConfig {
  type: 'serial' | 'tcp' | 'usb'
  serial?: {
    port: string
    baudRate: number
  }
  tcp?: {
    ip: string
    port: number
  }
  usb?: {
    path: string
  }
}

/**
 * Map application payment methods to fiscal payment types.
 */
export function toFiscalPaymentType(method: string): FiscalPaymentType {
  switch (method) {
    case 'cash': return 'cash'
    case 'card': return 'card'
    case 'mobile': return 'card' // Mobile payments are treated as card by fiscal printers
    case 'voucher': return 'voucher'
    case 'check': return 'check'
    default: return 'cash'
  }
}

/**
 * @deprecated Use `mapTaxRateToVatGroup` from `fiscal/vat-groups` instead — it correctly handles goods vs services.
 */
export function toVatGroup(taxRate: number): VatGroup {
  if (taxRate >= 18) return 'А'
  if (taxRate >= 7) return 'В'
  return 'Г'
}
