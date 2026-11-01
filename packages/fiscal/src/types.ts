/**
 * Fiscal printer abstraction for Bulgarian SUPTO compliance (Ordinance Н-18, Appendix 29).
 *
 * Bulgarian fiscal devices speak two protocol families: the Datecs-style ISL framing
 * (Datecs, Daisy, Eltrade, Incotex) and Tremol's ZFP. This interface abstracts the differences.
 */

import type { AbandonOutcome } from 'services/biz/cash-register/print-verdict'

/**
 * VAT groups used by Bulgarian fiscal printers (Н-18 чл. 27(1)): А 0 %/exempt, Б 20 %,
 * В liquid fuels, Г 9 %. See `vat-groups.ts`.
 */
export type VatGroup = 'А' | 'Б' | 'В' | 'Г'

/**
 * Payment types recognized by fiscal printers.
 *
 * `cash_on_delivery` prints only on a device with a slot for it (an Eltrade's reserve slot 'R',
 * named „НАЛОЖЕН ПЛАТЕЖ" from the device page). Every other driver refuses it — see `paymentCode`.
 */
export type FiscalPaymentType = 'cash' | 'card' | 'check' | 'voucher' | 'cash_on_delivery'

/** One of a device's payment slots as the device names it (Eltrade 55h). */
export interface FiscalPaymentName {
  /** The slot's code on the device ('P', 'L', 'R', …). */
  code: string
  /** What the device prints for it; empty when it reports none. */
  name: string
  /** The LGR payment type printed in this slot, if any. */
  type?: FiscalPaymentType
}

/**
 * The driver cannot do what it was asked, on any device of its kind: a payment type it has no slot
 * for, a command its protocol lacks. Thrown before anything is sent, and never retried or replaced
 * by something close — a COD payment printed as cash is booked as cash in the device's own records.
 */
export class FiscalUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FiscalUnsupportedError'
  }
}

/**
 * A payment method no fiscal receipt can carry: a bank transfer, "other", anything LGR does not
 * know. The doors that print refuse one before anything is written (`payment_method_not_fiscal`,
 * `invoicing-api/lib/cash-register-till.ts`); this is what stops one that got past them, before the
 * receipt opens. ⚠ Never answered with a method that is close: the device records what it prints.
 */
export class FiscalPaymentMethodError extends Error {
  constructor(readonly method: string) {
    super(`A fiscal receipt cannot carry the payment method "${method.replace(/_/g, ' ')}". Use cash, card or cash on delivery.`)
    this.name = 'FiscalPaymentMethodError'
  }
}

const PAYMENT_LABEL: Record<FiscalPaymentType, string> = {
  cash: 'cash',
  card: 'card',
  check: 'cheque',
  voucher: 'voucher',
  cash_on_delivery: 'cash on delivery',
}

/**
 * A payment's code in a driver's table, or a refusal. ⚠ Never a fallback: the drivers used to
 * answer `table[type] || 'P'`, so a type missing from the table printed as cash.
 */
export function paymentCode(table: Partial<Record<FiscalPaymentType, string>>, type: FiscalPaymentType, driver: string): string {
  const code = table[type]
  if (code) return code
  throw new FiscalUnsupportedError(
    `${driver} has no payment type for ${PAYMENT_LABEL[type] ?? type}, so it is refused rather than printed as another payment — the device would record it as that one.`,
  )
}

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
  /** Conditions worth showing that do not stop the device (low paper, NRA link down, …). */
  warnings?: string[]
  /** Device model as it reports itself. */
  model?: string
  /** Fiscal memory number (8 digits) — a storno must quote it. */
  fiscalMemoryNumber?: string
  /** false = not fiscalized yet: receipts print, but as service documents. */
  fiscalized?: boolean
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

  /**
   * The number of the last document the device recorded, or undefined if it cannot say.
   *
   * Optional, and what makes a POS sale crash-safe (FR-20.37): read before printing, and read
   * again on a retry of an interrupted sale, it tells whether the receipt went out. A driver
   * without it is treated as "cannot tell" — the sale is then never reprinted automatically.
   */
  getLastReceiptNumber?(): Promise<number | undefined>

  /**
   * Whether a receipt is open on the device, of any kind. Optional. With the counter, it is what tells
   * "nothing happened" from "a receipt is sitting there, maybe paid" (FR-23).
   */
  isReceiptOpen?(): Promise<boolean>

  /**
   * Get what an earlier document left open off the device: a service receipt closed, a fiscal one
   * voided, or finished if it can no longer be voided. Optional, for a driver that clears anything as
   * it opens a receipt (FR-23): a print reads the counter after this, or a leftover's close reads as
   * its own.
   */
  clearLeftovers?(): Promise<void>

  /** Open a new fiscal receipt */
  openFiscalReceipt(operatorCode: string, operatorName: string, unpNumber: string): Promise<void>

  /**
   * Print a sale line on the current open fiscal receipt.
   *
   * `price` is the VAT-INCLUSIVE unit price — a fiscal device derives VAT from the gross
   * amount per group. `discount` is a percentage (10 = 10 % off). `taxRate`, when given, lets
   * a driver check the group against the rates actually programmed on the device.
   */
  printSaleLine(name: string, quantity: number, price: number, vatGroup: VatGroup, discount?: number, taxRate?: number): Promise<void>

  /** Print subtotal on the current fiscal receipt */
  printSubtotal(): Promise<{ subtotal: number }>

  /**
   * Print a line of free text inside the open fiscal receipt: what an invoice paid at the counter
   * says under its lines, „Фактура № …" (FR-23 §2.2). Optional: a driver without it
   * (`capabilities.ts`, `fiscalText`) has the invoice's number printed as a line's name instead.
   * `printNonFiscalText` will not do: it works only on a non-fiscal receipt.
   */
  printFiscalText?(text: string): Promise<void>

  /** Print payment and close the fiscal receipt */
  printPayment(type: FiscalPaymentType, amount: number): Promise<void>

  /** Close the current fiscal receipt — returns the fiscal receipt number */
  closeFiscalReceipt(): Promise<FiscalReceiptResult>

  /**
   * Abandon the current fiscal receipt after a failure, so the device is not left with an
   * open receipt that blocks every later command. Optional — callers fall back to
   * `closeFiscalReceipt()` for drivers without it. Says what it did, when it knows: `voided` ONLY if it
   * saw a receipt open before it cancelled (`AbandonOutcome`, `print-verdict.ts`).
   */
  cancelFiscalReceipt?(): Promise<AbandonOutcome | undefined>

  /** Print a storno (reversal) fiscal receipt. Line prices are VAT-inclusive, as in printSaleLine. */
  printStornoReceipt(
    operatorCode: string,
    operatorName: string,
    unpNumber: string,
    originalReceiptNumber: string,
    originalDate: Date,
    originalUNP: string,
    reason: StornoReason,
    lines: { name: string; quantity: number; price: number; vatGroup: VatGroup; taxRate?: number }[],
    payment: { type: FiscalPaymentType; amount: number },
  ): Promise<FiscalStornoResult>

  /** Print a daily Z-report (end-of-day fiscal closure) */
  printDailyZReport(): Promise<ZReportResult>

  /** Read the device's current date/time */
  readDateTime(): Promise<Date>

  /** Synchronize the device's clock with the given date/time */
  syncDateTime(dateTime: Date): Promise<void>

  // ── Non-fiscal receipt (for testing with non-fiscalized devices) ──

  /** Open a non-fiscal (informational) receipt */
  openNonFiscalReceipt?(operatorCode: string): Promise<void>

  /** Print a free-text line on an open non-fiscal receipt */
  printNonFiscalText?(text: string): Promise<void>

  /** Close the current non-fiscal receipt */
  closeNonFiscalReceipt?(): Promise<void>

  // ── Report and operator commands ──

  /** Print X-report (daily read without clearing) */
  printDailyXReport?(): Promise<ZReportResult>

  /** Print operator report */
  printOperatorReport?(operatorNumber?: number): Promise<void>

  /** Print fiscal memory report by date range */
  printFiscalMemoryReportByDate?(startDate: Date, endDate: Date, detailed?: boolean): Promise<void>

  /** Print fiscal memory report by Z-report number range */
  printFiscalMemoryReportByNumber?(startNumber: number, endNumber: number, detailed?: boolean): Promise<void>

  /** Print electronic journal (KLEN) report for NRA */
  printEJReport?(startDate: Date, endDate: Date): Promise<void>

  /** Program an operator on the device */
  programOperator?(operatorNumber: number, password: string, name: string): Promise<void>

  /** Read operator info from device */
  readOperator?(operatorNumber: number): Promise<{ number: number; name: string }>

  /** The names the device prints for each of its payment slots. */
  readPaymentNames?(): Promise<FiscalPaymentName[]>

  /** Name one payment slot; resolves to what the device reports afterwards, with the name it had. */
  programPaymentName?(code: string, name: string): Promise<FiscalPaymentName & { previous?: string }>
}

/**
 * How a driver wants one frame exchanged over a transport (browser bridge or TCP).
 * Both fields are optional so the older drivers keep calling `sendCommand(frame)`.
 */
export interface FiscalExchangeOptions {
  /**
   * Response framing the transport should wait for. `'isl'` = the Datecs-style family
   * (answer ends in 03h, SYN = still busy, NAK = resend). Omitted = the legacy heuristic the
   * Datecs/Tremol drivers were written against.
   */
  protocol?: 'isl'
  /** End-to-end budget for this exchange — a Z-report or fiscal-memory report prints for minutes. */
  timeoutMs?: number
}

/**
 * Connection configuration for a fiscal printer.
 */
export interface FiscalConnectionConfig {
  type: 'serial' | 'tcp' | 'usb' | 'browser'
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
 *
 * ⚠ There is no default. Anything else used to print as cash, so a bank transfer on a fiscal receipt
 * was recorded by the device as cash taken. It throws `FiscalPaymentMethodError` now, and so does
 * `check`: the method was removed outright, and no document can hold one (`Invoice.payments.method`).
 *
 * Cash on delivery keeps its own type: a driver with a slot for it prints it there, and every other
 * driver refuses it (`paymentCode`).
 */
export function toFiscalPaymentType(method: string): FiscalPaymentType {
  switch (method) {
    case 'cash': return 'cash'
    case 'card': return 'card'
    case 'mobile': return 'card' // Mobile payments are treated as card by fiscal printers
    case 'voucher': return 'voucher'
    case 'cash_on_delivery': return 'cash_on_delivery'
    default: throw new FiscalPaymentMethodError(method)
  }
}

/**
 * @deprecated Use `mapTaxRateToVatGroup` from `fiscal/vat-groups`. Kept for the public
 * export; same Н-18 mapping (this used to send 20 % to group А, which is the 0 % group).
 */
export function toVatGroup(taxRate: number): VatGroup {
  if (taxRate >= 18) return 'Б'
  if (taxRate >= 7) return 'Г'
  return 'А'
}
