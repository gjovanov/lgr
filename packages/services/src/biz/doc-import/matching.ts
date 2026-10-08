/**
 * Resolving extracted text to catalog entities.
 *
 * Product ladder, in order — the first rung that hits wins:
 *   1. alias  — learned per-supplier wording (incoming documents only)
 *   2. exact  — nameLower / skuLower equality (indexed)
 *   3. ws     — whitespace-tolerant: same tokens, any run of spaces between them
 *   3b. ws    — whitespace-STRIPPED: the space may be missing, not merely differently sized
 *   3c. ws    — homoglyph-folded: Latin k vs Cyrillic к, indistinguishable on paper
 *   3d. token — separator-stripped: a " - " field break dropped from the document
 *   4. ai     — constrained to a candidate set (an ORDO supplier group), never free-form
 *
 * Rung 3 subsumes the collapse/longest-token rungs the CLI scripts need: those exist only
 * because the scripts match through a `contains` search endpoint, which a padded catalog
 * name defeats. Querying Mongo directly, an anchored `^t1\s+t2$` regex against `nameLower`
 * is exactly "same tokens modulo padding", on both sides at once.
 *
 * There is deliberately NO fuzzy rung. Tokenised similarity used to map "ВИНТ 4Х30" onto
 * "ВИНТ - СТОПОРЕН - М14Х30 - DIN 914" at the wrong price; an unmatched line stays
 * free-text for a human instead.
 *
 * ⚠ The whitespace regex is built at runtime from a string. A Cyrillic regex *literal*
 * would be transpiled by Bun to \uXXXX escapes and rejected by Mongo (PCRE2 51091).
 */
import { config } from 'config'
import { Contact, Product, SupplierProductAlias, normalizeAlias } from 'db/models'
import { buildSearchFilter } from '../search.utils.js'
import { clean, digits } from './detect.js'
import type { MatchedBy, Party } from './types.js'

export interface ProductMatch {
  productId: string
  name: string
  unit?: string
  sku?: string
  purchasePrice?: number
  matchedBy: MatchedBy
}

export interface ContactMatch {
  contactId: string
  name: string
  created: boolean
  address?: { street: string; city?: string; postalCode?: string; country?: string }
}

/** Billing address entry from an extracted address (no postal code in legacy docs). */
export function partyAddressEntry(address: string, city?: string) {
  return { type: 'billing', street: address, ...(city ? { city } : {}), country: 'BG', isDefault: true }
}

/**
 * Find a Contact of the given type from an extracted party. Ladder: ЕИК → VAT → name.
 *
 * `create` controls the miss behaviour: the batch path creates the contact (that is what
 * the migration importer has always done), while the single-document path passes `false`
 * so the UI can offer the user a choice instead of silently adding a counterparty.
 */
export async function matchContact(
  orgId: string,
  party: Party,
  type: 'customer' | 'supplier',
  opts: { create?: boolean } = {},
): Promise<ContactMatch | null> {
  const eik = clean(party?.company_id)
  const vat = clean(party?.vat_id)
  const name = clean(party?.name)
  const address = clean(party?.address)
  const city = clean(party?.city)
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
    if (!(c.addresses || []).length && address) set.addresses = [partyAddressEntry(address, city)]
    if (Object.keys(set).length) await Contact.updateOne({ _id: c._id }, { $set: set })
    const best = (c.addresses || []).find((a: any) => a.isDefault) || (c.addresses || [])[0]
      || (address ? partyAddressEntry(address, city) : undefined)
    return { contactId: String(c._id), name: c.companyName || name, created: false, address: best }
  }
  if (!name || opts.create === false) return null

  const created: any = await Contact.create({
    orgId, type, companyName: name,
    taxId: eik || digits(vat) || undefined,
    taxNumber: eik || digits(vat) || undefined,
    vatNumber: vat || undefined,
    addresses: address ? [partyAddressEntry(address, city)] : [],
    isActive: true,
  })
  return { contactId: String(created._id), name, created: true, address: address ? partyAddressEntry(address, city) : undefined }
}

/**
 * Learned per-supplier mapping: the supplier's exact wording (normalised) → our product.
 * First rung of the ladder; every hit bumps the usage counters.
 */
export async function matchProductViaAlias(
  orgId: string,
  supplierId: string,
  description: string,
): Promise<ProductMatch | null> {
  const norm = normalizeAlias(description)
  if (!norm) return null
  const alias: any = await SupplierProductAlias.findOne({ orgId, supplierId, aliasNormalized: norm }).lean()
  if (!alias) return null
  const p: any = await Product.findOne({ _id: alias.productId, orgId, isActive: true }).lean()
  if (!p) return null
  SupplierProductAlias.updateOne({ _id: alias._id }, { $inc: { hits: 1 }, $set: { lastUsedAt: new Date() } })
    .exec()
    .catch(() => {})
  return toMatch(p, 'alias')
}

function toMatch(p: any, matchedBy: MatchedBy): ProductMatch {
  return {
    productId: String(p._id),
    name: p.name,
    unit: p.unit,
    sku: p.sku,
    purchasePrice: typeof p.purchasePrice === 'number' ? p.purchasePrice : undefined,
    matchedBy,
  }
}

/** Single-description match (rungs 2–3). Kept for callers that resolve one line at a time. */
export async function matchProduct(orgId: string, description: string): Promise<ProductMatch | null> {
  const [hit] = await matchProductsExact(orgId, [clean(description)])
  return hit ?? null
}

/**
 * Batch rungs 2–3 for many descriptions at once: two `$in` queries for the whole document,
 * then one anchored regex per still-unmatched line. A 200-line разписка costs ~2 queries
 * plus the leftovers instead of 400 sequential round trips.
 *
 * Returns one slot per input description, `null` where nothing matched.
 */
export async function matchProductsExact(orgId: string, descriptions: string[]): Promise<Array<ProductMatch | null>> {
  const out: Array<ProductMatch | null> = descriptions.map(() => null)
  const lowers = descriptions.map(d => clean(d).toLocaleLowerCase('bg'))
  const wanted = [...new Set(lowers.filter(Boolean))]
  if (!wanted.length) return out

  const byName = new Map<string, any>()
  const nameHits: any[] = await Product.find({ orgId, isActive: true, nameLower: { $in: wanted } } as any).lean()
  for (const p of nameHits) byName.set(String(p.nameLower), p)

  const stillWanted = wanted.filter(w => !byName.has(w))
  const bySku = new Map<string, any>()
  if (stillWanted.length) {
    const skuHits: any[] = await Product.find({ orgId, isActive: true, skuLower: { $in: stillWanted } } as any).lean()
    for (const p of skuHits) bySku.set(String(p.skuLower), p)
  }

  // Rung 3: legacy exports keep multi-space padding ("НОЖ   ТЕХНИЧЕСКИ") that PDF text
  // collapses — still an exact match by content, only the run length of spaces differs.
  const wsCache = new Map<string, any | null>()
  for (let i = 0; i < descriptions.length; i++) {
    const lower = lowers[i]
    if (!lower) continue
    const exact = byName.get(lower) || bySku.get(lower)
    if (exact) { out[i] = toMatch(exact, 'exact'); continue }
    if (!/\s/.test(lower)) continue
    if (!wsCache.has(lower)) {
      const pattern = '^' + lower.split(/\s+/).map(escapeRe).join('\\s+') + '$'
      wsCache.set(lower, await Product.findOne({ orgId, isActive: true, nameLower: { $regex: pattern } } as any).lean())
    }
    const ws = wsCache.get(lower)
    if (ws) out[i] = toMatch(ws, 'ws')
  }

  // Rung 3b: the space may be MISSING, not merely differently sized. A name that wraps in the
  // PDF ("… - М16 - НОРД" / "ЛОК") is read back joined as "НОРДЛОК" while the catalog holds
  // "НОРД ЛОК" — rung 3 cannot help because the tokenisation itself differs. Compare with all
  // whitespace stripped, over candidates anchored on the first token (indexed prefix).
  const despace = (v: string) => v.replace(/\s+/g, '')
  const dsCache = new Map<string, any[]>()
  for (let i = 0; i < descriptions.length; i++) {
    if (out[i]) continue
    const lower = lowers[i]
    if (!lower) continue
    const first = lower.split(/\s+/)[0]
    if (!first || first.length < 3) continue
    if (!dsCache.has(first)) {
      dsCache.set(first, await Product.find({ orgId, isActive: true, nameLower: { $regex: '^' + escapeRe(first) } } as any).limit(500).lean())
    }
    const needle = despace(lower)
    const hit = (dsCache.get(first) || []).find((p: any) => despace(String(p.nameLower || '')) === needle)
    if (hit) out[i] = toMatch(hit, 'ws')
  }

  // Rung 3c: the same NAME written with a look-alike letter. "DIN 7504 K" ends in a Latin k in
  // the catalog and a Cyrillic к in the extraction (an LLM reading Bulgarian text normalises the
  // stray Latin letter; pdftotext does not) — two strings that render identically and compare
  // unequal. Unmatched, the line then CREATES a product: on 2026-09-01 that forked
  // "ВИНТ - САМОПР. - 6.3Х100 - DIN 7504 K" in two and sent 1750 units to the copy.
  // Folding is safe precisely because the glyphs are indistinguishable to the person who typed them.
  const folded = new Map<string, any[]>()
  for (let i = 0; i < descriptions.length; i++) {
    if (out[i]) continue
    const lower = lowers[i]
    if (!lower) continue
    const first = lower.split(/\s+/)[0]
    if (!first || first.length < 3) continue
    const key = foldHomoglyphs(first)
    if (!folded.has(key)) {
      // Anchor on the first token in EITHER script, so a candidate whose difference is in that
      // very token is still fetched.
      const variants = [...new Set([first, foldHomoglyphs(first), latiniseHomoglyphs(first)])]
      const hits: any[] = []
      for (const v of variants) hits.push(...await Product.find({ orgId, isActive: true, nameLower: { $regex: '^' + escapeRe(v) } } as any).limit(500).lean())
      folded.set(key, hits)
    }
    const needle = foldHomoglyphs(despace(lower))
    const hit = (folded.get(key) || []).find((p: any) => foldHomoglyphs(despace(String(p.nameLower || ''))) === needle)
    if (hit) out[i] = toMatch(hit, 'ws')
  }

  // Rung 3d: the separator itself is MISSING, not merely a space. The catalog writes a name's
  // fields with " - " between them and a document may simply drop one:
  //
  //   doc      "ШАЙБА - КОНУСНА 22ММ - DIN 435 - 14% - HDG"
  //   catalog  "ШАЙБА - КОНУСНА - 22ММ - DIN 435 - 14% - HDG"      (REGALPZ-20747)
  //
  // Rungs 3/3b cannot help: a hyphen is a real character, so both the token list and the
  // whitespace-stripped form still differ. Compare with every separator removed — and ONLY
  // separators. Dots, commas, slashes and percent signs stay, because they carry size:
  // "13.5ММ" must never collapse onto "135ММ", and both exist in this catalog.
  const sepCache = new Map<string, { rows: any[]; truncated: boolean }>()
  for (let i = 0; i < descriptions.length; i++) {
    if (out[i]) continue
    const lower = lowers[i]
    if (!lower) continue
    const squashed = squashSeparators(lower)
    const anchor = squashed.slice(0, SEP_ANCHOR_CHARS)
    if (anchor.length < 3) continue
    const key = foldHomoglyphs(anchor)
    if (!sepCache.has(key)) {
      const rows: any[] = []
      const seen = new Set<string>()
      for (const v of [...new Set([anchor, foldHomoglyphs(anchor), latiniseHomoglyphs(anchor)])]) {
        const found: any[] = await Product
          .find({ orgId, isActive: true, nameLower: { $regex: sepTolerantPrefix(v) } } as any)
          .limit(SEP_CANDIDATE_CAP + 1).lean()
        for (const p of found) if (!seen.has(String(p._id))) { seen.add(String(p._id)); rows.push(p) }
      }
      sepCache.set(key, { rows, truncated: rows.length > SEP_CANDIDATE_CAP })
    }
    const bucket = sepCache.get(key)!
    // A truncated candidate set cannot prove uniqueness: a second match may sit outside the
    // window, so "exactly one hit" would be an artefact of the cap rather than a fact.
    if (bucket.truncated) continue
    const needle = foldHomoglyphs(squashed)
    const hits = bucket.rows.filter(
      (p: any) => foldHomoglyphs(squashSeparators(String(p.nameLower || ''))) === needle,
    )
    // ⚠ Refusing a multi-way hit is load-bearing, not caution. Measured 2026-10-08 with exactly
    // this key: regal-sf holds 342 colliding groups (690 rows), regal-pz 16 (32 rows), and 31 of
    // those groups carry stock on more than one row — 2,075 units sitting off the main row, one
    // of them negative. Taking the first would book a sale against whichever row happened to
    // sort first and look like a successful match.
    if (hits.length === 1) out[i] = toMatch(hits[0], 'token')
  }
  return out
}

/** How many leading characters of the squashed name anchor the candidate query. */
const SEP_ANCHOR_CHARS = 6
/** Above this many candidates the set is treated as unbounded (see rung 3d). */
const SEP_CANDIDATE_CAP = 2000

/**
 * Drop the characters this catalog uses purely to separate a name's fields.
 *
 * Deliberately narrow: whitespace, hyphen-minus, the Unicode dashes and the underscore.
 * Everything else is content.
 */
export function squashSeparators(s: string): string {
  return String(s).replace(/[\s\-‐-―_]+/g, '')
}

/**
 * `^`-anchored pattern matching the given characters with any run of separators between them,
 * so the anchor is invariant under the difference rung 3d exists to absorb — a catalog
 * "ШАЙБА - КОНУСНА" and a document "ШАЙБАКОНУСНА" share it.
 *
 * ⚠ The separator class is ASCII-only on purpose. Mongo compiles this with PCRE2, which does
 * not understand `\uXXXX`, and the exotic dashes cannot be written as literals here without
 * Bun transpiling them into exactly that (the same trap as a Cyrillic regex literal — PCRE2
 * 51091). They are still handled by `squashSeparators`, which runs in JS on both sides; this
 * pattern only has to fetch candidates, and PlusMinus writes a plain hyphen.
 */
function sepTolerantPrefix(chars: string): string {
  return '^' + [...chars].map(escapeRe).join('[\\s\\-_]*')
}

/** Latin letters whose lower-case glyph is indistinguishable from a Cyrillic one. */
const HOMOGLYPH_TO_CYRILLIC: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', b: 'в', h: 'н',
}
const HOMOGLYPH_TO_LATIN: Record<string, string> = Object.fromEntries(
  Object.entries(HOMOGLYPH_TO_CYRILLIC).map(([lat, cyr]) => [cyr, lat]),
)
/** Both spellings collapse onto the Cyrillic one, so either can find the other. */
export function foldHomoglyphs(s: string): string {
  return [...String(s)].map(c => HOMOGLYPH_TO_CYRILLIC[c] ?? c).join('')
}
function latiniseHomoglyphs(s: string): string {
  return [...String(s)].map(c => HOMOGLYPH_TO_LATIN[c] ?? c).join('')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** AI candidate-match through the ocr-server. Failure-tolerant: errors → all-null. */
export async function aiMatchLines(
  lines: string[],
  candidates: Array<{ id: string; name: string; sku?: string }>,
  opts: { timeoutMs?: number } = {},
): Promise<(string | null)[]> {
  if (!lines.length || !candidates.length) return lines.map(() => null)
  try {
    const res = await fetch(`${config.ocr.serverUrl}/match-lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines, candidates }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    })
    if (!res.ok) return lines.map(() => null)
    const data: any = await res.json()
    const matches = Array.isArray(data?.matches) ? data.matches : []
    const valid = new Set(candidates.map((c) => c.id))
    return lines.map((_, i) => (matches[i] && valid.has(String(matches[i])) ? String(matches[i]) : null))
  } catch {
    return lines.map(() => null)
  }
}

export interface MatchLinesOptions {
  /** Enables the alias rung. Only meaningful for incoming documents. */
  supplierId?: string
  /** Candidate products for the AI rung (an ORDO supplier group). Omit to skip rung 4. */
  aiCandidates?: Array<{ id: string; name: string; sku?: string }>
}

/**
 * Run the full ladder over a document's line descriptions.
 * Returns one slot per description, `null` where every rung missed.
 */
export async function matchLines(
  orgId: string,
  descriptions: string[],
  opts: MatchLinesOptions = {},
): Promise<Array<ProductMatch | null>> {
  const out: Array<ProductMatch | null> = descriptions.map(() => null)

  // Rung 1 — learned aliases, batched over the document's distinct wordings.
  if (opts.supplierId) {
    const norms = descriptions.map(d => normalizeAlias(d))
    const distinct = [...new Set(norms.filter(Boolean))]
    if (distinct.length) {
      const aliases: any[] = await SupplierProductAlias
        .find({ orgId, supplierId: opts.supplierId, aliasNormalized: { $in: distinct } } as any).lean()
      if (aliases.length) {
        const prods: any[] = await Product
          .find({ orgId, isActive: true, _id: { $in: aliases.map(a => a.productId) } } as any).lean()
        const prodById = new Map(prods.map(p => [String(p._id), p]))
        const byNorm = new Map(aliases.map(a => [String(a.aliasNormalized), a]))
        for (let i = 0; i < descriptions.length; i++) {
          const a = byNorm.get(norms[i])
          const p = a ? prodById.get(String(a.productId)) : null
          if (p) out[i] = toMatch(p, 'alias')
        }
        const usedIds = aliases.filter(a => prodById.has(String(a.productId))).map(a => a._id)
        if (usedIds.length) {
          SupplierProductAlias
            .updateMany({ _id: { $in: usedIds } } as any, { $inc: { hits: 1 }, $set: { lastUsedAt: new Date() } })
            .exec().catch(() => {})
        }
      }
    }
  }

  // Rungs 2–3 — exact / whitespace-tolerant, batched.
  const pendingIdx = out.map((m, i) => (m ? -1 : i)).filter(i => i >= 0)
  if (pendingIdx.length) {
    const hits = await matchProductsExact(orgId, pendingIdx.map(i => descriptions[i]))
    pendingIdx.forEach((idx, k) => { if (hits[k]) out[idx] = hits[k] })
  }

  // Rung 4 — AI against a small candidate set. Only when the caller supplied one.
  if (opts.aiCandidates?.length) {
    const leftover = out.map((m, i) => (m ? -1 : i)).filter(i => i >= 0)
    if (leftover.length) {
      const ai = await aiMatchLines(leftover.map(i => descriptions[i]), opts.aiCandidates)
      const ids = ai.filter(Boolean) as string[]
      if (ids.length) {
        const prods: any[] = await Product.find({ orgId, _id: { $in: ids } } as any).lean()
        const prodById = new Map(prods.map(p => [String(p._id), p]))
        leftover.forEach((idx, k) => {
          const p = ai[k] ? prodById.get(ai[k]!) : null
          if (p) out[idx] = toMatch(p, 'ai')
        })
      }
    }
  }

  return out
}
