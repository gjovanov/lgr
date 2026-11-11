/**
 * FR-28.12 — who a goods receipt came from, when all the import has is the PARTNER's name.
 *
 * PlusMinus's `стокова разписка` names its partner as free text (`ПАРТНЬОРИ:ТЕСТ СЕНТЕР ЕООД`). Until now that went
 * into the movement's `notes` and nowhere else, so the receipt named no supplier and the supplier facts of
 * FR-28.1 (which read `StockMovement.contactId`) could not see the purchase. This resolves the name to an
 * EXISTING supplier, and only to one:
 *
 *   - by EXACT normalized name: the same words, whatever their case and whatever runs of whitespace separate them
 *     (`normalizeName`);
 *   - else by the same words whatever PUNCTUATION stands between them (`foldName`): PlusMinus prints a document's
 *     partner from one list („КАМ - 04 ООД", „F.REYHER Nchfg. GmbH") and keeps its supplier ledger in another
 *     („КАМ-04 ООД", „F.REYHER Nchfg.GMBH"), and LGR's suppliers were seeded from the ledger. In the two shops that
 *     alone left a third of the named receipts without their supplier (2026-11-11);
 *   - no fuzzy rung beyond that: a shorter, longer or differently spelled name is a different company until a
 *     person says otherwise, and the answer decides who the article is "bought from";
 *   - a person says otherwise on the contact, under „Also known as" (`Contact.aliases`): when no supplier is NAMED
 *     that, the supplier that keeps the name among its other names is asked for, by the same two rules (the exact
 *     name, else the same words). A supplier's own name always comes first, so another name only ever fills a gap:
 *     it cannot take a receipt from the supplier that is named so;
 *   - among ACTIVE contacts of type supplier or both, as every order and recorded supplier is (FR-28.9, .17);
 *   - never creating a contact from free text. A name that matches none, or several, resolves to nothing, and the
 *     import REPORTS it with how many documents named it (`summarizePartners`), so a person can fix the contact.
 *
 * Pure, with no database: the scripts import it (they only have the API's contact list to choose from), and
 * `matching.ts#matchSupplierByName` is the same rule over the database. One definition of "the same name".
 */
import { CORRECTION_PARTNER } from 'config/movement-notes'
import { stripPartnerPrefix } from './map-plusminus-invoice.js'

/** Whitespace runs collapsed, trimmed, lower-cased the way the `*Lower` mirrors are (`bg` locale). */
export function normalizeName(s: string | undefined | null): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')
}

/**
 * The name's words alone: every run of anything that is not a letter or a digit becomes one space. „КАМ - 04 ООД"
 * and „КАМ-04 ООД" are the same words; „КАМ 04" and „КАМ04" are not, and neither are a name and its short form.
 */
export function foldName(s: string | undefined | null): string {
  return normalizeName(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export type PartnerKind =
  /** A name to look a supplier up by. */
  | 'supplier'
  /** The КОРЕКЦИЯ partner a correction is printed with, in a supplier's place: it is nobody's name. */
  | 'correction'
  /** The document names no partner at all. */
  | 'nobody'

export interface PartnerName {
  kind: PartnerKind
  /** The bare name, without PlusMinus's `ПАРТНЬОРИ:` prefix (empty when `kind` is not `supplier`). */
  name: string
}

/** What a receipt's `header.partner` says: a supplier's name, the КОРЕКЦИЯ placeholder, or nothing. */
export function partnerOf(raw: unknown): PartnerName {
  const name = stripPartnerPrefix(raw == null ? '' : String(raw))
  if (!name) return { kind: 'nobody', name: '' }
  if (CORRECTION_PARTNER.test(name)) return { kind: 'correction', name: '' }
  return { kind: 'supplier', name }
}

// ── A document booked without its partner ────────────────────────────────────────────────────────────

const UNMATCHED_PARTNER = /^the document names „(.+)" as partner and no contact matches/

/**
 * What an analysis says of a document whose partner no contact matched. The words are stored with the document
 * (`DocFile.analysis.diagnostics.warnings`) and are the only place a receipt booked that way keeps the partner's
 * name, so they are built here, next to `unmatchedPartnerOf`, which reads them back. Changing the opening
 * breaks that reader for every analysis already stored: `unit/supplier-name.test.ts` pins it.
 */
export function unmatchedPartnerWarning(name: string): string {
  return `the document names „${name}" as partner and no contact matches — booked without one. That is expected when the partner is another of the org's OWN stores rather than a counterparty (goods handed to a sister store, a second warehouse LGR does not track yet); only add a contact if it really is one.`
}

/** The partner's name such a warning carries, or undefined for any other text. */
export function unmatchedPartnerOf(warning: unknown): string | undefined {
  return UNMATCHED_PARTNER.exec(String(warning ?? ''))?.[1].trim() || undefined
}

export type SupplierNameMatch =
  /**
   * `by`: absent when the supplier is named exactly so. `punctuation`: its name is the same words with other
   * punctuation. `alias`: the name is one of its other names („Also known as"), exactly or but for its punctuation.
   */
  | { status: 'matched'; contactId: string; name: string; by?: 'punctuation' | 'alias' }
  | { status: 'none' }
  /** `count`: how many active suppliers carry that name (as their own, or among their other names). */
  | { status: 'ambiguous'; count: number }

/** The part of a contact the rule reads. `id` is its `_id` as a string. */
export interface SupplierCandidate {
  id: string
  companyName?: string | null
  type?: string
  isActive?: boolean
  /** Its other names („Also known as"). A caller that leaves them out asks by the suppliers' own names only. */
  aliases?: readonly (string | null | undefined)[] | null
}

const isSupplierType = (t: string | undefined) => t === 'supplier' || t === 'both'

/**
 * The one active supplier that goes by exactly this name, from candidates the caller found any way it likes (the
 * database, the API's contact search). Candidates that do not qualify are ignored, so a loose search may pass more
 * than the rule keeps: a customer of the same name, a deactivated contact, a longer name that contains the words.
 *
 * Four questions, in this order, and the first that any supplier answers decides (one: matched; several: ambiguous):
 * who is NAMED exactly so; whose name is the same words with other punctuation; who keeps exactly this among its
 * other names; whose other name is the same words. So a supplier's own name outranks another supplier's other
 * name, and an other name can only resolve what no name does.
 *
 * ⚠ Each question is answered from the candidates given. A caller that passes a partial set (a search's answer)
 * must pass every supplier that could answer an EARLIER question too, or a later one may decide in its place.
 */
export function pickSupplierByName(name: string, candidates: readonly SupplierCandidate[]): SupplierNameMatch {
  const key = normalizeName(name)
  if (!key) return { status: 'none' }
  const words = foldName(name)
  const suppliers = candidates.filter((c) => isSupplierType(c.type ?? 'supplier') && c.isActive !== false)
  const otherNames = (c: SupplierCandidate) => (c.aliases ?? []).filter((a): a is string => typeof a === 'string')
  const questions: Array<[by: 'punctuation' | 'alias' | undefined, asks: (c: SupplierCandidate) => boolean]> = [
    [undefined, (c) => normalizeName(c.companyName) === key],
    ['punctuation', (c) => !!words && foldName(c.companyName) === words],
    ['alias', (c) => otherNames(c).some((a) => normalizeName(a) === key)],
    ['alias', (c) => !!words && otherNames(c).some((a) => foldName(a) === words)],
  ]
  for (const [by, asks] of questions) {
    const found = suppliers.filter(asks)
    if (found.length === 1) return { status: 'matched', contactId: found[0].id, name: String(found[0].companyName ?? '').trim(), ...(by ? { by } : {}) }
    if (found.length) return { status: 'ambiguous', count: found.length }
  }
  return { status: 'none' }
}

/**
 * One line for a run's log: what this partner name resolved to.
 * ⚠ The two ⚠ lines are a format other code reads: the daily import's log checks find a document's unresolved
 * partner by their opening words. Do not reword them; "named" covers a supplier's other names there too.
 */
export function describeMatch(name: string, match: SupplierNameMatch): string {
  if (match.status === 'matched') {
    const how = match.by === 'punctuation' ? ', the same name but for its punctuation' : match.by === 'alias' ? `, also known as "${name}"` : ''
    return `supplier: ${match.name} (${match.contactId})${how}`
  }
  if (match.status === 'ambiguous') return `⚠ supplier: ${match.count} active suppliers are named "${name}", so the receipt names none`
  return `⚠ supplier: no active supplier is named "${name}", so the receipt names none`
}

// ── The import's report ──────────────────────────────────────────────────────────────────────────────

/** One document of the run and what its partner resolved to. */
export interface PartnerResult {
  docNumber: string
  partner: PartnerName
  /** Present when `partner.kind` is `supplier`. */
  match?: SupplierNameMatch
}

export interface UnresolvedPartner {
  name: string
  reason: 'none' | 'ambiguous'
  /** The suppliers sharing the name, when `reason` is `ambiguous`. */
  candidates?: number
  documents: string[]
}

export interface PartnerSummary {
  /** Documents whose receipt will name a supplier. */
  resolved: number
  /** Documents that name a supplier by a name that matched none, or several, listed by name with their documents. */
  unresolved: UnresolvedPartner[]
  /** Documents that name a КОРЕКЦИЯ or nobody: there is no supplier to find, so nothing is reported. */
  nobody: number
}

/** Each unresolved NAME once, with the documents that carry it, the commonest first. */
export function summarizePartners(results: readonly PartnerResult[]): PartnerSummary {
  let resolved = 0
  let nobody = 0
  const byName = new Map<string, UnresolvedPartner>()
  for (const r of results) {
    if (r.partner.kind !== 'supplier') { nobody++; continue }
    if (r.match?.status === 'matched') { resolved++; continue }
    const reason = r.match?.status === 'ambiguous' ? 'ambiguous' : 'none'
    const key = `${reason}|${normalizeName(r.partner.name)}`
    const entry = byName.get(key) ?? { name: r.partner.name, reason, ...(r.match?.status === 'ambiguous' ? { candidates: r.match.count } : {}), documents: [] }
    entry.documents.push(r.docNumber)
    byName.set(key, entry)
  }
  const unresolved = [...byName.values()].sort((a, b) => b.documents.length - a.documents.length || a.name.localeCompare(b.name, 'bg'))
  return { resolved, unresolved, nobody }
}

/** The report's lines for a person reading the run: a count, then each name with the documents that carry it. */
export function formatPartnerReport(s: PartnerSummary): string[] {
  const total = s.unresolved.reduce((n, u) => n + u.documents.length, 0)
  const out = [`Suppliers: ${s.resolved} document(s) name a supplier, ${total} named one that could not be resolved${s.nobody ? `, ${s.nobody} name nobody (a correction, or no partner)` : ''}.`]
  if (!s.unresolved.length) return out
  out.push(
    `⚠ ${s.unresolved.length} partner name(s) matched no single active supplier, so ${total} receipt(s) carry no supplier ` +
      '(the name stays in the notes). Add the supplier in LGR, or add the name to the supplier it is under „Also known as" on that contact, before the next import: a receipt already booked is not changed.',
  )
  for (const u of s.unresolved) {
    const why = u.reason === 'ambiguous' ? `${u.candidates} suppliers share that name` : 'no active supplier of that name'
    out.push(`   "${u.name}" — ${why} — ${u.documents.length} document(s): ${u.documents.join(', ')}`)
  }
  return out
}
