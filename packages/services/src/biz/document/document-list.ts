import { partitionFilter } from 'config/access'
import { getRepos } from '../../context.js'
import { grantOf } from '../access/evaluate.js'
import { invoicedCashSaleIds, invoicingByCashSale } from '../cash-sale-invoice.service.js'
import { printsOnPayment } from '../cash-register/payment-receipt.service.js'
import { REGISTER_TYPES } from '../cash-register/pos-union.js'
import { BULGARIAN_TIME_ZONE, localDayWindow } from '../local-day.js'
import { NOT_PAYMENT_RECEIPT } from '../sale-counting.js'
import { buildSearchFilter } from '../search.utils.js'

/**
 * FR-32.21 (#797): what the invoice list reads and how its rows are drawn, and the history a document shows. The
 * route keeps the read itself (`GET /invoices`); this builds its filter and its rows.
 */

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'cash_on_delivery', 'other']

/** A list's type filter names cash-register documents only: a cash sale, a storno, or both. */
export function onlyRegisterTypes(type: unknown): boolean {
  const asked: any = type
  const list = typeof asked === 'string' ? [asked] : Array.isArray(asked?.$in) ? asked.$in : []
  return list.length > 0 && list.every((t: string) => (REGISTER_TYPES as readonly string[]).includes(t))
}

/**
 * Filter documents by payment method. A document matches when any of its recorded
 * payments (`payments[].method`) uses one of the requested methods, or — for documents
 * carrying only the header-level method (unpaid / imported docs) — when `paymentMethod` does.
 * Accepts "cash,card" or an array. Returns null when nothing valid was requested.
 */
export function buildPaymentMethodFilter(raw: string | string[]): Record<string, any> | null {
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map(s => String(s).trim())
    .filter(s => PAYMENT_METHODS.includes(s))
  if (!list.length) return null
  return { $or: [{ 'payments.method': { $in: list } }, { paymentMethod: { $in: list } }] }
}

// Produce a viewable history when legacy rows have no statusHistory yet, using
// the known status-change timestamps (createdAt, sentAt, paidAt). Read-only synthesis —
// does not persist.
export function synthesizeStatusHistory(invoice: any): any[] {
  if (Array.isArray(invoice.statusHistory) && invoice.statusHistory.length > 0) {
    return invoice.statusHistory
  }
  const entries: any[] = []
  if (invoice.createdAt) {
    entries.push({ status: 'draft', changedAt: invoice.createdAt, reason: 'created (reconstructed)' })
  }
  if (invoice.sentAt) {
    const sentStatus = invoice.direction === 'incoming' ? 'received' : 'sent'
    entries.push({ status: sentStatus, fromStatus: 'draft', changedAt: invoice.sentAt, reason: 'reconstructed' })
  }
  if (invoice.paidAt && invoice.status === 'paid') {
    entries.push({ status: 'paid', changedAt: invoice.paidAt, reason: 'reconstructed' })
  }
  if (invoice.status && !entries.find(e => e.status === invoice.status)) {
    entries.push({ status: invoice.status, changedAt: invoice.updatedAt || invoice.createdAt, reason: 'reconstructed' })
  }
  return entries
}

/**
 * FR-30.10: a document's lines with their article's name and SKU (`productName`, `productSku`), read in one query. A
 * line whose article is gone gets empty ones, as the form showed when its read of the article failed.
 */
export async function withLineArticles(orgId: string, lines: any[] | undefined): Promise<any[] | undefined> {
  if (!Array.isArray(lines) || !lines.length) return undefined
  const ids = [...new Set(lines.map((l) => (l?.productId ? String(l.productId) : '')).filter(Boolean))]
  if (!ids.length) return undefined
  const products = await getRepos().products.findMany({ orgId, id: { $in: ids } }, undefined, { select: ['name', 'sku'] })
  const byId = new Map(products.map((p: any) => [String(p.id), p]))
  return lines.map((l) => {
    if (!l?.productId) return l
    const p: any = byId.get(String(l.productId))
    return { ...l, productName: p?.name ?? '', productSku: p?.sku ?? '' }
  })
}

/** The org's time zone, which a cash-register document's day is counted in. */
async function timeZoneOf(orgId: string): Promise<string> {
  const org: any = await getRepos().orgs.findById(orgId)
  return org?.settings?.timezone || BULGARIAN_TIME_ZONE
}

/** What `GET /invoices` reads: the list's query, within the kinds the session reads. */
export async function listFilter(orgId: string, query: any, user: any): Promise<Record<string, any>> {
  const r = getRepos()

  const filter: Record<string, any> = { orgId }
  if (query.search) {
    // Two-stage search: search invoices by their fields + contacts by name
    const searchStr = query.search as string
    const invoiceFilter = buildSearchFilter(searchStr, ['invoiceNumber', 'notes', 'reference'])
    // Also find contacts matching the search
    const contactFilter = buildSearchFilter(searchStr, ['companyName', 'firstName', 'lastName'], {
      lowered: {
        companyName: 'companyNameLower',
        firstName: 'firstNameLower',
        lastName: 'lastNameLower',
      },
    })
    // Their ids only: the search read every matching contact whole (FR-30.7).
    const ofContacts: any = { orgId, ...contactFilter }
    const matchingContacts = await r.contacts.findMany(ofContacts, undefined, { select: ['id'] })
    const contactIds = matchingContacts.map((c: any) => c.id || c._id)

    if (contactIds.length > 0 && invoiceFilter.$or) {
      // Combine: invoice fields match OR contactId in matching contacts
      filter.$or = [...invoiceFilter.$or, { contactId: { $in: contactIds } }]
    } else if (contactIds.length > 0 && invoiceFilter.$and) {
      filter.$or = [invoiceFilter, { contactId: { $in: contactIds } }]
    } else {
      Object.assign(filter, invoiceFilter)
    }
  }
  if (query.type) filter.type = query.type
  // `types` (comma-separated) supports the Reporting Outgoing tab → invoice + credit_note + debit_note in one query.
  if (query.types) {
    const list = String(query.types).split(',').map(s => s.trim()).filter(Boolean)
    if (list.length === 1) filter.type = list[0]
    else if (list.length > 1) filter.type = { $in: list }
  }
  // FR-23: a payment's receipt is not a document of these lists. It has its own, the journal.
  if (!filter.type) Object.assign(filter, NOT_PAYMENT_RECEIPT)
  if (query.direction) filter.direction = query.direction
  // FR-27.6 (FR-26.6): the kinds the role reads, whatever the list asks for.
  const part = partitionFilter(grantOf(user))
  if (part && 'direction' in part) filter.direction = part.direction
  else if (part) filter.$and = [...(filter.$and ?? []), part]
  if (query.status) {
    const list = String(query.status).split(',').map(s => s.trim()).filter(Boolean)
    if (list.length === 1) filter.status = list[0]
    else if (list.length > 1) filter.status = { $in: list }
  }
  if (query.contactId) filter.contactId = query.contactId
  if (query.tags) {
    const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
    filter.tags = { $in: tagList }
  }
  if (query.paymentMethod) {
    const cond = buildPaymentMethodFilter(query.paymentMethod as string | string[])
    // $and, not $or — the search branch above may already own filter.$or.
    if (cond) (filter.$and ||= []).push(cond)
  }
  if (query.startDate || query.endDate) {
    // A cash-register document carries the moment of sale, so it is counted in the org's days,
    // as the journal counts it: `new Date(endDate)` is 00:00 UTC and lost the last day's till
    // sales. Every other document keeps a date-only issueDate.
    const window = onlyRegisterTypes(filter.type)
      ? localDayWindow(query.startDate, query.endDate, await timeZoneOf(orgId))
      : null
    if (window) filter.issueDate = window
    else {
      filter.issueDate = {}
      if (query.startDate) filter.issueDate.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.issueDate.$lte = new Date(query.endDate as string)
    }
  }
  // Cash sales list: `invoiced=yes` keeps the cash sales an invoice was issued for, `no` the rest.
  if (query.invoiced === 'yes' || query.invoiced === 'no') {
    const ids = (await invoicedCashSaleIds(orgId)).map(String)
    filter.id = query.invoiced === 'yes' ? { $in: ids } : { $nin: ids }
  }
  return filter
}

/** The list's rows: each document with the names its row shows, as `GET /invoices` answers them. */
export async function listRows(orgId: string, items: any[]): Promise<any[]> {
  const r = getRepos()

  // #171: a cash sale lists the invoices issued for it (the link lives only on the invoices).
  const cashSaleIds = items.filter((i: any) => i.type === 'cash_sale').map((i: any) => String(i.id))
  const invoicing = cashSaleIds.length ? await invoicingByCashSale(orgId, cashSaleIds) : new Map()
  // FR-23: what a Pay on the row prints, as the server will decide it.
  const printing = await printsOnPayment(orgId, items)

  // Manual batch lookups to replace .populate()
  const contactIds = new Set<string>()
  const relatedInvoiceIds = new Set<string>()
  for (const item of items) {
    if (item.contactId) contactIds.add(item.contactId)
    if (item.convertedInvoiceId) relatedInvoiceIds.add(item.convertedInvoiceId)
    if (item.proformaId) relatedInvoiceIds.add(item.proformaId)
    if (item.offerId) relatedInvoiceIds.add(item.offerId)
    if (item.relatedInvoiceId) relatedInvoiceIds.add(item.relatedInvoiceId)
  }

  const ofContacts: any = { orgId, id: { $in: [...contactIds] } }
  const [contacts, relatedInvoices] = await Promise.all([
    // What the rows take of them, and no more (FR-30.7): a related document was read with its lines.
    contactIds.size > 0 ? r.contacts.findMany(ofContacts, undefined, { select: ['companyName', 'firstName', 'lastName', 'email'] }) : [],
    relatedInvoiceIds.size > 0 ? r.invoices.findMany({ orgId, id: { $in: [...relatedInvoiceIds] } }, undefined, { select: ['invoiceNumber', 'type'] }) : [],
  ])

  const contactMap = new Map<string, any>(contacts.map((c: any) => [c.id, c]))
  const invoiceMap = new Map<string, any>(relatedInvoices.map((i: any) => [i.id, i]))

  return items.map((item: any) => {
    const contact = item.contactId ? contactMap.get(item.contactId) : null
    const convertedInv = item.convertedInvoiceId ? invoiceMap.get(item.convertedInvoiceId) : null
    const proformaInv = item.proformaId ? invoiceMap.get(item.proformaId) : null
    const offerInv = item.offerId ? invoiceMap.get(item.offerId) : null
    const relatedInv = item.relatedInvoiceId ? invoiceMap.get(item.relatedInvoiceId) : null
    return {
      ...item,
      number: item.invoiceNumber,
      contactName: contact
        ? (contact.companyName || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '')
        : '',
      // FR-10 (#19): the list-row "send by email" action prefills the recipient from here,
      // so opening the dialog costs no extra round trip. The contacts are already loaded.
      contactEmail: contact ? (contact.email || '') : '',
      convertedInvoiceNumber: convertedInv?.invoiceNumber || '',
      // An offer becomes a proforma or an invoice: the row links to the form of what it became.
      convertedInvoiceType: convertedInv?.type || '',
      proformaNumber: proformaInv?.invoiceNumber || '',
      offerNumber: offerInv?.invoiceNumber || '',
      relatedInvoiceNumber: relatedInv?.invoiceNumber || '',
      ...(item.type === 'cash_sale'
        ? { invoices: invoicing.get(String(item.id))?.invoices || [], invoicingState: invoicing.get(String(item.id))?.state || 'none' }
        : {}),
      ...(item.cashSaleRef ? { cashSaleId: String(item.cashSaleRef.cashSaleId), cashSaleNumber: item.cashSaleRef.number } : {}),
      statusHistory: synthesizeStatusHistory(item),
      printsOnPayment: printing.get(String(item.id)) ?? [],
    }
  })
}
