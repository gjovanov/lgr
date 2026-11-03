/**
 * FR-25 §5.4–5: what a month of the journal becomes, worked out without touching anything. One
 * document is one entry, and an operation with no document is an entry of its own. `import.service`
 * then matches the plan to what is stored, and writes.
 *
 * ⚠ The file has no row key, and "Преизчисление" rewrites old values between exports, so an entry's
 * identity (`importKey`) never reads an amount: a recosted document is `changed`, not `new` + `gone`.
 *
 * Import-pure, so a unit test needs no database.
 */
import { createHash } from 'node:crypto'
import {
  BANK_ACCOUNT_FOREIGN,
  BANK_ACCOUNT_LOCAL,
  VAT_INPUT_ACCOUNT,
  VAT_OUTPUT_ACCOUNT,
  analyticRootDef,
  docTypeDef,
  rootOfPath,
  settlesOf,
} from './registry.js'
import type { ImportDocument, ImportOperation } from './import.types.js'

export interface BranchSeries {
  orgId: string
  docSeries?: string[]
}

export interface PlannedEntry {
  doc: ImportDocument
  /** What a re-import finds it by. Stable while the document is the same document. */
  importKey: string
  /** The document's content as the file has it. */
  contentHash: string
  /** The one customer or supplier its operations name. Unset: none, or several (a bank statement). */
  partnerPath?: string
  docVat?: number
  /** The store whose document it is, when its number says so. */
  branchOrgId?: string
  description: string
}

const isBankAccount = (code: string) => code === BANK_ACCOUNT_LOCAL || code === BANK_ACCOUNT_FOREIGN

/** The analytic paths an operation names. */
export function pathsOf(op: ImportOperation): string[] {
  return [op.ad, op.ak].filter((p): p is string => !!p)
}

function partnerOf(doc: ImportDocument): string | undefined {
  const partners = new Set<string>()
  for (const op of doc.ops) {
    for (const path of pathsOf(op)) if (analyticRootDef(rootOfPath(path))?.partner) partners.add(path)
  }
  return partners.size === 1 ? [...partners][0] : undefined
}

/**
 * The VAT of a document, the side that charges it: `K4532` on a sale, `D4531` on a purchase, and one
 * operation doing both on a protocol (`D4531 K4532`).
 */
function vatOf(doc: ImportDocument): number | undefined {
  if (!doc.docType) return undefined
  const vat = doc.ops.filter(op => op.k === VAT_OUTPUT_ACCOUNT || op.d === VAT_INPUT_ACCOUNT)
  return vat.length ? vat.reduce((sum, op) => sum + op.amount, 0) : undefined
}

/** A sales document's number is the one thing in the accountant's journal that says whose it is. */
function branchOf(doc: ImportDocument, branches: readonly BranchSeries[]): string | undefined {
  if (docTypeDef(doc.docType)?.family !== 'sales' || !doc.docNumber) return undefined
  const number = doc.docNumber
  return branches.find(b => b.docSeries?.some(series => number.startsWith(series)))?.orgId
}

/** The first comment that means something: the document's, or its first operation's. */
function describe(doc: ImportDocument): string {
  const first = doc.ops[0]
  return doc.comment
    || first?.comment
    || (doc.docType ? [doc.docType, doc.docNumber].filter(Boolean).join(' ') : first ? `${first.d} / ${first.k}` : 'PlusMinus')
}

/** The document's content, in a fixed order: what `changed` means. */
function contentOf(doc: ImportDocument): string {
  return JSON.stringify([
    doc.date, doc.docType, doc.docNumber, doc.vatKind, doc.total, doc.comment,
    doc.ops.map(op => [op.d, op.k, op.ad, op.ak, op.qty, op.amount, op.cur, op.rate, op.fx, op.comment, op.journal, op.tax]),
  ])
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function planMonth(documents: readonly ImportDocument[], branches: readonly BranchSeries[]): PlannedEntry[] {
  const seen = new Map<string, number>()
  return documents.map(doc => {
    const partnerPath = partnerOf(doc)
    const op = doc.ops[0]
    // §11: a document number is not unique across suppliers. An operation with no document has only
    // what it does, and the same one twice on a day is told apart by its place in the file.
    const identity = doc.docType
      ? `doc|${doc.docType}|${doc.docNumber ?? ''}|${doc.date}|${partnerPath ?? ''}`
      : `op|${doc.date}|${op?.d ?? ''}|${op?.k ?? ''}|${op?.ad ?? ''}|${op?.ak ?? ''}`
    const nth = (seen.get(identity) ?? 0) + 1
    seen.set(identity, nth)

    const planned: PlannedEntry = {
      doc,
      importKey: nth === 1 ? identity : `${identity}#${nth}`,
      contentHash: sha256(contentOf(doc)),
      description: describe(doc),
    }
    if (partnerPath) planned.partnerPath = partnerPath
    const vat = vatOf(doc)
    if (vat !== undefined) planned.docVat = vat
    const branch = branchOf(doc, branches)
    if (branch) planned.branchOrgId = branch
    return planned
  })
}

/**
 * The hash an entry is stored with: its content, and what the org's data resolved it to. A link made
 * after an import (a contact on an analytic, a series on a branch) shows as `changed` on the next
 * re-import, which is what writes it onto the lines.
 */
export function importHashOf(entry: PlannedEntry, resolved: { branchOrgId: string; contactIds: readonly (string | undefined)[] }): string {
  return sha256(`${entry.contentHash}|${resolved.branchOrgId}|${resolved.contactIds.join(',')}`)
}

/**
 * The invoices a bank operation pays, on the line that takes them off the partner: `D503 K411` is on
 * 411. An operation with no comment of its own has the document's.
 */
export function settlesOfOperation(doc: ImportDocument, op: ImportOperation): { side: 'debit' | 'credit'; settles: { docType: string; docNumber: string }[] } | null {
  if (docTypeDef(doc.docType)?.family !== 'bank') return null
  const own = settlesOf(op.comment)
  const settles = own.length ? own : settlesOf(doc.comment)
  if (!settles.length) return null
  return { side: isBankAccount(op.d) && !isBankAccount(op.k) ? 'credit' : 'debit', settles }
}
