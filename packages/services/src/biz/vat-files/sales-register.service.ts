import { Contact, DocFile, Invoice, Org, Product, VatRegisterEntry } from 'db/models'
import {
  compareSalesRegister, salesRegisterRow,
  type DerivedSalesRow, type FiledSalesRow, type RegisterComparison, type RegisterDocument, type SeriesOwner,
} from './sales-register.js'

/**
 * FR-25 R3: a books org's sales register for a month, derived from its branches' documents, and the
 * comparison with the one filed. Server-side: the rules are in `sales-register.ts`, which boots
 * nothing. Read-only, and reads across the books org's branches, so it is for the gate and the worker
 * only, never for a request (§3.1).
 */

export class SalesRegisterError extends Error {
  constructor(message: string, readonly code: 'not_a_books_org' | 'bad_period') {
    super(message)
    this.name = 'SalesRegisterError'
  }
}

export interface BooksBranches {
  booksOrgId: unknown
  branches: { orgId: unknown; code: string; docSeries?: string[] }[]
}

export async function booksBranches(booksOrgId: unknown): Promise<BooksBranches> {
  const org: any = await Org.findOne({ _id: booksOrgId }).select('settings.accounting.books').lean()
  const books = org?.settings?.accounting?.books
  if (books?.mode !== 'books' || !books.branches?.length) throw new SalesRegisterError('Not a books org with branches: link them first (scripts/link-books.ts)', 'not_a_books_org')
  return { booksOrgId, branches: books.branches }
}

/** When a voided document was voided: the last time its history says so. */
function voidedAt(doc: any): Date | undefined {
  const entries = (doc.statusHistory ?? []).filter((h: any) => h.status === 'voided' && h.changedAt)
  return entries.length ? new Date(entries[entries.length - 1].changedAt) : undefined
}

/** One branch's rows of `period`, and how many of its documents have none, by reason. */
async function branchRows(branch: BooksBranches['branches'][number], period: string, refusals: Record<string, number>): Promise<DerivedSalesRow[]> {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(4))
  // A day either side: the business day is Sofia's, and `salesRegisterRow` keeps only the period's.
  const from = new Date(Date.UTC(y, m - 1, 1) - 86_400_000), to = new Date(Date.UTC(y, m, 1) + 86_400_000)
  const kinds = { orgId: branch.orgId, direction: 'outgoing', type: { $in: ['invoice', 'credit_note', 'debit_note'] } }
  const docs: any[] = await Invoice.find({ ...kinds, issueDate: { $gte: from, $lt: to } })
    .select('invoiceNumber type status statusHistory tags issueDate currency subtotal discountTotal taxTotal total contactId lines.taxRate lines.productId').lean()
  // Annulled in this period, issued before it: their row of opposite sign belongs here, and is not
  // derived yet. Counted, so the month says it is missing them.
  const annulledOfEarlier = await Invoice.countDocuments({
    ...kinds, status: 'voided', issueDate: { $lt: from },
    statusHistory: { $elemMatch: { status: 'voided', changedAt: { $gte: from, $lt: to } } },
  })
  if (annulledOfEarlier) refusals[`${branch.code}: annulled this period, issued before it: no row derived`] = annulledOfEarlier

  const contactIds = [...new Set(docs.map(d => d.contactId).filter(Boolean).map(String))]
  const contacts = new Map((await Contact.find({ orgId: branch.orgId, _id: { $in: contactIds } }).select('taxId vatNumber companyName firstName lastName').lean() as any[]).map(c => [String(c._id), c]))
  const productIds = [...new Set(docs.flatMap(d => (d.lines ?? []).map((l: any) => l.productId)).filter(Boolean).map(String))]
  const services = new Set((await Product.find({ orgId: branch.orgId, _id: { $in: productIds }, type: 'service' }).select('_id').lean() as any[]).map(p => String(p._id)))
  // Imported from PlusMinus: every import path drafts through the document import, which tags the
  // draft and says so in its first status. The Files pipeline also keeps the PDF it came from, the
  // older CLI and the API import do not, so the PDF alone would count their documents as LGR's own.
  const withPdf = new Set((await DocFile.find({ orgId: branch.orgId, committedIds: { $in: docs.map(d => d._id) } }).select('committedIds').lean() as any[]).flatMap(f => (f.committedIds ?? []).map(String)))
  const isImported = (d: any) => withPdf.has(String(d._id)) || (d.tags ?? []).includes('ocr-import') || d.statusHistory?.[0]?.reason === 'ocr_import'

  const out: DerivedSalesRow[] = []
  for (const d of docs) {
    const c: any = d.contactId ? contacts.get(String(d.contactId)) : undefined
    const doc: RegisterDocument = {
      type: d.type, number: d.invoiceNumber, issueDate: d.issueDate, status: d.status, voidedAt: voidedAt(d), currency: d.currency,
      subtotal: d.subtotal, discountTotal: d.discountTotal, taxTotal: d.taxTotal, total: d.total,
      lines: (d.lines ?? []).map((l: any) => ({ taxRate: l.taxRate, service: !!l.productId && services.has(String(l.productId)) })),
      partner: c ? { vatNumber: c.vatNumber, taxId: c.taxId, name: c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') } : undefined,
    }
    const r = salesRegisterRow(doc, period)
    if ('row' in r) {
      out.push({ row: r.row, branch: branch.code, origin: isImported(d) ? 'imported' : 'native' })
    } else if (r.refused !== 'outside_the_period') {
      const k = `${branch.code}: no row derived (${r.refused}${r.detail ? `: ${r.detail}` : ''})`
      refusals[k] = (refusals[k] ?? 0) + 1
    }
  }
  return out
}

export interface SalesRegisterGate extends RegisterComparison {
  period: string
  filedRows: number
  derivedRows: number
  branches: string[]
  /** A row differs, or one side holds a branch's document the other does not. */
  gap: boolean
}

/** The sales register `period` derives to from the branches, against the one filed in the books org. */
export async function compareSalesRegisterOf(booksOrgId: unknown, period: string): Promise<SalesRegisterGate> {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) throw new SalesRegisterError(`Not a period: ${period}`, 'bad_period')
  const { branches } = await booksBranches(booksOrgId)
  const refusals: Record<string, number> = {}
  const derived: DerivedSalesRow[] = []
  for (const b of branches) derived.push(...await branchRows(b, period, refusals))
  const filed = await VatRegisterEntry.find({ orgId: booksOrgId, ledger: 'books', side: 'sales', period })
    .select('docTypeCode docNumber docDate partnerVat cells').lean() as unknown as FiledSalesRow[]
  const owners: SeriesOwner[] = branches.map(b => ({ branch: b.code, docSeries: b.docSeries ?? [] }))
  const { counts, details } = compareSalesRegister(derived, filed, owners)
  return {
    period,
    filedRows: filed.length,
    derivedRows: derived.length,
    branches: owners.map(o => o.branch),
    counts: { ...counts, ...refusals },
    details,
    gap: filed.length > 0 && Object.keys(counts).some(k => /differs|not filed|series: not in LGR|same number/.test(k)),
  }
}
