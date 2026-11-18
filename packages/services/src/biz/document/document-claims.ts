import { Invoice } from 'db/models'
import { getRepos } from '../../context.js'
import { isBeingVoided } from '../invoice-payment.js'
import { DOCUMENT_CHANGED, DOCUMENT_CLAIMED, PAYMENT_IN_PROGRESS, inDoubtRefusal, isImportedDocument, receiptInDoubt } from '../cash-register/payment-receipt.service.js'
import { printsHere } from '../sale-counting.js'
import type { Status } from './refused.js'

/**
 * FR-32.21 (#797): who holds a document, and what a write that lost to them answers. Shared by the document services
 * and the invoice routes that stay in the controller (delete, receive, void, payments).
 */

/** The document as the repository reads it. */
export const documentOf = (orgId: string, id: string): Promise<any> => getRepos().invoices.findOne({ id, orgId })

/** The document as stored, ids and all: what the receipt's and the storno's steps read. */
export const rawOf = (id: string, orgId: string): Promise<any> => Invoice.findOne({ _id: id, orgId }).lean().exec()

export const ISSUE_IN_PROGRESS = { code: 'issue_in_progress', message: 'This document is already being issued' }

/** FR-23: it would fit, but a receipt is taking that money: printing right now, or held for a person. */
export async function receiptPrinting(status: Status, orgId: string, id: string) {
  const doubt = await receiptInDoubt(orgId, id)
  return status(409, doubt ? inDoubtRefusal(doubt) : { ...PAYMENT_IN_PROGRESS })
}

/** Why a claim on this document was refused: who holds it now. `otherwise`: nobody does. */
export async function holderOf(orgId: string, id: string, otherwise?: (doc: any) => Record<string, unknown>): Promise<Record<string, unknown>> {
  const doc: any = await Invoice.findOne({ _id: id, orgId }, { status: 1, voidingUntil: 1, 'issue.leaseUntil': 1 }).lean().exec()
  if (doc?.issue?.leaseUntil && new Date(doc.issue.leaseUntil).getTime() >= Date.now()) return ISSUE_IN_PROGRESS
  if (isBeingVoided(doc)) return { ...DOCUMENT_CLAIMED }
  if (otherwise) return otherwise(doc)
  const doubt = await receiptInDoubt(orgId, id)
  return doubt ? inDoubtRefusal(doubt) : { ...PAYMENT_IN_PROGRESS }
}

export const whoHolds = async (status: Status, orgId: string, id: string, otherwise?: (doc: any) => Record<string, unknown>) =>
  status(409, await holderOf(orgId, id, otherwise))

/** A draft's write that lost: an issue, a void or an attach holds it, or it is no longer the draft that was read. */
export const draftTaken = (status: Status, orgId: string, id: string) => whoHolds(status, orgId, id, () => ({ ...DOCUMENT_CHANGED }))

/**
 * Whether the settlement rule may add money on this document (`syncCashSettlement`'s `settles`). Where LGR
 * prints it may not: that money goes through the payment action, which prints. An imported document never
 * prints, so nothing else would settle it, and neither does an org where LGR prints nothing.
 *
 * ⚠ `atIssue`: the re-issue of a number issued twice settles as it is issued, and only then. It prints
 * nothing, its money was taken under the number it replaces, and its credit note gives that back (FR-20.51).
 * Read as an edit it would have nothing to record what was taken.
 */
export async function ruleSettles(orgId: string, doc: any, atIssue = false): Promise<boolean> {
  if (isImportedDocument(doc) || (atIssue && doc?.stockSource?.detectedBy === 'number_clash')) return true
  return !(await printsHere(orgId))
}
