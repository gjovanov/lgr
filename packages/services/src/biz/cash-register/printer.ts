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

import type { AbandonOutcome } from './print-verdict.js'

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
   * Get what an earlier document left open off the device. That moves the counter, so it comes before
   * the counter is read: it is no print of the document about to print. A driver that clears nothing
   * has nothing to clear.
   */
  clearLeftovers?(): Promise<void>
  /**
   * Print the sale's fiscal receipt under `doc.register.unp`, with `doc.register.receiptText` under
   * its lines when it has one (FR-23). Returns the receipt number.
   */
  printSale(doc: RegisterDocument): Promise<string>
  /** Whether the device prints non-fiscal text (the till's „Нефискален" mode). */
  readonly printsText: boolean
  /**
   * What the device says of itself, read now: `false` when it is not fiscalized, `undefined` when it
   * does not say (`fiscal/types.ts`). Throws when it cannot be read, which is no answer.
   */
  fiscalized(): Promise<boolean | undefined>
  /** Why this device cannot take a cash-on-delivery payment; null when it can (`fiscal/capabilities`). */
  readonly cashOnDeliveryRefusal: string | null
  /** Whether it prints a text line inside a fiscal receipt (`fiscal/capabilities`, FR-23). */
  readonly printsFiscalText: boolean
  /** The longest line name it keeps, when its driver cuts one (`fiscal/capabilities`). */
  readonly lineNameMax?: number
  /** Print the sale as a non-fiscal text receipt. */
  printText(doc: RegisterDocument): Promise<void>
  /**
   * Print a storno's receipt: its own lines, its own total, citing what `storno.register.storno` names.
   * `original`, the sale it reverses, says how it is paid when the storno itself does not. Returns its
   * receipt number.
   */
  printStorno(storno: RegisterDocument, original?: RegisterDocument): Promise<string>
  /**
   * Get a half-printed fiscal receipt off the device, or it refuses everything after it: voided, or
   * finished if it can no longer be voided. Best effort. Says which when it knows (`AbandonOutcome`),
   * and `print-verdict.ts` takes it from there. R2's `payment_storno` gets this for nothing.
   */
  abandonReceipt(): Promise<AbandonOutcome | undefined>
  /** Close a text receipt left half-printed. Best effort. */
  abandonText(): Promise<void>
  /** The device answered: it is online. */
  reached(): Promise<void>
  /** The device failed: mark it, so the next operation does not walk into it blind. */
  failed(): Promise<void>
  /** One fiscal operation from the first command to the last, so a graceful stop cannot split it (FR-20.23). */
  operation<T>(fn: () => Promise<T>): Promise<T>
}
