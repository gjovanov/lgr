/**
 * FR-21 D-4 — what the cash-register service needs from a fiscal device: a port, not the device.
 *
 * The service lives in `services`, and `fiscal` depends on `services` (its logger), never the other
 * way round. So the door that has a device — the till — builds one of these from `fiscal/*` (the
 * device it found connected, the operator signed in, the formatting the device needs) and hands it
 * over. The service keeps what must not differ between doors: the print-once state machine (#155),
 * the УНП (#156) and what a failure does to the sale.
 *
 * Import-pure: types only.
 */

/** A cash-register document as the service hands it to the device: the `Invoice` row. */
export type RegisterDocument = Record<string, any>

export interface RegisterPrinter {
  /** The `FiscalDevice` row. */
  deviceId: string
  /** Its 8-character number: the first part of every УНП it prints. */
  deviceNumber: string
  /**
   * The device's last fiscal document number, or `undefined` when it cannot say (Tremol). Read
   * before printing and again on a resume: it is how print-once tells "printed" from "not printed".
   */
  lastReceiptNumber(): Promise<number | undefined>
  /** Whether a receipt is open on the device, or `undefined` when it cannot say. */
  receiptOpen?(): Promise<boolean | undefined>
  /**
   * Print the sale's fiscal receipt under `doc.register.unp`, with `doc.register.receiptText` under
   * its lines when it has one (FR-23). Returns the receipt number.
   */
  printSale(doc: RegisterDocument): Promise<string>
  /** Whether the device prints non-fiscal text (the till's „Нефискален" mode). */
  readonly printsText: boolean
  /** Why this device cannot take a cash-on-delivery payment; null when it can (`fiscal/capabilities`). */
  readonly cashOnDeliveryRefusal: string | null
  /** Whether it prints a text line inside a fiscal receipt (`fiscal/capabilities`, FR-23). */
  readonly printsFiscalText: boolean
  /** The longest line name it keeps, when its driver cuts one (`fiscal/capabilities`). */
  readonly lineNameMax?: number
  /** Print the sale as a non-fiscal text receipt. */
  printText(doc: RegisterDocument): Promise<void>
  /** Print the storno receipt of `original`. Returns its receipt number. */
  printStorno(storno: RegisterDocument, original: RegisterDocument): Promise<string>
  /**
   * Get a half-printed fiscal receipt off the device, or it refuses everything after it: voided, or
   * finished if it can no longer be voided. Best effort. `closed` says a driver with no cancel fell
   * back on closing it and the close went through: that receipt is real.
   */
  abandonReceipt(): Promise<{ closed?: boolean } | void>
  /** Close a text receipt left half-printed. Best effort. */
  abandonText(): Promise<void>
  /** The device answered: it is online. */
  reached(): Promise<void>
  /** The device failed: mark it, so the next operation does not walk into it blind. */
  failed(): Promise<void>
  /** One fiscal operation from the first command to the last, so a graceful stop cannot split it (FR-20.23). */
  operation<T>(fn: () => Promise<T>): Promise<T>
}
