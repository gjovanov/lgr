/**
 * FR-25 R3, slice 5: the comparison, books against shadow, one store and one month (§6.3). Import-pure: the service
 * (`books-shadow-compare.service.ts`) reads the month, this compares it, and the script prints counts only.
 *
 * A document is its number: the register's digits, leading zeros dropped (`booksNumberKey`), as the sales register's
 * gate and slice 1 pair them. Each ledger's side of it is the sum of that ledger's entries of the month under the number:
 * the books' invoice and its annulment are one document, and so are the shadow's posting, its reversal and its next
 * revision. A document whose entries of the month cancel out is not held in that month.
 *
 * Per month:
 *   - each document both ledgers hold: equal, or where it differs, by the dry run's own check (`differencesOf`);
 *   - each goods group over those documents: what each ledger takes out of `304`, in quantity and in cost;
 *   - the cost of sales (`D702`) over those documents, and apart, over the documents one ledger holds alone;
 *   - the documents one ledger holds alone, counted;
 *   - the sales register's rows, the shadow's against the filed (`compareRegisterRows`).
 */
import { registerDocTypeCode } from 'config/journal-header'
import { rowDifferences, type FiledSalesRow } from '../vat-files/sales-register.js'
import type { VatRow } from '../vat-files/codec.js'
import { booksNumberKey } from './product-groups.js'
import { GOODS_ACCOUNT, GOODS_REVENUE_ACCOUNT } from './registry.js'
import { DIFFERENCES, differencesOf, spreadOf, type ComparedLine, type CostDifference, type CostSpread, type Difference } from './shadow-compare.js'

/** One entry of the month, of either ledger. */
export interface MonthEntry {
  /** As the entry carries it: the books' number, or the register's ten digits on a shadow posting. */
  docNumber: string
  /** `1` invoice, `2` debit notice, `3` credit notice, when the entry says. */
  registerDocType?: string
  /** A shadow posting's LGR document. */
  sourceId?: string
  lines: readonly ComparedLine[]
}

export interface GroupFigures {
  /** What the ledger takes out of `304` on the group's analytic: credits less debits. */
  quantity: number
  cost: number
}

/** A group's quantities differ (a product in another group), or, equal, how far the shadow's cost is from the books'. */
export const GROUP_OUTCOMES = ['equal', 'quantity', 'within05', 'within5', 'more'] as const
export type GroupOutcome = (typeof GROUP_OUTCOMES)[number]

export interface GroupRow {
  analyticId: string
  books: GroupFigures
  shadow: GroupFigures
  outcome: GroupOutcome
}

export interface MonthComparison {
  documents: {
    /** Under a number, with something left in the month. */
    books: number
    shadow: number
    /** Both ledgers hold it, as the same kind of document. */
    compared: number
    booksOnly: number
    shadowOnly: number
    /** Both hold the number, one as an invoice and the other as a notice: compared neither way. */
    typeDiffers: number
    /** Entries whose number is not digits: on no side. */
    noNumber: number
    /** Of the shadow's: several LGR documents posted under one number. */
    severalInShadow: number
  }
  /** Of the compared documents. */
  compared: { equal: number; differs: number; by: Record<Difference, number>; cost: Record<CostDifference, number>; costSpread: CostSpread }
  /** Per goods group, over the compared documents, in the order of the books' cost, largest first. */
  groups: GroupRow[]
  /** `D702`, signed. */
  costOfSales: {
    /** Over the compared documents. */
    books: number
    shadow: number
    outcome: 'equal' | keyof CostSpread
    /** Over the documents one ledger holds alone. */
    booksOnly: number
    shadowOnly: number
  }
}

const cents = (v: unknown) => Math.round((Number(v) || 0) * 100)
const micro = (v: unknown) => Math.round((Number(v) || 0) * 1e6)
const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>

interface Held {
  lines: ComparedLine[]
  types: Set<string>
  sources: Set<string>
}

/** Whether lines leave anything once summed per account, analytic and side. */
function holdsAnything(lines: readonly ComparedLine[]): boolean {
  const sums = new Map<string, [number, number]>()
  for (const l of lines) {
    const k = `${l.account}|${l.analyticId ?? ''}|${l.side}`
    const s = sums.get(k) ?? [0, 0]
    s[0] += cents(l.amount)
    s[1] += l.quantity === undefined || l.quantity === null ? 0 : micro(l.quantity)
    sums.set(k, s)
  }
  return [...sums.values()].some(([a, q]) => a !== 0 || q !== 0)
}

function byNumber(entries: readonly MonthEntry[], counts: { noNumber: number }): Map<string, Held> {
  const out = new Map<string, Held>()
  for (const e of entries) {
    const k = booksNumberKey(e.docNumber)
    if (!k) { counts.noNumber++; continue }
    const held = out.get(k) ?? { lines: [], types: new Set<string>(), sources: new Set<string>() }
    held.lines.push(...e.lines)
    const type = registerDocTypeCode(e.registerDocType)
    if (type) held.types.add(type)
    if (e.sourceId) held.sources.add(e.sourceId)
    out.set(k, held)
  }
  for (const [k, held] of out) if (!holdsAnything(held.lines)) out.delete(k)
  return out
}

/** Credits less debits on `304`, per group analytic: quantity in millionths, cost in cents. */
function goodsOut(lines: readonly ComparedLine[]): Map<string, { q: number; c: number }> {
  const out = new Map<string, { q: number; c: number }>()
  for (const l of lines) {
    if (l.account !== GOODS_ACCOUNT || !l.analyticId) continue
    const sign = l.side === 'credit' ? 1 : -1
    const g = out.get(l.analyticId) ?? { q: 0, c: 0 }
    g.c += sign * cents(l.amount)
    g.q += sign * (l.quantity === undefined || l.quantity === null ? 0 : micro(l.quantity))
    out.set(l.analyticId, g)
  }
  return out
}

/** `D702`, in cents. */
const costCents = (lines: readonly ComparedLine[]) => lines.filter(l => l.account === GOODS_REVENUE_ACCOUNT && l.side === 'debit').reduce((s, l) => s + cents(l.amount), 0)

/** Equal to the cent, or where the shadow's figure falls against the books'. */
const outcomeOf = (shadowCents: number, booksCents: number): 'equal' | keyof CostSpread =>
  shadowCents === booksCents ? 'equal' : spreadOf(shadowCents / 100, booksCents / 100)

/** One store's month: the books' entries of its own series against the shadow's postings. */
export function compareMonth(books: readonly MonthEntry[], shadow: readonly MonthEntry[]): MonthComparison {
  const counts = { noNumber: 0 }
  const b = byNumber(books, counts)
  const s = byNumber(shadow, counts)
  const result: MonthComparison = {
    documents: { books: b.size, shadow: s.size, compared: 0, booksOnly: 0, shadowOnly: 0, typeDiffers: 0, noNumber: 0, severalInShadow: 0 },
    compared: { equal: 0, differs: 0, by: zeroes(DIFFERENCES), cost: { groups: 0, average: 0 }, costSpread: { within05: 0, within5: 0, more: 0 } },
    groups: [],
    costOfSales: { books: 0, shadow: 0, outcome: 'equal', booksOnly: 0, shadowOnly: 0 },
  }
  const docs = result.documents
  for (const held of s.values()) if (held.sources.size > 1) docs.severalInShadow++
  const groups = new Map<string, { books: { q: number; c: number }; shadow: { q: number; c: number } }>()
  let booksCost = 0, shadowCost = 0, booksOnlyCost = 0, shadowOnlyCost = 0
  for (const [k, inBooks] of b) {
    const inShadow = s.get(k)
    if (!inShadow) { docs.booksOnly++; booksOnlyCost += costCents(inBooks.lines); continue }
    // Two kinds of document under one number: a type known on both sides that the other side never names.
    if (inBooks.types.size && inShadow.types.size && ![...inBooks.types].some(t => inShadow.types.has(t))) { docs.typeDiffers++; continue }
    docs.compared++
    const diff = differencesOf(inShadow.lines, inBooks.lines)
    if (!diff.places.size) result.compared.equal++
    else {
      result.compared.differs++
      for (const p of diff.places) result.compared.by[p]++
      if (diff.cost) {
        result.compared.cost[diff.cost]++
        result.compared.costSpread[spreadOf(costCents(inShadow.lines) / 100, costCents(inBooks.lines) / 100)]++
      }
    }
    booksCost += costCents(inBooks.lines)
    shadowCost += costCents(inShadow.lines)
    for (const [side, lines] of [['books', inBooks.lines], ['shadow', inShadow.lines]] as const) {
      for (const [analyticId, g] of goodsOut(lines)) {
        const row = groups.get(analyticId) ?? { books: { q: 0, c: 0 }, shadow: { q: 0, c: 0 } }
        row[side].q += g.q
        row[side].c += g.c
        groups.set(analyticId, row)
      }
    }
  }
  for (const [k, inShadow] of s) {
    if (b.has(k)) continue
    docs.shadowOnly++
    shadowOnlyCost += costCents(inShadow.lines)
  }
  docs.noNumber = counts.noNumber
  result.groups = [...groups]
    .filter(([, g]) => g.books.q || g.books.c || g.shadow.q || g.shadow.c)
    .map(([analyticId, g]) => ({
      analyticId,
      books: { quantity: g.books.q / 1e6, cost: g.books.c / 100 },
      shadow: { quantity: g.shadow.q / 1e6, cost: g.shadow.c / 100 },
      outcome: g.books.q !== g.shadow.q ? 'quantity' as const : outcomeOf(g.shadow.c, g.books.c),
    }))
    .sort((x, y) => Math.abs(y.books.cost) - Math.abs(x.books.cost) || x.analyticId.localeCompare(y.analyticId))
  result.costOfSales = {
    books: booksCost / 100, shadow: shadowCost / 100, outcome: outcomeOf(shadowCost, booksCost),
    booksOnly: booksOnlyCost / 100, shadowOnly: shadowOnlyCost / 100,
  }
  return result
}

/** How many groups fell where. */
export const groupCounts = (rows: readonly GroupRow[]): Record<GroupOutcome, number> => {
  const out = zeroes(GROUP_OUTCOMES)
  for (const r of rows) out[r.outcome]++
  return out
}

// ── the register ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A row of the sales register, either ledger's, as stored. */
export type RegisterRow = FiledSalesRow

export interface RegisterCounts {
  shadow: number
  filed: number
  equal: number
  /** By what differs, as the gate names it (`rowDifferences`): `date`, `partner`, `base`, `vat`, `other cells`, joined. */
  differs: Record<string, number>
  filedOnly: number
  shadowOnly: number
  /** A key with several rows on one side: compared by its first. */
  several: number
}

const rowKey = (r: RegisterRow) => `${registerDocTypeCode(r.docTypeCode) ?? r.docTypeCode}:${booksNumberKey(r.docNumber) ?? r.docNumber}`

/** The shadow's sales register rows of a month against the filed rows of the same series. */
export function compareRegisterRows(shadow: readonly RegisterRow[], filed: readonly RegisterRow[]): RegisterCounts {
  const counts: RegisterCounts = { shadow: shadow.length, filed: filed.length, equal: 0, differs: {}, filedOnly: 0, shadowOnly: 0, several: 0 }
  const group = (rows: readonly RegisterRow[]) => {
    const m = new Map<string, RegisterRow[]>()
    for (const r of rows) m.set(rowKey(r), [...(m.get(rowKey(r)) ?? []), r])
    return m
  }
  const s = group(shadow)
  const f = group(filed)
  for (const [k, rows] of s) {
    const other = f.get(k)
    if (rows.length > 1 || (other?.length ?? 0) > 1) counts.several++
    if (!other) { counts.shadowOnly++; continue }
    const diff = rowDifferences(rows[0] as unknown as Omit<VatRow, 'rowNo'>, other[0])
    if (!diff.length) counts.equal++
    else counts.differs[diff.join(' + ')] = (counts.differs[diff.join(' + ')] ?? 0) + 1
  }
  for (const [k, rows] of f) {
    if (s.has(k)) continue
    counts.filedOnly++
    if (rows.length > 1) counts.several++
  }
  return counts
}
