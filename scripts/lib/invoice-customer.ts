/**
 * An outgoing invoice linked to a contact other than the customer it prints. The sales register names the
 * partner through the invoice's contact (FR-25 R3), so such an invoice declares the wrong customer, and its
 * receivable sits on the wrong ledger.
 *
 * What it takes, and why each is safe to change:
 *   - `contactId`, to the contact holding the printed ЕИК or VAT number, however it is written there. Never a
 *     name match: a name several companies share is how these invoices were mislinked (#487). With no contact
 *     holding it, one is created from the printed party, with the fields the import gives a contact it creates.
 *   - `billingAddress`, to that contact's, the way the import sets it (`map-invoice.ts`).
 * Everything else is counted and left alone: equal already; the printed party names no company number; the
 * linked contact holds no number, so nothing says it is another company; several contacts hold the number,
 * or only a deactivated or supplier-only one; a draft; anything a till holds (a session, a receipt holding
 * it, a receipt that paid it, a cash sale naming the old customer); an invoice whose customer someone changed
 * after the import, on the form or with `--printed`, which its PDF does not overrule (a store can re-issue a
 * number to another customer after the PDF was exported).
 */
import { AuditLog, Contact, DocFile, Invoice } from '../../packages/db/src/models/index.js'
import { recordAuditEntry, type AuditEntry } from '../../packages/services/src/biz/audit-log.service.js'
import { partyAddressEntry } from '../../packages/services/src/biz/doc-import/matching.js'
import { draftFromLayoutText } from '../../packages/services/src/biz/doc-import/parse-table.js'
import { parsePartyAddresses } from '../../packages/services/src/biz/doc-import/parse-text.js'
import type { Party } from '../../packages/services/src/biz/doc-import/types.js'

/** A document whose original is not a PDF LGR holds: typed into LGR from another program's invoice. */
export interface PrintedDocument {
  invoiceNumber: string
  customer: Party
}

interface InvoiceAddress { street: string; city: string; postalCode: string; country: string; state?: string }

export interface CustomerPlan {
  id: string
  invoiceNumber: string
  source: 'pdf' | 'printed'
  /** What was read, which the write is conditional on. */
  before: { contactId: string; status: string; billingAddress: unknown }
  /** An existing contact, or the one to create. */
  target: { contactId: string } | { create: CreateContact }
  billingAddress: InvoiceAddress
}

export interface CreateContact {
  type: 'customer'
  companyName: string
  taxId?: string
  taxNumber?: string
  vatNumber?: string
  addresses: ReturnType<typeof partyAddressEntry>[]
}

export interface CustomerSurvey {
  plans: CustomerPlan[]
  /** Documents looked at, and what became of each, by reason. */
  counts: Record<string, number>
}

const DOC_TYPES = ['invoice', 'credit_note', 'debit_note']
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const compact = (v: unknown) => String(v ?? '').replace(/\s+/g, '').toUpperCase()
const clean = (v: unknown) => String(v ?? '').trim()

/**
 * The contacts holding a company number, however it is written: "999000258", "999 000 258" and "BG 999 000 258" are
 * one number. An exact match missed a contact stored with spaces, and the run then created a second one.
 */
function holdingNumber(orgId: unknown, ...numbers: string[]) {
  const wanted = [...new Set(numbers.map(digits).filter(d => d.length >= 9))]
  const anyFormat = (d: string) => new RegExp(`^\\D*${d.split('').join('\\D*')}\\D*$`)
  const or = wanted.flatMap(d => ['taxId', 'taxNumber', 'vatNumber'].map(field => ({ [field]: anyFormat(d) })))
  return { orgId, $or: or.length ? or : [{ _id: null }] }
}

/** The invoice's address from a contact address, defaulted as the import defaults it. */
function invoiceAddress(a: any): InvoiceAddress {
  return { street: clean(a?.street) || '-', city: clean(a?.city) || '-', postalCode: clean(a?.postalCode) || '-', country: clean(a?.country) || 'BG' }
}

/**
 * The printed party's company numbers: a nine- or thirteen-digit ЕИК, and the VAT number. A ten-digit number is
 * a person's, never a company's: those are left alone.
 */
function companyIds(party: Party | undefined): { eik: string; vat: string } | undefined {
  const eik = digits(party?.company_id)
  const vat = compact(party?.vat_id)
  const fromVat = /^BG\d{9}(\d{4})?$/.test(vat) ? vat.slice(2) : ''
  const company = eik.length === 9 || eik.length === 13 ? eik : fromVat
  return company ? { eik: company, vat } : undefined
}

async function planOne(orgId: unknown, inv: any, party: Party | undefined, source: CustomerPlan['source'], bump: (k: string) => void): Promise<CustomerPlan | undefined> {
  if (inv.status === 'draft') { bump('left: a draft'); return }
  const ids = companyIds(party)
  if (!ids) { bump('left: the printed customer has no company number'); return }
  if (!inv.contactId) { bump('left: no contact linked'); return }

  const current: any = await Contact.findOne({ _id: inv.contactId, orgId }).select('taxId taxNumber vatNumber').lean()
  const held = new Set([digits(current?.taxId), digits(current?.taxNumber), digits(current?.vatNumber)].filter(Boolean))
  if (held.has(ids.eik)) { bump('equal: the linked contact holds the printed number'); return }
  if (!held.size) { bump('left: the linked contact holds no company number, so nothing says it is another company'); return }
  // A store can re-issue an invoice under its number to another customer after its PDF was imported. Whoever
  // then moved it, a person on the form or a `--printed` run, knew better than the PDF: it is not moved back.
  if (source === 'pdf' && await customerChangedSinceImport(orgId, inv)) { bump('left: its customer was changed after the import, so its PDF is not the last word'); return }

  if (inv.register?.sessionId) { bump('left: in a till session'); return }
  if ((inv.receiptHolds ?? []).length) { bump('left: held by a payment receipt'); return }
  if (inv.cashSaleRef?.contactId && String(inv.cashSaleRef.contactId) === String(inv.contactId)) { bump('left: its cash sale names the same customer'); return }
  if (await Invoice.exists({ orgId, type: 'payment_receipt', 'register.paidInvoiceId': inv._id })) { bump('left: paid through a till receipt'); return }

  const holders: any[] = await Contact.find(holdingNumber(orgId, ids.eik, ids.vat)).select('type isActive addresses').lean()
  const usable = holders.filter(c => c.isActive !== false && (c.type === 'customer' || c.type === 'both'))
  const before = { contactId: String(inv.contactId), status: inv.status, billingAddress: inv.billingAddress }
  const base = { id: String(inv._id), invoiceNumber: inv.invoiceNumber, source, before }
  if (usable.length > 1) { bump('left: several contacts hold the printed number'); return }
  if (usable.length === 1) {
    const c = usable[0]
    const address = (c.addresses ?? []).find((a: any) => a.isDefault) ?? (c.addresses ?? [])[0]
    bump('to relink: to the contact holding the printed number')
    return { ...base, target: { contactId: String(c._id) }, billingAddress: invoiceAddress(address ?? (clean(party?.address) ? partyAddressEntry(clean(party?.address), clean(party?.city) || undefined) : undefined)) }
  }
  if (holders.length) { bump('left: only a deactivated or supplier-only contact holds the printed number'); return }
  const name = clean(party?.name)
  if (!name) { bump('left: no contact holds the printed number, and the print names no customer to create'); return }
  const addresses = clean(party?.address) ? [partyAddressEntry(clean(party?.address), clean(party?.city) || undefined)] : []
  bump('to relink: to a contact created from the print')
  return {
    ...base,
    target: { create: { type: 'customer', companyName: name, taxId: ids.eik, taxNumber: ids.eik, vatNumber: ids.vat || undefined, addresses } },
    billingAddress: invoiceAddress(addresses[0]),
  }
}

/** The invoice's last audited change of customer set the contact it has now: the form's edit audits it, and so does this. */
async function customerChangedSinceImport(orgId: unknown, inv: any): Promise<boolean> {
  const last: any = await AuditLog.findOne({ orgId, entityType: 'invoice', entityId: inv._id, 'changes.field': 'contactId' }).sort({ timestamp: -1 }).select('changes').lean()
  const change = (last?.changes ?? []).find((c: any) => c.field === 'contactId')
  return !!change && String(change.newValue) === String(inv.contactId)
}

const SELECT = 'invoiceNumber type status contactId billingAddress register receiptHolds cashSaleRef'

/** Every committed invoice PDF of the org, and every document of `printed`, against its contact. Reads only. */
export async function planInvoiceCustomers(orgId: unknown, printed: PrintedDocument[] = []): Promise<CustomerSurvey> {
  const counts: Record<string, number> = {}
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1 }
  const plans: CustomerPlan[] = []
  const files = DocFile.find({ orgId, docType: 'invoice', status: 'committed' }).select('extractedText committedIds').lean().cursor()
  for await (const f of files as any) {
    bump('committed invoice PDFs')
    const inv: any = await Invoice.findOne({ orgId, _id: { $in: f.committedIds ?? [] }, direction: 'outgoing', type: { $in: DOC_TYPES } }).select(SELECT).lean()
    if (!inv) { bump('left: no outgoing invoice behind the PDF'); continue }
    const text = String(f.extractedText ?? '')
    const read = draftFromLayoutText(text, 'invoice')?.extraction?.customer
    if (!read) { bump('left: the PDF reader takes no customer from it'); continue }
    // The reader leaves out the address; the import takes it from the party block, and so does this.
    const block = parsePartyAddresses(text).receiver
    const customer: Party = { ...read, address: clean(read.address) || block.street, city: clean(read.city) || block.city }
    const plan = await planOne(orgId, inv, customer, 'pdf', bump)
    if (plan) plans.push(plan)
  }
  for (const doc of printed) {
    bump('documents given by --printed')
    const found: any[] = await Invoice.find({ orgId, invoiceNumber: doc.invoiceNumber, direction: 'outgoing', type: { $in: DOC_TYPES } }).select(SELECT).limit(2).lean()
    if (found.length !== 1) { bump(`left: --printed names ${found.length ? 'several invoices' : 'no invoice'} by that number`); continue }
    if (plans.some(p => p.id === String(found[0]._id))) { bump('left: --printed repeats a PDF\'s invoice'); continue }
    const plan = await planOne(orgId, found[0], doc.customer, 'printed', bump)
    if (plan) plans.push(plan)
  }
  return { plans, counts }
}

/** The contacts a run creates: one per printed number. */
export function contactsToCreate(plans: CustomerPlan[]): Map<string, CreateContact> {
  const out = new Map<string, CreateContact>()
  for (const p of plans) if ('create' in p.target && p.target.create.taxId && !out.has(p.target.create.taxId)) out.set(p.target.create.taxId, p.target.create)
  return out
}

/** Create one contact, unless one holds its number by now. One AuditLog row. Returns its id. */
export async function createContact(orgId: unknown, c: CreateContact, by: unknown, reason: string): Promise<string> {
  const holder: any = await Contact.findOne(holdingNumber(orgId, c.taxId ?? '', c.vatNumber ?? '')).select('_id').lean()
  if (holder) throw new Error('a contact holds that number by now: run the dry run again')
  const created: any = await Contact.create({ orgId, ...c, isActive: true })
  await audited({
    orgId: String(orgId), userId: String(by), action: 'create', module: 'invoicing', entityType: 'contact', entityId: String(created._id), entityName: c.companyName,
    changes: [{ field: 'reason', oldValue: null, newValue: reason }],
  })
  return String(created._id)
}

/**
 * Write one plan. Conditional on the contact and status the plan read, so an invoice that changed since is left
 * alone (false). One AuditLog row names each field, before and after.
 */
export async function applyInvoiceCustomer(orgId: unknown, plan: CustomerPlan, targetId: string, by: unknown, reason: string): Promise<boolean> {
  const res = await Invoice.updateOne(
    { _id: plan.id, orgId, type: { $in: DOC_TYPES }, contactId: plan.before.contactId, status: plan.before.status },
    { $set: { contactId: targetId, billingAddress: plan.billingAddress } },
  ).exec()
  if (res.modifiedCount !== 1) return false
  await audited({
    orgId: String(orgId), userId: String(by), action: 'update', module: 'invoicing', entityType: 'invoice', entityId: plan.id, entityName: plan.invoiceNumber,
    changes: [
      { field: 'contactId', oldValue: plan.before.contactId, newValue: targetId },
      { field: 'billingAddress', oldValue: plan.before.billingAddress, newValue: plan.billingAddress },
      { field: 'reason', oldValue: null, newValue: reason },
    ],
  })
  return true
}

/** A correction is not done until its audit row is: a failed one stops the run. */
async function audited(entry: AuditEntry): Promise<void> {
  if (!(await recordAuditEntry(entry))) throw new Error(`the audit row for ${entry.entityType} ${entry.entityId} was not written; the change itself was`)
}
