import { registerDocTypeCode } from 'config/journal-header'
import type { ProductGroupSource } from 'db/models'
import { REGISTER_DOC_TYPES, registerNumber } from '../vat-files/sales-register.js'
import { docTypeDef } from './registry.js'

/**
 * FR-25 R3, its first slice: the accounting group each product's sales book to (§3.6), proposed from
 * what the accountant typed (§6.1), and how much of the stores' sales such a map covers.
 *
 * Import-pure: `product-groups.service.ts` loads the books entries, the LGR documents, the products
 * and the map, and writes what `planProductGroups` decides.
 *
 * The rules, in the order they apply:
 *   - Only a sales document of the org's own series is paired (R7: a store org holds its own; the home
 *     also holds the tills' months and a store outside LGR, which no LGR document carries). It pairs
 *     with LGR's outgoing invoice, debit or credit note of the same number, as the sales register's
 *     gate pairs them (`vat-files/sales-register.ts`): the last ten digits, leading zeros dropped, and of
 *     two LGR documents under one number the imported one. A number LGR does not hold, two candidates
 *     with neither or both imported, and a register type that differs are counted, never guessed.
 *   - A document whose books operations name ONE group, with the same total quantity as LGR's goods
 *     lines, maps every product on it to that group.
 *   - Otherwise the books must restate it line for line (as many goods operations as goods lines), and
 *     a line maps where its quantity is unique on both sides.
 *   - A product whose documents name more than one group is a conflict: counted, never mapped.
 *   - `exact` goes first (§6.1): the product's name is the name of one active group.
 *
 * ⚠ Quantities are compared, never values: the books carry the group's cost and the net, LGR the price.
 */

/** Statuses of an LGR document that is no document (`sale-counting.ts`). */
export const NOT_A_DOCUMENT: readonly string[] = ['draft', 'voided', 'cancelled']

/**
 * A document the books can carry under its number. A voided one stays: an annulment is booked under
 * the number of what it annuls, and the groups typed for it are still the accountant's.
 */
export const NOT_ISSUED: readonly string[] = ['draft', 'cancelled']

/** LGR's documents that are the books' sales documents: what the sales register derives rows from. */
export const SALES_DOCUMENT_TYPES: readonly string[] = Object.keys(REGISTER_DOC_TYPES)

/** LGR's till sales. A storno is stored positive. */
export const TILL_TYPES: readonly string[] = ['cash_sale', 'cash_storno']

/** The rows a line posts by. `rule` and `ai` are suggestions (§6.1), and post nothing until reviewed. */
export const POSTABLE_SOURCES: ReadonlySet<ProductGroupSource> = new Set<ProductGroupSource>(['exact', 'learned', 'accountant'])

/** What learning writes, and so may also change or remove. */
const OWN_SOURCES: ReadonlySet<ProductGroupSource> = new Set<ProductGroupSource>(['exact', 'learned'])

// ── where a books entry belongs ──────────────────────────────────────────────────────────────────

export interface OrgSeries {
  /** The org's own sales series: the documents it issues in LGR. */
  own: readonly string[]
  /** The series of the group's other stores in LGR. */
  otherStores: readonly string[]
  /** The series of a store of the same legal entity that sells outside LGR. */
  outside: readonly string[]
}

export type EntryPlace = 'own' | 'till' | 'outside' | 'other_store' | 'no_series'

/** Where a books entry's document belongs, or nothing when it is no sales document. */
export function placeOf(entry: { docType?: string; docNumber?: string }, series: OrgSeries): EntryPlace | undefined {
  const def = docTypeDef(entry.docType)
  if (def?.family !== 'sales') return undefined
  if (def.till) return 'till'
  // As `journal-plan.ts#branchOf` decides whose a document is.
  const number = String(entry.docNumber ?? '')
  const inSeries = (list: readonly string[]) => !!number && list.some(s => !!s && number.startsWith(s))
  if (inSeries(series.own)) return 'own'
  if (inSeries(series.outside)) return 'outside'
  if (inSeries(series.otherStores)) return 'other_store'
  return 'no_series'
}

// ── pairing ──────────────────────────────────────────────────────────────────────────────────────

/** One operation of a books entry that names a goods group, with the operation's quantity. */
export interface BooksGoodsOp {
  groupId: string
  quantity: number
}

export interface BooksSalesEntry {
  docType: string
  docNumber: string
  /** `1` invoice, `2` debit notice, `3` credit notice, as booked. */
  registerDocType?: string
  goods: readonly BooksGoodsOp[]
  /** An operation names two goods groups (a regrouping): the document teaches nothing. */
  mixed?: boolean
}

export interface LgrLine {
  productId?: string
  quantity: number
  /** A line on a service: no group, in either source. */
  service?: boolean
}

export interface LgrSalesDocument {
  id: string
  type: string
  /** As LGR shows it, display prefix and all. */
  number: string
  /** The business day in Sofia. */
  day: Date
  /** Imported from PlusMinus (`sales-register.service.ts`: `markedImported`, `committedFromFiles`). */
  imported: boolean
  /** Inside the run's period. Only these can be "in LGR, not in the books": the rest are loaded to pair across its edges. */
  inPeriod: boolean
  lines: readonly LgrLine[]
}

export interface PairedDocument {
  doc: LgrSalesDocument
  /** An invoice and its annulment carry one number: both are its entries. */
  entries: BooksSalesEntry[]
}

export interface PairingCounts {
  /** Entries of the org's own series. */
  entries: number
  pairedEntries: number
  pairedDocuments: number
  /** Its number is not one of LGR's documents. */
  notInLgr: number
  /** Its number is not digits. */
  noNumber: number
  /** LGR holds several documents of the number, and not exactly one of them is imported. */
  ambiguous: number
  /** LGR's document of the number is of another register type (an invoice against a credit notice). */
  typeDiffers: number
  /** LGR documents of the period whose number no entry of the series names. */
  notInBooks: number
}

const stripZeros = (digits: string) => digits.replace(/^0+(?=\d)/, '')

/** A books number as pairing matches it: digits, leading zeros dropped. */
export function booksNumberKey(docNumber: string | undefined): string | undefined {
  const s = String(docNumber ?? '').trim()
  return /^\d+$/.test(s) ? stripZeros(s) : undefined
}

/** An LGR number as pairing matches it: the register's ten digits, leading zeros dropped. */
export function lgrNumberKey(number: string): string | undefined {
  const digits = registerNumber(number)
  return digits ? stripZeros(digits) : undefined
}

/** Each entry of the org's own series with the one LGR document of its number, and what could not be paired. */
export function pairDocuments(entries: readonly BooksSalesEntry[], documents: readonly LgrSalesDocument[]): { paired: PairedDocument[]; counts: PairingCounts } {
  const counts: PairingCounts = { entries: entries.length, pairedEntries: 0, pairedDocuments: 0, notInLgr: 0, noNumber: 0, ambiguous: 0, typeDiffers: 0, notInBooks: 0 }
  const byNumber = new Map<string, LgrSalesDocument[]>()
  for (const d of documents) {
    const k = lgrNumberKey(d.number)
    if (k) byNumber.set(k, [...(byNumber.get(k) ?? []), d])
  }
  const named = new Set<string>()
  const paired = new Map<string, PairedDocument>()
  for (const e of entries) {
    const k = booksNumberKey(e.docNumber)
    if (!k) { counts.noNumber++; continue }
    named.add(k)
    let candidates = byNumber.get(k) ?? []
    if (!candidates.length) { counts.notInLgr++; continue }
    const code = registerDocTypeCode(e.registerDocType)
    if (code) {
      candidates = candidates.filter(d => REGISTER_DOC_TYPES[d.type] === code)
      if (!candidates.length) { counts.typeDiffers++; continue }
    }
    const imported = candidates.filter(d => d.imported)
    const doc = candidates.length === 1 ? candidates[0] : imported.length === 1 ? imported[0] : undefined
    if (!doc) { counts.ambiguous++; continue }
    counts.pairedEntries++
    const p = paired.get(doc.id)
    if (p) p.entries.push(e)
    else paired.set(doc.id, { doc, entries: [e] })
  }
  counts.pairedDocuments = paired.size
  counts.notInBooks = documents.filter(d => d.inPeriod && !named.has(lgrNumberKey(d.number) ?? '')).length
  return { paired: [...paired.values()], counts }
}

// ── evidence ─────────────────────────────────────────────────────────────────────────────────────

export type EvidenceOutcome =
  /** One group, and the books' quantity is LGR's: every product on the document maps to it. */
  | 'one_group'
  /** Line for line, and at least one quantity unique on both sides. */
  | 'line_for_line'
  /** Line for line, and no quantity unique on both sides. */
  | 'no_unique_quantity'
  /** Neither one group with LGR's quantity, nor as many goods operations as goods lines. */
  | 'not_line_for_line'
  | 'no_goods_in_books'
  | 'no_goods_in_lgr'
  | 'two_groups_in_one_operation'

export interface GroupVote {
  productId: string
  groupId: string
}

export interface LineCounts {
  /** LGR's goods lines (not on a service). */
  goods: number
  byOneGroup: number
  byQuantity: number
  /** A product line no rule matched. */
  notMatched: number
  /** Typed with no product: nothing to map. */
  noProduct: number
}

export interface DocumentEvidence {
  outcome: EvidenceOutcome
  /** The books name one group, at another total quantity than LGR's: the line-for-line rule ran instead. */
  oneGroupQuantityDiffers: boolean
  /** One per product and group. */
  votes: GroupVote[]
  lines: LineCounts
}

/** Quantities as the books keep them, in thousandths, the sign dropped: a correction is negative on its side. */
const qtyKey = (q: number) => Math.round(Math.abs(Number(q) || 0) * 1000)

function countBy<T>(items: readonly T[], key: (t: T) => number): Map<number, number> {
  const out = new Map<number, number>()
  for (const t of items) out.set(key(t), (out.get(key(t)) ?? 0) + 1)
  return out
}

function dedupe(votes: readonly GroupVote[]): GroupVote[] {
  const seen = new Map<string, GroupVote>()
  for (const v of votes) seen.set(`${v.productId}|${v.groupId}`, v)
  return [...seen.values()]
}

/** What one books entry says about the products of the LGR document it is paired with. */
export function evidenceOf(entry: BooksSalesEntry, doc: LgrSalesDocument): DocumentEvidence {
  const goodsLines = doc.lines.filter(l => !l.service)
  const noProduct = goodsLines.filter(l => !l.productId).length
  const lines: LineCounts = { goods: goodsLines.length, byOneGroup: 0, byQuantity: 0, notMatched: goodsLines.length - noProduct, noProduct }
  const none = (outcome: EvidenceOutcome, oneGroupQuantityDiffers = false): DocumentEvidence => ({ outcome, oneGroupQuantityDiffers, votes: [], lines })
  if (entry.mixed) return none('two_groups_in_one_operation')
  if (!entry.goods.length) return none('no_goods_in_books')
  if (!goodsLines.length) return none('no_goods_in_lgr')

  const groups = [...new Set(entry.goods.map(o => o.groupId))]
  let oneGroupQuantityDiffers = false
  if (groups.length === 1) {
    const books = entry.goods.reduce((s, o) => s + qtyKey(o.quantity), 0)
    const lgr = goodsLines.reduce((s, l) => s + qtyKey(l.quantity), 0)
    if (books === lgr) {
      const votes = dedupe(goodsLines.filter(l => l.productId).map(l => ({ productId: String(l.productId), groupId: groups[0] })))
      return { outcome: 'one_group', oneGroupQuantityDiffers: false, votes, lines: { ...lines, byOneGroup: lines.notMatched, notMatched: 0 } }
    }
    // A goods line the books carry elsewhere (as a service), or a line they left out: not every product is the group's.
    oneGroupQuantityDiffers = true
  }

  // Booked per group rather than per line, a quantity can be a sum of lines and equal another line by chance.
  if (entry.goods.length !== goodsLines.length) return none('not_line_for_line', oneGroupQuantityDiffers)
  const inBooks = countBy(entry.goods, o => qtyKey(o.quantity))
  const inLgr = countBy(goodsLines, l => qtyKey(l.quantity))
  const votes: GroupVote[] = []
  for (const op of entry.goods) {
    const k = qtyKey(op.quantity)
    if (inBooks.get(k) !== 1 || inLgr.get(k) !== 1) continue
    const line = goodsLines.find(l => qtyKey(l.quantity) === k)
    if (!line?.productId) continue
    votes.push({ productId: String(line.productId), groupId: op.groupId })
    lines.byQuantity++
  }
  lines.notMatched -= lines.byQuantity
  return { outcome: votes.length ? 'line_for_line' : 'no_unique_quantity', oneGroupQuantityDiffers, votes: dedupe(votes), lines }
}

/** A paired document's evidence: every entry's votes, and the counts of the entry that teaches the most. */
export function evidenceOfDocument(p: PairedDocument): DocumentEvidence {
  const all = p.entries.map(e => evidenceOf(e, p.doc))
  const best = all.reduce((a, b) => (b.votes.length > a.votes.length ? b : a))
  return { ...best, votes: dedupe(all.flatMap(e => e.votes)) }
}

/** Per product, per group: how many documents name it, and the latest one's day. */
export type Evidence = Map<string, Map<string, { docs: number; last: Date }>>

export function tallyEvidence(items: readonly { doc: LgrSalesDocument; votes: readonly GroupVote[] }[]): Evidence {
  const out: Evidence = new Map()
  for (const { doc, votes } of items) {
    for (const v of dedupe(votes)) {
      const groups = out.get(v.productId) ?? new Map<string, { docs: number; last: Date }>()
      const g = groups.get(v.groupId)
      if (g) {
        g.docs++
        if (doc.day > g.last) g.last = doc.day
      } else {
        groups.set(v.groupId, { docs: 1, last: doc.day })
      }
      out.set(v.productId, groups)
    }
  }
  return out
}

// ── exact names ──────────────────────────────────────────────────────────────────────────────────

/** Latin letters whose lower-case glyph is a Cyrillic one's (`doc-import/matching.ts#foldHomoglyphs`). */
const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
}

/**
 * A name as `exact` compares it: Unicode NFC, trimmed, every run of white space one space, lower case
 * in the `bg` locale, and a Latin letter that looks like a Cyrillic one read as the Cyrillic one (a
 * product typed with a Latin `K` is the same name on paper). Nothing else is folded: a dot, a dash
 * or a digit is part of the name.
 */
export function groupNameKey(name: string): string {
  const s = String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('bg')
  return [...s].map(c => LATIN_TO_CYRILLIC[c] ?? c).join('')
}

export interface GoodsGroup {
  id: string
  /** The analytic's own name, the last segment of its path. */
  name: string
  active: boolean
}

/** Each product whose name is the name of exactly one active group, and how many name two or more. */
export function exactGroupsOf(products: readonly { id: string; name: string }[], groups: readonly GoodsGroup[]): { byProduct: Map<string, string>; ambiguous: number } {
  const byName = new Map<string, string[]>()
  for (const g of groups) {
    if (!g.active) continue
    const k = groupNameKey(g.name)
    if (k) byName.set(k, [...(byName.get(k) ?? []), g.id])
  }
  const byProduct = new Map<string, string>()
  let ambiguous = 0
  for (const p of products) {
    const hits = byName.get(groupNameKey(p.name))
    if (!hits) continue
    if (hits.length === 1) byProduct.set(p.id, hits[0])
    else ambiguous++
  }
  return { byProduct, ambiguous }
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────

export interface MapRow {
  /** Set on a stored row. */
  id?: string
  productId: string
  analyticId: string
  source: ProductGroupSource
  evidenceCount: number
  conflictCount: number
  lastEvidenceAt?: Date
  reviewedAt?: Date
}

/** The accountant's row: nothing automatic changes or removes it. */
export const isAccountants = (row: Pick<MapRow, 'source' | 'reviewedAt'>): boolean => row.source === 'accountant' || !!row.reviewedAt

export interface ProductCounts {
  /** Products that are not a service. */
  goods: number
  /** Proposed `exact`: the name of one active group. */
  exact: number
  /** Their names are the names of two or more active groups: not mapped by name. */
  exactAmbiguous: number
  /** Proposed `learned`: every document of theirs names the same group. */
  learned: number
  /** Their documents name more than one group: not mapped (to review). */
  conflicts: number
  /** Conflicts in which a single document disagrees with all the others. */
  conflictsOfOneDocument: number
  /** Every document names one group, which is no longer active: not mapped. */
  inactiveGroup: number
  /** The accountant's rows, left as they are. */
  accountants: number
  /** No row a line posts by after the run (none, or a suggestion). */
  unmapped: number
}

export interface MapPlan {
  create: MapRow[]
  update: { from: MapRow; to: MapRow }[]
  remove: MapRow[]
  unchanged: number
  /** The map after the plan, by product. */
  after: Map<string, MapRow>
  products: ProductCounts
}

const sameRow = (a: MapRow, b: MapRow) =>
  a.analyticId === b.analyticId && a.source === b.source && a.evidenceCount === b.evidenceCount && a.conflictCount === b.conflictCount &&
  (a.lastEvidenceAt?.getTime() ?? null) === (b.lastEvidenceAt?.getTime() ?? null)

/**
 * The map's rows after a run, and the writes that make them so. Idempotent: run on its own result, it
 * plans nothing. `evidence` is the run's period only, so a product without any there keeps its row and
 * its counts from an earlier run; one whose evidence now disagrees loses a learned row, as a conflict is
 * never mapped. An exact row goes when its name no longer is its group's. A `rule` or `ai` row is
 * replaced by evidence and otherwise left alone.
 */
export function planProductGroups(input: {
  /** The org's products that are not a service. */
  goodsProducts: readonly string[]
  exact: ReadonlyMap<string, string>
  exactAmbiguous: number
  evidence: Evidence
  activeGroups: ReadonlySet<string>
  existing: readonly MapRow[]
}): MapPlan {
  const plan: MapPlan = {
    create: [], update: [], remove: [], unchanged: 0, after: new Map(),
    products: {
      goods: input.goodsProducts.length, exact: 0, exactAmbiguous: input.exactAmbiguous, learned: 0, conflicts: 0, conflictsOfOneDocument: 0,
      inactiveGroup: 0, accountants: 0, unmapped: 0,
    },
  }
  const existing = new Map(input.existing.map(r => [r.productId, r]))
  const products = new Set([...input.goodsProducts, ...input.exact.keys(), ...input.evidence.keys(), ...existing.keys()])
  const c = plan.products

  for (const productId of [...products].sort()) {
    const row = existing.get(productId)
    if (row && isAccountants(row)) {
      c.accountants++
      plan.after.set(productId, row)
      continue
    }
    const groups = input.evidence.get(productId)
    const exactGroup = input.exact.get(productId)
    // `undefined`: this run has nothing to say about it. `null`: it must not be mapped by learning.
    let desired: MapRow | null | undefined
    if (exactGroup) {
      c.exact++
      // A period that does not name the product keeps the counts an earlier one gave its row, as for a learned row.
      if (!groups && row?.source === 'exact' && row.analyticId === exactGroup) {
        plan.unchanged++
        plan.after.set(productId, row)
        continue
      }
      const own = groups?.get(exactGroup)
      let others = 0
      for (const [g, s] of groups ?? []) if (g !== exactGroup) others += s.docs
      desired = { productId, analyticId: exactGroup, source: 'exact', evidenceCount: own?.docs ?? 0, conflictCount: others, ...(own ? { lastEvidenceAt: own.last } : {}) }
    } else if (groups?.size === 1) {
      const [[groupId, s]] = [...groups.entries()]
      if (input.activeGroups.has(groupId)) {
        desired = { productId, analyticId: groupId, source: 'learned', evidenceCount: s.docs, conflictCount: 0, lastEvidenceAt: s.last }
        c.learned++
      } else {
        desired = null
        c.inactiveGroup++
      }
    } else if (groups && groups.size > 1) {
      desired = null
      c.conflicts++
      const docs = [...groups.values()].map(s => s.docs)
      if (docs.reduce((a, b) => a + b, 0) - Math.max(...docs) === 1) c.conflictsOfOneDocument++
    }

    if (desired === undefined) {
      // An exact row whose name no longer is its group's has lost its ground; a learned one keeps its period's.
      if (row?.source === 'exact') plan.remove.push(row)
      else if (row) { plan.unchanged++; plan.after.set(productId, row) }
    } else if (desired === null) {
      if (row && OWN_SOURCES.has(row.source)) plan.remove.push(row)
      else if (row) { plan.unchanged++; plan.after.set(productId, row) }
    } else if (!row) {
      plan.create.push(desired)
      plan.after.set(productId, desired)
    } else if (sameRow(row, desired)) {
      plan.unchanged++
      plan.after.set(productId, row)
    } else {
      const to = { ...desired, id: row.id }
      plan.update.push({ from: row, to })
      plan.after.set(productId, to)
    }
  }
  const posts = postsBy(plan.after)
  c.unmapped = input.goodsProducts.filter(id => !posts(id)).length
  return plan
}

/** Rows after a run, by their source, and how many of them the accountant has reviewed. */
export function rowsBySource(after: ReadonlyMap<string, MapRow>): { bySource: Record<ProductGroupSource, number>; reviewed: number } {
  const bySource: Record<ProductGroupSource, number> = { exact: 0, learned: 0, rule: 0, ai: 0, accountant: 0 }
  let reviewed = 0
  for (const r of after.values()) {
    bySource[r.source]++
    if (r.reviewedAt) reviewed++
  }
  return { bySource, reviewed }
}

// ── coverage ─────────────────────────────────────────────────────────────────────────────────────

export type CoverageKind = 'invoices' | 'till'

export interface CoverageLine {
  productId?: string
  service?: boolean
  /** The line's net in the base currency, sign dropped. */
  value: number
}

export interface CoverageDocument {
  kind: CoverageKind
  /** The business day in Sofia. */
  day: Date
  lines: readonly CoverageLine[]
}

/** One month of one kind. A line on a service needs no group and is left out of both counts. */
export interface CoverageCell {
  lines: number
  mappedLines: number
  /** Typed with no product: never covered. */
  noProduct: number
  value: number
  mappedValue: number
}

export type CoverageTable = Record<CoverageKind, Map<string, CoverageCell>>

export const newCoverage = (): CoverageTable => ({ invoices: new Map(), till: new Map() })

const monthOf = (day: Date) => `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}`

/** Adds a document's lines to its month: covered when the product has a row a line posts by. */
export function addCoverage(table: CoverageTable, doc: CoverageDocument, posts: (productId: string) => boolean): void {
  const month = monthOf(doc.day)
  const cell = table[doc.kind].get(month) ?? { lines: 0, mappedLines: 0, noProduct: 0, value: 0, mappedValue: 0 }
  for (const l of doc.lines) {
    if (l.service) continue
    const value = Math.abs(Number(l.value) || 0)
    cell.lines++
    cell.value += value
    if (!l.productId) cell.noProduct++
    else if (posts(l.productId)) { cell.mappedLines++; cell.mappedValue += value }
  }
  table[doc.kind].set(month, cell)
}

/** The map's rows a line posts by. */
export function postsBy(after: ReadonlyMap<string, MapRow>): (productId: string) => boolean {
  return productId => {
    const r = after.get(productId)
    return !!r && (isAccountants(r) || POSTABLE_SOURCES.has(r.source))
  }
}
