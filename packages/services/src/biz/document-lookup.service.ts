import type { Model } from 'mongoose'
import { Contact, InternalOrder, Invoice, Order, Reservation, StockMovement } from 'db/models'
import { QUOTE_TYPES } from 'config/constants'
import type { CapabilityId } from 'config/access'
import {
  LOOKUP_LIMIT, lookupNumber, lookupSpellings, prefixPattern,
  type LookupAnswer, type LookupFamily, type LookupMatch,
} from 'config/document-lookup'
import { can, type AccessCaller } from './access/evaluate.js'
import { TILL_DOCUMENT_TYPES } from './cash-register/pos-union.js'
import { originOf } from './cash-register/journal.service.js'

/**
 * FR-31.22 (#796, slice B5) — jump to a document by its number.
 *
 * One read over the documents a number names: the invoices of every type, supplier orders (`Order`), customer orders
 * (`InternalOrder`), reservations and stock movements. The number matches exactly first: the document's number, or the
 * draft number an issued invoice or order had (`draftNumber`). Only when nothing matches exactly is it taken as the
 * start of a number, and then at most `LOOKUP_LIMIT` documents are listed.
 *
 * A family is searched only when the caller may open its page (`FAMILY_CAPS`, the capabilities of
 * `config/access/pages.ts`): a document the caller may not read is never found, so the lookup reveals nothing a list
 * would not. The invoices are split as the partitions split them (`config/access/partition.ts`), with the till's
 * documents on their own, since they open in the cash-register journal.
 *
 * ⚠ Every query reads through an index on the number (FR-31.22's last clause, `integration/document-lookup.flow`):
 * the unique `{ orgId, <number> }` keys, `Invoice { orgId, direction, invoiceNumber }`, and the partial
 * `{ orgId, draftNumber }` of invoices and orders. A spelling is an exact value or an anchored prefix, both of which
 * an index reads as a range; never a case-insensitive pattern, which reads the whole index.
 */

/** What opens each family's page: the page's own capability (`config/access/pages.ts`). */
const FAMILY_CAPS: Readonly<Record<LookupFamily, readonly CapabilityId[]>> = {
  sales: ['sales-docs.view'],
  proforma: ['proforma.view'],
  bill: ['bills.view'],
  cash: ['cash-sales.view'],
  supplierOrder: ['orders.view', 'orders.browse'],
  customerOrder: ['orders.view'],
  reservation: ['orders.view'],
  movement: ['movements.view'],
}

/** The families this caller may open. */
export function lookupFamilies(user: AccessCaller | null | undefined): Set<LookupFamily> {
  const out = new Set<LookupFamily>()
  for (const [family, caps] of Object.entries(FAMILY_CAPS) as Array<[LookupFamily, readonly CapabilityId[]]>) {
    if (can(user, caps)) out.add(family)
  }
  return out
}

const CASH_TYPES: readonly string[] = TILL_DOCUMENT_TYPES
const QUOTES: readonly string[] = QUOTE_TYPES

/** The family of an invoice: incoming is a bill, then a quote, then a till document, and the rest are sales documents. */
export function invoiceFamily(doc: { direction?: string | null; type?: string | null }): LookupFamily {
  if (doc.direction === 'incoming') return 'bill'
  if (QUOTES.includes(String(doc.type))) return 'proforma'
  if (CASH_TYPES.includes(String(doc.type))) return 'cash'
  return 'sales'
}

/**
 * The outgoing invoices this caller may find, as a filter on `type`: `{}` for all of them, null for none. With the
 * sales documents among them it names what is left out (the sales documents are "every other type").
 */
function outgoingTypes(families: Set<LookupFamily>): Record<string, unknown> | null {
  const typesOf: Record<'proforma' | 'cash', readonly string[]> = { proforma: QUOTES, cash: CASH_TYPES }
  const sales = families.has('sales')
  const shown = (['proforma', 'cash'] as const).filter(f => families.has(f))
  if (!sales && !shown.length) return null
  if (sales && shown.length === 2) return {}
  if (sales) return { type: { $nin: (['proforma', 'cash'] as const).filter(f => !families.has(f)).flatMap(f => typesOf[f]) } }
  return { type: { $in: shown.flatMap(f => typesOf[f]) } }
}

interface Row {
  _id: unknown
  [field: string]: unknown
}

/** One indexed query: the org, the number condition on one field, the family's own filter. */
async function rows(model: Model<any>, orgId: string, field: string, cond: Record<string, unknown>, extra: Record<string, unknown>, limit: number): Promise<Row[]> {
  // A draft number is kept by few documents: its index is partial, and the query states the index's condition.
  const onField = field === 'draftNumber' ? { $exists: true, ...cond } : cond
  return model.find({ orgId, ...extra, [field]: onField }).sort({ [field]: 1 }).limit(limit).lean<Row[]>().exec()
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v))
const iso = (v: unknown): string | undefined => {
  if (!v) return undefined
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

interface Found {
  match: LookupMatch
  contactId?: string
}

/** Every document whose number (or draft number) meets `cond`, up to `limit` per query, of the families given. */
async function search(orgId: string, families: Set<LookupFamily>, cond: Record<string, unknown>, limit: number): Promise<Found[]> {
  const out: Found[] = []
  const viaDraft = (row: Row, field: string) => (field === 'draftNumber' ? { draftNumber: str(row.draftNumber) } : {})
  const jobs: Array<Promise<void>> = []

  // Invoices, one side at a time, so each query reads `{ orgId, direction, invoiceNumber }`.
  const sides: Array<[string, Record<string, unknown>]> = []
  if (families.has('bill')) sides.push(['incoming', {}])
  const outgoing = outgoingTypes(families)
  if (outgoing) sides.push(['outgoing', outgoing])
  for (const [direction, types] of sides) {
    for (const field of ['invoiceNumber', 'draftNumber']) {
      jobs.push(rows(Invoice, orgId, field, cond, { direction, ...types }, limit).then(found => {
        for (const r of found) {
          const family = invoiceFamily({ direction: str(r.direction), type: str(r.type) })
          out.push({
            contactId: str(r.contactId),
            match: {
              family, id: String(r._id), number: String(r.invoiceNumber ?? ''), type: str(r.type), status: str(r.status),
              date: iso(r.issueDate), ...viaDraft(r, field), ...(family === 'cash' ? { origin: originOf(r) } : {}),
            },
          })
        }
      }))
    }
  }

  const orderFamilies: Array<[LookupFamily, Model<any>]> = [['supplierOrder', Order], ['customerOrder', InternalOrder]]
  for (const [family, model] of orderFamilies) {
    if (!families.has(family)) continue
    for (const field of ['orderNumber', 'draftNumber']) {
      jobs.push(rows(model, orgId, field, cond, {}, limit).then(found => {
        for (const r of found) {
          // A supplier order names its suppliers per group; the first one stands for it, as on its list.
          const groups = Array.isArray(r.supplierGroups) ? (r.supplierGroups as Array<{ supplierId?: unknown }>) : []
          out.push({
            contactId: str(family === 'supplierOrder' ? groups[0]?.supplierId : r.contactId),
            match: { family, id: String(r._id), number: String(r.orderNumber ?? ''), status: str(r.status), date: iso(r.issueDate), ...viaDraft(r, field) },
          })
        }
      }))
    }
  }

  if (families.has('reservation')) {
    jobs.push(rows(Reservation, orgId, 'reservationNumber', cond, {}, limit).then(found => {
      for (const r of found) {
        out.push({
          contactId: str(r.contactId),
          match: { family: 'reservation', id: String(r._id), number: String(r.reservationNumber ?? ''), status: str(r.status), date: iso(r.createdAt) },
        })
      }
    }))
  }

  if (families.has('movement')) {
    jobs.push(rows(StockMovement, orgId, 'movementNumber', cond, {}, limit).then(found => {
      for (const r of found) {
        out.push({
          contactId: str(r.contactId),
          match: { family: 'movement', id: String(r._id), number: String(r.movementNumber ?? ''), type: str(r.type), status: str(r.status), date: iso(r.date) },
        })
      }
    }))
  }

  await Promise.all(jobs)
  return out
}

/** The contacts' names, read in the org (S-35: a stored id is resolved inside its own org only). */
async function contactNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Map()
  const found = await Contact.find({ _id: { $in: unique }, orgId }, { companyName: 1, firstName: 1, lastName: 1 })
    .lean<Array<{ _id: unknown; companyName?: string; firstName?: string; lastName?: string }>>().exec()
  return new Map(found.map(c => [String(c._id), c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')]))
}

/** The documents a number names, for this caller. */
export async function lookupDocuments(orgId: string, user: AccessCaller | null | undefined, raw: unknown): Promise<LookupAnswer> {
  const number = lookupNumber(raw)
  const families = lookupFamilies(user)
  if (!number || !families.size) return { number, exact: true, matches: [], more: false }
  const spellings = lookupSpellings(number)

  let exact = true
  let found = await search(orgId, families, { $in: spellings }, LOOKUP_LIMIT + 1)
  if (!found.length) {
    exact = false
    found = await search(orgId, families, { $in: spellings.map(prefixPattern) }, LOOKUP_LIMIT + 1)
  }

  // A document found by its number and by its draft number is one match.
  const seen = new Set<string>()
  const unique = found.filter(f => {
    const key = `${f.match.family}:${f.match.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) => (a.match.draftNumber ?? a.match.number).localeCompare(b.match.draftNumber ?? b.match.number) || a.match.family.localeCompare(b.match.family))
  const listed = unique.slice(0, LOOKUP_LIMIT)
  const names = await contactNames(orgId, listed.flatMap(f => (f.contactId ? [f.contactId] : [])))
  const matches = listed.map(f => {
    const contactName = f.contactId ? names.get(f.contactId) : undefined
    return contactName ? { ...f.match, contactName } : f.match
  })
  return { number, exact, matches, more: unique.length > LOOKUP_LIMIT }
}
