import { mongoose } from 'db/connection'
import { Contact, Product, ProductSupplier } from 'db/models'
import { buildSearchFilter, searchKeywords } from './search.utils.js'

const { Types } = mongoose

/**
 * FR-28.9 — what a person records about an article and one of its suppliers (`db/models/product-supplier.model.ts`).
 *
 * The facts of who sold us the article are READ from the documents (`product-suppliers.service.ts`) and stored
 * nowhere. This is the other half: a note a person writes, kept apart from them so a bill can never create, change
 * or delete it, and a recorded supplier with no document behind it is still a supplier the article has.
 *
 * Every id is checked against the organization of the route: a product or a supplier of another organization is
 * refused exactly as one that does not exist is, so the answer tells nothing about who holds what.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/i

export const SUPPLIER_SKU_MAX = 100
export const SUPPLIER_NOTE_MAX = 500
export const LEAD_TIME_MAX_DAYS = 3650

export class RecordedSupplierError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message)
    this.name = 'RecordedSupplierError'
  }
}

export interface RecordedSupplier {
  supplierId: string
  supplierName: string
  /**
   * False when the contact is no longer an active supplier (deactivated, or retyped as a customer). The record is
   * kept, and it can still be cleared, but ordering does not offer it (`getRecordedPreferred`).
   */
  supplierActive: boolean
  preferred: boolean
  supplierSku?: string
  leadTimeDays?: number
  note?: string
  updatedAt: Date
}

/** What a PUT carries. Every recorded field is replaced: one that is left out, or null, is cleared. */
export interface RecordedSupplierInput {
  preferred?: boolean
  supplierSku?: string | null
  leadTimeDays?: number | null
  note?: string | null
}

const oid = (v: unknown) => new Types.ObjectId(String(v))
const idStr = (v: unknown) => (v == null ? '' : String(v))
const nameOfContact = (c: any) => c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || ''
/** True for a contact an order may be placed with: a supplier (or both), not deactivated. */
const isOrderable = (c: any) => !!c && (c.type === 'supplier' || c.type === 'both') && c.isActive !== false

function wellFormed(id: string): boolean {
  return OBJECT_ID.test(id)
}

function clean(text: string | null | undefined, max: number): string | undefined {
  const t = (text ?? '').trim()
  if (!t) return undefined
  if (t.length > max) throw new RecordedSupplierError(422, 'too_long', `At most ${max} characters.`)
  return t
}

function cleanLeadTime(v: number | null | undefined): number | undefined {
  if (v == null) return undefined
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > LEAD_TIME_MAX_DAYS) {
    throw new RecordedSupplierError(422, 'invalid_lead_time', `The lead time is a whole number of days, 0 to ${LEAD_TIME_MAX_DAYS}.`)
  }
  return v
}

function present(row: any, contact: any): RecordedSupplier {
  return {
    supplierId: idStr(row.supplierId),
    supplierName: nameOfContact(contact),
    supplierActive: isOrderable(contact),
    preferred: !!row.preferred,
    ...(row.supplierSku ? { supplierSku: row.supplierSku } : {}),
    ...(row.leadTimeDays != null ? { leadTimeDays: row.leadTimeDays } : {}),
    ...(row.note ? { note: row.note } : {}),
    updatedAt: row.updatedAt,
  }
}

async function contactsById(orgId: string, ids: string[]): Promise<Map<string, any>> {
  const wanted = [...new Set(ids.filter(wellFormed))]
  if (!wanted.length) return new Map()
  const rows: any[] = await Contact.find(
    { orgId: oid(orgId), _id: { $in: wanted.map(oid) } } as any,
    { companyName: 1, firstName: 1, lastName: 1, type: 1, isActive: 1 },
  ).lean().exec()
  return new Map(rows.map((c) => [idStr(c._id), c]))
}

/** The recorded suppliers of one article: the preferred one first, then by name. */
export async function listRecordedSuppliers(orgId: string, productId: string): Promise<RecordedSupplier[]> {
  if (!wellFormed(productId)) return []
  const rows: any[] = await ProductSupplier.find({ orgId: oid(orgId), productId: oid(productId) } as any).lean().exec()
  if (!rows.length) return []
  const contacts = await contactsById(orgId, rows.map((r) => idStr(r.supplierId)))
  return rows
    .map((r) => present(r, contacts.get(idStr(r.supplierId))))
    .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.supplierName.localeCompare(b.supplierName) || a.supplierId.localeCompare(b.supplierId))
}

async function assertProduct(orgId: string, productId: string): Promise<any> {
  const product = wellFormed(productId)
    ? await Product.findOne({ _id: oid(productId), orgId: oid(orgId) } as any, { name: 1 }).lean().exec()
    : null
  if (!product) throw new RecordedSupplierError(404, 'product_not_found', 'Product not found')
  return product
}

/** The supplier must be a contact of THIS organization, of type supplier or both, and active. */
async function assertSupplier(orgId: string, supplierId: string): Promise<any> {
  const contact: any = wellFormed(supplierId)
    ? await Contact.findOne({ _id: oid(supplierId), orgId: oid(orgId) } as any, { companyName: 1, firstName: 1, lastName: 1, type: 1, isActive: 1 }).lean().exec()
    : null
  if (!contact) throw new RecordedSupplierError(422, 'supplier_not_found', 'That contact does not exist in this organization.')
  if (contact.type !== 'supplier' && contact.type !== 'both') throw new RecordedSupplierError(422, 'not_a_supplier', 'That contact is not a supplier.')
  if (contact.isActive === false) throw new RecordedSupplierError(422, 'supplier_inactive', 'That supplier is deactivated.')
  return contact
}

const isDuplicateKey = (e: any) => e?.code === 11000 || /E11000/.test(String(e?.message || ''))
/** Each lost race costs the loser one more round, and every round has a winner: a handful of callers never run out. */
const MAX_ATTEMPTS = 8

export interface RecordedSupplierWrite {
  supplier: RecordedSupplier
  created: boolean
  /** What the row said before (absent when it is new): the audit entry's old value. */
  previous?: RecordedSupplier
  /** The supplier that stopped being preferred because this one took over. */
  displacedPreferred?: string
  productName: string
}

/**
 * FR-28.9: record, or change, what is written about an article and a supplier. The row is replaced as a whole
 * (the fields left out are cleared); the facts the documents give are not touched, because they are not here.
 *
 * `preferred` is unique per article. Setting it clears the previous one FIRST and sets this one second, and the
 * partial unique index holds the line: two callers racing to prefer different suppliers can never leave two, the
 * loser's write is refused by the index and retried (the clear then takes the winner's flag). Between the two writes
 * the article has none, which reads as "no recorded preference" and falls back to the last purchase.
 */
export async function recordSupplier(
  orgId: string,
  productId: string,
  supplierId: string,
  input: RecordedSupplierInput,
): Promise<RecordedSupplierWrite> {
  const product = await assertProduct(orgId, productId)
  const contact = await assertSupplier(orgId, supplierId)

  const supplierSku = clean(input.supplierSku, SUPPLIER_SKU_MAX)
  const note = clean(input.note, SUPPLIER_NOTE_MAX)
  const leadTimeDays = cleanLeadTime(input.leadTimeDays)
  const preferred = input.preferred === true

  const key = { orgId: oid(orgId), productId: oid(productId), supplierId: oid(supplierId) }
  const before: any = await ProductSupplier.findOne(key as any).lean().exec()
  const $set: Record<string, unknown> = { preferred }
  const $unset: Record<string, ''> = {}
  if (supplierSku !== undefined) { $set.supplierSku = supplierSku; $set.supplierSkuLower = supplierSku.toLocaleLowerCase('bg') }
  else { $unset.supplierSku = ''; $unset.supplierSkuLower = '' }
  if (leadTimeDays !== undefined) $set.leadTimeDays = leadTimeDays
  else $unset.leadTimeDays = ''
  if (note !== undefined) $set.note = note
  else $unset.note = ''
  const update: Record<string, unknown> = { $set }
  if (Object.keys($unset).length) update.$unset = $unset

  let displacedPreferred: string | undefined
  let row: any
  for (let attempt = 0; ; attempt++) {
    if (preferred) {
      const others: any[] = await ProductSupplier.find({ ...key, supplierId: { $ne: key.supplierId }, preferred: true } as any, { supplierId: 1 }).lean().exec()
      if (others.length) {
        await ProductSupplier.updateMany({ _id: { $in: others.map((o) => o._id) }, preferred: true } as any, { $set: { preferred: false } }).exec()
        displacedPreferred = idStr(others[0].supplierId)
      }
    }
    try {
      row = await ProductSupplier.findOneAndUpdate(key as any, update as any, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec()
      break
    } catch (e) {
      // A racing preferred (the partial index) or a racing first write of the same row (the unique triple): the
      // retry re-reads the state, so it clears what the winner set, or updates what it created.
      if (isDuplicateKey(e) && attempt < MAX_ATTEMPTS - 1) continue
      if (isDuplicateKey(e)) throw new RecordedSupplierError(409, 'preferred_conflict', 'Another supplier was made preferred at the same time. Try again.')
      throw e
    }
  }

  const supplier = present(row, contact)
  const previous = before ? present(before, contact) : undefined
  return { supplier, created: !before, ...(previous ? { previous } : {}), ...(displacedPreferred ? { displacedPreferred } : {}), productName: (product as any).name || '' }
}

export interface RecordedSupplierDelete {
  deleted: boolean
  previous?: RecordedSupplier
  productName: string
}

/**
 * FR-28.9: clear what is recorded about an article and a supplier. A supplier the documents name stays listed with
 * its facts: they are read, not stored, and nothing here can remove them. Clearing a row that is not there is not an
 * error (a second click, a second tab).
 */
export async function clearRecordedSupplier(orgId: string, productId: string, supplierId: string): Promise<RecordedSupplierDelete> {
  const product = await assertProduct(orgId, productId)
  const productName = (product as any).name || ''
  if (!wellFormed(supplierId)) return { deleted: false, productName }
  const gone: any = await ProductSupplier.findOneAndDelete({ orgId: oid(orgId), productId: oid(productId), supplierId: oid(supplierId) } as any).lean().exec()
  if (!gone) return { deleted: false, productName }
  const contacts = await contactsById(orgId, [supplierId])
  return { deleted: true, previous: present(gone, contacts.get(supplierId)), productName }
}

// ── What the other questions ask ────────────────────────────────────────────────────────────────────

/**
 * The articles that have a recorded link to any of these suppliers (the Products list's Supplier filter: a recorded
 * link counts beside the documents, §2.3).
 */
export async function findRecordedProductIdsBySuppliers(orgId: string, supplierIds: string[]): Promise<string[]> {
  const suppliers = [...new Set(supplierIds.filter(wellFormed))].map(oid)
  if (!suppliers.length) return []
  const ids = await ProductSupplier.distinct('productId', { orgId: oid(orgId), supplierId: { $in: suppliers } } as any).exec()
  return ids.map(idStr)
}

/** Every article with at least one recorded supplier (so "No supplier" does not list it). */
export async function findRecordedProductIds(orgId: string): Promise<Set<string>> {
  const ids = await ProductSupplier.distinct('productId', { orgId: oid(orgId) } as any).exec()
  return new Set(ids.map(idStr))
}

/**
 * The recorded PREFERRED supplier of each article, for the articles that have one and whose contact an order may still
 * be placed with. A deactivated or retyped supplier is skipped: a recorded preference is a standing decision that goes
 * stale when the supplier stops being one, while the purchases are history and keep naming it.
 */
export async function getRecordedPreferred(orgId: string, productIds: string[]): Promise<Map<string, string>> {
  const pids = [...new Set(productIds.filter(wellFormed))].map(oid)
  const out = new Map<string, string>()
  if (!pids.length) return out
  const rows: any[] = await ProductSupplier.find({ orgId: oid(orgId), productId: { $in: pids }, preferred: true } as any, { productId: 1, supplierId: 1 }).lean().exec()
  if (!rows.length) return out
  const contacts = await contactsById(orgId, rows.map((r) => idStr(r.supplierId)))
  for (const r of rows) {
    if (isOrderable(contacts.get(idStr(r.supplierId)))) out.set(idStr(r.productId), idStr(r.supplierId))
  }
  return out
}

export interface RecordedSupplierName {
  supplierId: string
  supplierName: string
  preferred: boolean
}

/**
 * The recorded suppliers of each of these articles, named, in any state of the contact (the Products list's Suppliers
 * column names who the article is bought from, deactivated or not, as the facts do; the order preview narrows them to
 * the ones an order may be placed with). The preferred one first, then by name. Articles with none are not in the map.
 */
export async function getRecordedSupplierNames(orgId: string, productIds: string[]): Promise<Map<string, RecordedSupplierName[]>> {
  const pids = [...new Set(productIds.filter(wellFormed))].map(oid)
  const out = new Map<string, RecordedSupplierName[]>()
  if (!pids.length) return out
  const rows: any[] = await ProductSupplier.find({ orgId: oid(orgId), productId: { $in: pids } } as any, { productId: 1, supplierId: 1, preferred: 1 }).lean().exec()
  if (!rows.length) return out
  const contacts = await contactsById(orgId, rows.map((r) => idStr(r.supplierId)))
  for (const r of rows) {
    const list = out.get(idStr(r.productId)) ?? []
    list.push({ supplierId: idStr(r.supplierId), supplierName: nameOfContact(contacts.get(idStr(r.supplierId))), preferred: !!r.preferred })
    out.set(idStr(r.productId), list)
  }
  for (const list of out.values()) {
    list.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.supplierName.localeCompare(b.supplierName) || a.supplierId.localeCompare(b.supplierId))
  }
  return out
}

/**
 * FR-28.10: the articles whose RECORDED supplier code matches a keyword of the search, per keyword (the search is an
 * AND of its keywords, each of which may match any field, this one included). Runs on the lowered mirror with the
 * Cyrillic-safe filter builder, never a RegExp literal: a Cyrillic pattern from Bun reaches Mongo as `\uXXXX` and
 * fails (PCRE2 error 51091). Look-alike Latin and Cyrillic letters count as one, as in the article's own SKU.
 */
export async function findProductIdsBySupplierCode(orgId: string, search: string): Promise<string[][]> {
  const keywords = searchKeywords(search)
  const out: string[][] = []
  for (const keyword of keywords) {
    const filter = buildSearchFilter(keyword, ['supplierSku'], { lowered: { supplierSku: 'supplierSkuLower' }, homoglyphs: true })
    const ids = await ProductSupplier.distinct('productId', { orgId: oid(orgId), ...filter } as any).exec()
    out.push(ids.map(idStr))
  }
  return out
}
