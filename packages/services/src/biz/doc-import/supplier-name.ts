/**
 * FR-28.12 — who a goods receipt came from, when all the import has is the PARTNER's name.
 *
 * PlusMinus's `стокова разписка` names its partner as free text (`ПАРТНЬОРИ:ТЕСТ СЕНТЕР ЕООД`). Until now that went
 * into the movement's `notes` and nowhere else, so the receipt named no supplier and the supplier facts of
 * FR-28.1 (which read `StockMovement.contactId`) could not see the purchase. This resolves the name to an
 * EXISTING supplier, and only to one:
 *
 *   - by EXACT normalized name: the same words, whatever their case and whatever runs of whitespace separate them
 *     (`normalizeName`). No fuzzy rung: a near name is a different company until a person says otherwise, and the
 *     answer decides who the article is "bought from";
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

export type SupplierNameMatch =
  | { status: 'matched'; contactId: string; name: string }
  | { status: 'none' }
  /** `count`: how many active suppliers carry that exact name. */
  | { status: 'ambiguous'; count: number }

/** The part of a contact the rule reads. `id` is its `_id` as a string. */
export interface SupplierCandidate {
  id: string
  companyName?: string | null
  type?: string
  isActive?: boolean
}

const isSupplierType = (t: string | undefined) => t === 'supplier' || t === 'both'

/**
 * The one active supplier whose name is exactly this one, from candidates the caller found any way it likes (the
 * database, the API's contact search). Candidates that do not qualify are ignored, so a loose search may pass more
 * than the rule keeps: a customer of the same name, a deactivated contact, a longer name that contains the words.
 */
export function pickSupplierByName(name: string, candidates: readonly SupplierCandidate[]): SupplierNameMatch {
  const key = normalizeName(name)
  if (!key) return { status: 'none' }
  const same = candidates.filter((c) => isSupplierType(c.type ?? 'supplier') && c.isActive !== false && normalizeName(c.companyName) === key)
  if (same.length === 1) return { status: 'matched', contactId: same[0].id, name: String(same[0].companyName ?? '').trim() }
  return same.length ? { status: 'ambiguous', count: same.length } : { status: 'none' }
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
      '(the name stays in the notes). Add or rename the supplier in LGR, then re-run: a day already booked is not touched.',
  )
  for (const u of s.unresolved) {
    const why = u.reason === 'ambiguous' ? `${u.candidates} suppliers share that name` : 'no active supplier of that name'
    out.push(`   "${u.name}" — ${why} — ${u.documents.length} document(s): ${u.documents.join(', ')}`)
  }
  return out
}
