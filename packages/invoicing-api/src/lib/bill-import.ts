/**
 * Orchestration for OCR-drafted invoices — a PlusMinus → LGR migration importer.
 * Auto-detects direction by matching the org's ЕИК against the invoice parties:
 *   org == ДОСТАВЧИК (supplier)  → outgoing SALES invoice, counterparty = customer
 *   org == ПОЛУЧАТЕЛ (customer)  → incoming BILL,           counterparty = supplier
 *   neither                      → default outgoing (sales) + needs-review
 * Preserves the original document number on convert (INV-<original>) and bumps the
 * sequence counter so future LGR numbers continue past it. Sales dispatch allows
 * negative stock (items may not be in the warehouse yet during migration).
 */
import { getRepos } from 'services/context'
import { buildSearchFilter } from 'services/biz/search.utils'
import { createInvoiceStockMovement } from 'services/biz/invoicing.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { getDisplayPrefix, ensureSequenceAtLeast } from 'services/biz/sequence.service'
import { Contact, Product, Warehouse, Org } from 'db/models'
import { getNextInvoiceNumber, getNextDraftInvoiceNumber, sequenceKeyFor, prefixFor } from '../controllers/invoice.controller.js'

interface Party { name?: string | null; company_id?: string | null; vat_id?: string | null; address?: string | null; iban?: string | null }
interface LineItem { description: string; quantity?: number | null; unit?: string | null; unit_price?: number | null; vat_rate?: number | null; total?: number | null }
export interface InvoiceExtraction {
  document_number?: string | null; issue_date?: string | null; due_date?: string | null
  currency?: string | null; exchange_rate?: number | null
  supplier: Party; customer: Party; line_items: LineItem[]
  net_total?: number | null; vat_total?: number | null; gross_total?: number | null
  payment_terms?: string | null; notes?: string | null
}
export interface DraftResult {
  extraction: InvoiceExtraction
  validation: { status: 'valid' | 'needs_review'; checks: any[] }
  model: string
  engine: string
}

const clean = (v: unknown): string => (v == null ? '' : String(v)).trim()
const digits = (v: unknown): string => clean(v).replace(/\D/g, '')
const num = (v: unknown, d = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** Does a party's ЕИК/VAT match the org's tax number? (compare on digits, tolerating a BG prefix). */
function partyIsOrg(orgEik: string, p: Party): boolean {
  if (!orgEik) return false
  return digits(p?.company_id) === orgEik || digits(p?.vat_id) === orgEik
}

interface Direction {
  direction: 'outgoing' | 'incoming'
  counterparty: Party
  contactType: 'customer' | 'supplier'
  uncertain: boolean
}
function detectDirection(org: any, ext: InvoiceExtraction): Direction {
  const orgEik = digits(org?.taxNumber) || digits(org?.vatNumber)
  const sup = ext.supplier || {}
  const cust = ext.customer || {}
  if (partyIsOrg(orgEik, sup)) return { direction: 'outgoing', counterparty: cust, contactType: 'customer', uncertain: false }
  if (partyIsOrg(orgEik, cust)) return { direction: 'incoming', counterparty: sup, contactType: 'supplier', uncertain: false }
  // Fallback: assume it's one of our own sales invoices, flag for review.
  return { direction: 'outgoing', counterparty: cust, contactType: 'customer', uncertain: true }
}

/** Billing address entry from a one-line extracted address (no postal code in legacy docs). */
function partyAddressEntry(address: string) {
  return { type: 'billing', street: address, country: 'BG', isDefault: true }
}

/** Match (or create) a Contact of the given type from an extracted party. */
export async function matchContact(orgId: string, party: Party, type: 'customer' | 'supplier'): Promise<{ contactId: string; name: string; created: boolean } | null> {
  const eik = clean(party?.company_id)
  const vat = clean(party?.vat_id)
  const name = clean(party?.name)
  const address = clean(party?.address)
  const typeIn = { type: { $in: [type, 'both'] } }

  let c: any = null
  if (eik) c = await Contact.findOne({ orgId, ...typeIn, taxId: eik }).lean()
  if (!c && vat) c = await Contact.findOne({ orgId, ...typeIn, vatNumber: vat }).lean()
  if (!c && name) {
    const f = buildSearchFilter(name, ['companyName'], { lowered: { companyName: 'companyNameLower' } })
    c = await Contact.findOne({ orgId, ...typeIn, ...f }).lean()
  }
  if (c) {
    // Enrich matched contacts that predate proper field mapping: the EIK belongs in
    // taxNumber (the "Tax Number (EIK)" form field) as well as taxId, and the address
    // in the structured addresses[] — not in notes.
    const set: any = {}
    const cEik = eik || digits(vat)
    if (!clean(c.taxNumber) && cEik) set.taxNumber = cEik
    if (!clean(c.taxId) && cEik) set.taxId = cEik
    if (!(c.addresses || []).length && address) set.addresses = [partyAddressEntry(address)]
    if (Object.keys(set).length) await Contact.updateOne({ _id: c._id }, { $set: set })
    return { contactId: String(c._id), name: c.companyName || name, created: false }
  }
  if (!name) return null

  const created: any = await Contact.create({
    orgId, type, companyName: name,
    taxId: eik || digits(vat) || undefined,
    taxNumber: eik || digits(vat) || undefined,
    vatNumber: vat || undefined,
    addresses: address ? [partyAddressEntry(address)] : [],
    isActive: true,
  })
  return { contactId: String(created._id), name, created: true }
}

export async function matchProduct(orgId: string, description: string): Promise<{ productId: string; name: string; unit?: string } | null> {
  const name = clean(description)
  if (!name) return null
  const f = buildSearchFilter(name, ['name', 'sku'], { lowered: { name: 'nameLower', sku: 'skuLower' } })
  const p: any = await Product.findOne({ orgId, isActive: true, ...f }).lean()
  return p ? { productId: String(p._id), name: p.name, unit: p.unit } : null
}

function toAddress(a: any) {
  return {
    street: clean(a?.street) || '-', city: clean(a?.city) || '-',
    postalCode: clean(a?.postalCode) || '-', country: clean(a?.country) || 'BG',
  }
}

/** Map the invoice's "Плащане:" value (or the AI's payment_terms) to our enum. */
export function parsePaymentMethod(rawText: string, aiPaymentTerms?: string | null): string | undefined {
  const m = /Плащане\s*:\s*([^\n]+)/i.exec(rawText || '')
  const v = clean(m?.[1]) || clean(aiPaymentTerms)
  if (!v) return undefined
  if (/сметка|превод|transfer/i.test(v)) return 'bank_transfer'
  if (/брой|cash/i.test(v)) return 'cash'
  if (/карта|card/i.test(v)) return 'card'
  if (/чек|check/i.test(v)) return 'check'
  return undefined
}

/**
 * Pull the standard legal clauses off the invoice into `terms`:
 *  - the ЗДДС/ДОПК personal-data consent block ("Получателят е дал съгласие …")
 *  - the no-stamp/signature clause ("Съгласно чл.6, ал.1 от ЗСч. …")
 * Multi-line blocks are joined until an empty line or a new labelled section.
 */
export function parseTerms(rawText: string): string | undefined {
  const lines = (rawText || '').split('\n').map(l => l.trim())
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^(Получателят е дал съгласие|Съгласно чл)/i.test(lines[i])) {
      const block = [lines[i]]
      while (i + 1 < lines.length && lines[i + 1] && !/^(Съгласно чл|Получател\s*:|Съставил|Дата|Банка|IBAN|ФАКТУРА|Плащане)/i.test(lines[i + 1])) {
        block.push(lines[++i])
      }
      blocks.push(block.join('\n'))
    }
  }
  return blocks.length ? blocks.map(b => `- ${b}`).join('\n\n') : undefined
}

/** Create a DRAFT invoice (sales or bill, auto-detected) from an extraction. */
export async function createDraftInvoice(orgId: string, userId: string, draft: DraftResult, warehouseId: string, batchId: string, rawText = '') {
  const r = getRepos()
  const ext = draft.extraction
  const org: any = await Org.findById(orgId).lean()
  const dir = detectDirection(org, ext)
  const contact = await matchContact(orgId, dir.counterparty, dir.contactType)
  const wh: any = await Warehouse.findOne({ orgId, _id: warehouseId }).lean()
  const billingAddress = toAddress(wh?.address)

  const lines: any[] = []
  const perLine: { description: string; matched: boolean; productId: string | null }[] = []
  for (const li of ext.line_items || []) {
    const desc = clean(li.description)
    if (!desc) continue
    const match = await matchProduct(orgId, desc)
    const qty = num(li.quantity)
    const price = num(li.unit_price)
    const taxRate = li.vat_rate != null ? num(li.vat_rate) : 20
    const lineTotal = li.total != null ? num(li.total) : +(qty * price).toFixed(2)
    const taxAmount = +((lineTotal * taxRate) / 100).toFixed(2)
    lines.push({
      productId: match?.productId, description: desc, quantity: qty,
      unit: match?.unit || clean(li.unit) || 'бр', unitPrice: price, discount: 0,
      taxRate, taxAmount, lineTotal, warehouseId: match ? warehouseId : undefined,
    })
    perLine.push({ description: desc, matched: !!match, productId: match?.productId || null })
  }

  const subtotal = ext.net_total != null ? num(ext.net_total) : +lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2)
  const taxTotal = ext.vat_total != null ? num(ext.vat_total) : +lines.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
  const total = ext.gross_total != null ? num(ext.gross_total) : +(subtotal + taxTotal).toFixed(2)
  const currency = clean(ext.currency) || 'BGN'
  const exchangeRate = ext.exchange_rate != null ? num(ext.exchange_rate, 1) : 1
  const issueDate = ext.issue_date ? new Date(ext.issue_date) : new Date()
  const dueDate = ext.due_date ? new Date(ext.due_date) : new Date(issueDate.getTime() + 30 * 86_400_000)
  const draftNumber = await getNextDraftInvoiceNumber(orgId, dir.direction, 'invoice')

  const tags = ['ocr-import', `ocr:${batchId}`, `dir:${dir.direction}`]
  if (dir.uncertain || draft.validation?.status === 'needs_review') tags.push('needs-review')

  const invoice: any = await r.invoices.create({
    orgId, type: 'invoice', direction: dir.direction,
    contactId: contact?.contactId,
    invoiceNumber: draftNumber, draftNumber,
    // Original PlusMinus document number — preserved as the issued number on convert.
    reference: clean(ext.document_number) || undefined,
    issueDate, dueDate, currency, exchangeRate,
    lines, subtotal, discountTotal: 0, taxTotal, total,
    totalBase: +(total * exchangeRate).toFixed(2), amountDue: total, amountPaid: 0,
    paymentMethod: parsePaymentMethod(rawText, ext.payment_terms),
    terms: parseTerms(rawText),
    notes: clean(ext.notes) || undefined, billingAddress,
    status: 'draft',
    statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: 'ocr_import' }],
    numberHistory: draftNumber ? [{ number: draftNumber, allocatedAt: new Date(), status: 'draft' }] : [],
    createdBy: userId, tags,
  } as any)

  return { invoice, contact, perLine, direction: dir.direction, uncertain: dir.uncertain }
}

/** Convert a draft (sales → sent / bill → received): preserve the original number, move stock. */
export async function convertDraftInvoice(orgId: string, invoiceId: string, userId: string): Promise<{ ok: boolean; invoiceNumber?: string; direction?: string; error?: string }> {
  const r = getRepos()
  const invoice: any = await r.invoices.findOne({ id: invoiceId, orgId } as any)
  if (!invoice) return { ok: false, error: 'not found' }
  if (invoice.status !== 'draft') return { ok: false, error: 'not in draft status' }

  const direction = invoice.direction as string
  const type = invoice.type as string
  const draftNumber = invoice.invoiceNumber
  const year = new Date().getFullYear()

  // Preserve the original document number as INV-<original> and bump the counter past it,
  // so future auto-allocated numbers continue beyond the migrated set.
  const orig = clean(invoice.reference)
  let issuedNumber: string
  if (/^\d+$/.test(orig)) {
    const display = await getDisplayPrefix(orgId, prefixFor(type, direction))
    issuedNumber = `${display}-${orig}`
    await ensureSequenceAtLeast(orgId, sequenceKeyFor(type, direction), year, Number(orig))
  } else {
    issuedNumber = await getNextInvoiceNumber(orgId, direction, type)
  }

  const newStatus = direction === 'outgoing' ? 'sent' : 'received'
  const statusHistory = [...(invoice.statusHistory || []), { status: newStatus, fromStatus: invoice.status, changedAt: new Date(), changedBy: userId }]
  const numberHistory = [...(invoice.numberHistory || []), { number: issuedNumber, allocatedAt: new Date(), status: newStatus }]
  const updated = await r.invoices.update(invoiceId, {
    status: newStatus, sentAt: new Date(), statusHistory, invoiceNumber: issuedNumber, draftNumber, numberHistory,
  } as any)

  // allowNegative — migration dispatches items that may not be in the warehouse yet.
  await createInvoiceStockMovement(updated || invoice, userId, undefined, { allowNegative: true })
  createAuditEntry({
    orgId, userId, action: newStatus, module: 'invoicing', entityType: 'invoice',
    entityId: invoiceId, entityName: issuedNumber, changes: { invoiceNumber: { from: draftNumber, to: issuedNumber } },
  })
  return { ok: true, invoiceNumber: issuedNumber, direction }
}
