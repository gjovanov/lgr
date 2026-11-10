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
import { Contact, Product, SupplierProductAlias, normalizeAlias } from 'db/models'
import { buildSearchFilter } from '../search.utils.js'
import { clean, digits } from './detect.js'
import type { MatchedBy, Party } from './types.js'
import { ocrMatchLines } from './ocr-client.js'
import { normalizeName, pickSupplierByName, type SupplierNameMatch } from './supplier-name.js'

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
  /** `enrich: false`: what the match would fill on the contact, left for the commit (#484). */
  fill?: ContactFill
}

/** The fields a match fills on a contact that predates proper field mapping, and only while they are empty. */
export interface ContactFill {
  taxNumber?: string
  taxId?: string
  addresses?: ReturnType<typeof partyAddressEntry>[]
}

/** Billing address entry from an extracted address (no postal code in legacy docs). */
export function partyAddressEntry(address: string, city?: string) {
  return { type: 'billing', street: address, ...(city ? { city } : {}), country: 'BG', isDefault: true }
}

/** The digits of every tax number given: an ЕИК, or a VAT number (BG + the ЕИК). */
function taxIds(...values: unknown[]): Set<string> {
  return new Set(values.map(digits).filter(Boolean))
}

/**
 * A contact on file under a different ЕИК is another company, whatever its name. A number missing
 * on either side is no conflict: the name is all there is to go on.
 */
function otherCompany(contact: any, documentIds: Set<string>): boolean {
  if (!documentIds.size) return false
  const recorded = taxIds(contact.taxId, contact.taxNumber, contact.vatNumber)
  if (!recorded.size) return false
  for (const id of recorded) if (documentIds.has(id)) return false
  return true
}

/** More contacts than this sharing the words of one name: a short name, not a match. */
const NAME_CANDIDATES = 20

/**
 * The name rung, the last and weakest. Every word of the document's name has to appear in the
 * contact's, which forgives a dropped " - " or a missing legal form, and also finds every company a
 * short name is part of: „ИСАВ ЕООД" is in „ИСАВ-1 - ЕООД" and in „ИСАВ-2 ЕООД". This used to take
 * whichever of those the database returned first, and kept it even when its ЕИК said it was
 * another company, so the document landed on another company's account.
 *
 * - An exact name wins; the same name entered twice gives the older contact.
 * - Otherwise one candidate is a match, and several are refused (`ambiguous`), never picked from.
 */
async function matchContactByName(
  orgId: string,
  typeIn: Record<string, unknown>,
  name: string,
  documentIds: Set<string>,
): Promise<{ contact?: any; ambiguous?: number }> {
  const sameCompany = (c: any) => !otherCompany(c, documentIds)
  const exact = (await Contact.find({ orgId, ...typeIn, companyNameLower: name.toLocaleLowerCase('bg') } as any)
    .sort({ _id: 1 }).lean()).filter(sameCompany)
  if (exact.length) return { contact: exact[0] }

  const f = buildSearchFilter(name, ['companyName'], { lowered: { companyName: 'companyNameLower' } })
  const loose = (await Contact.find({ orgId, ...typeIn, ...f } as any)
    .sort({ _id: 1 }).limit(NAME_CANDIDATES + 1).lean()).filter(sameCompany)
  if (loose.length === 1) return { contact: loose[0] }
  return loose.length ? { ambiguous: loose.length } : {}
}

/**
 * Find a Contact of the given type from an extracted party. Ladder: ЕИК → VAT → name.
 *
 * `create` controls the miss behaviour: the batch path creates the contact (that is what
 * the migration importer has always done), while the single-document path passes `false`
 * so the UI can offer the user a choice instead of silently adding a counterparty.
 *
 * A name several contacts share is neither matched nor created (a new one would be one more of
 * the same name): the result is null, and `onRefused` says why, for a person to choose.
 */
export async function matchContact(
  orgId: string,
  party: Party,
  type: 'customer' | 'supplier',
  opts: {
    create?: boolean
    /**
     * Fill a matched contact's empty ЕИК and address from the document. Default true. ⚠ An analysis
     * passes false and writes nothing: what it would fill comes back as `fill`, for the commit (#484).
     */
    enrich?: boolean
    onRefused?: (reason: string) => void
  } = {},
): Promise<ContactMatch | null> {
  const eik = clean(party?.company_id)
  const vat = clean(party?.vat_id)
  const name = clean(party?.name)
  const address = clean(party?.address)
  const city = clean(party?.city)
  const typeIn = { type: { $in: [type, 'both'] } }

  let c: any = null
  // The form keeps the ЕИК in `taxNumber` ("Tax Number (EIK)"), the importers in both.
  if (eik) c = await Contact.findOne({ orgId, ...typeIn, $or: [{ taxId: eik }, { taxNumber: eik }] }).lean()
  if (!c && vat) c = await Contact.findOne({ orgId, ...typeIn, vatNumber: vat }).lean()
  if (!c && name) {
    const byName = await matchContactByName(orgId, typeIn, name, taxIds(eik, vat))
    if (byName.ambiguous) {
      const many = byName.ambiguous > NAME_CANDIDATES ? `more than ${NAME_CANDIDATES}` : String(byName.ambiguous)
      opts.onRefused?.(`${many} contacts match „${name}" by name and none of them exactly: choose the ${type}`)
      return null
    }
    c = byName.contact ?? null
  }
  if (c) {
    // Enrich matched contacts that predate proper field mapping: the EIK belongs in
    // taxNumber (the "Tax Number (EIK)" form field) as well as taxId, and the address
    // in the structured addresses[] — not in notes.
    const set: ContactFill = {}
    const cEik = eik || digits(vat)
    if (!clean(c.taxNumber) && cEik) set.taxNumber = cEik
    if (!clean(c.taxId) && cEik) set.taxId = cEik
    if (!(c.addresses || []).length && address) set.addresses = [partyAddressEntry(address, city)]
    const fills = Object.keys(set).length > 0
    if (fills && opts.enrich !== false) await Contact.updateOne({ _id: c._id }, { $set: set })
    const best = (c.addresses || []).find((a: any) => a.isDefault) || (c.addresses || [])[0]
      || (address ? partyAddressEntry(address, city) : undefined)
    return {
      contactId: String(c._id), name: c.companyName || name, created: false, address: best,
      ...(fills && opts.enrich === false ? { fill: set } : {}),
    }
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
 * FR-28.12: the EXISTING supplier a free-text partner names (a PlusMinus goods receipt's `ПАРТНЬОРИ:…`), by EXACT
 * normalized name: the same words, any case, any run of whitespace between them (`supplier-name.ts#normalizeName`).
 * Active contacts of type supplier or both only. A name that matches none, or several, resolves to nothing (the
 * caller says so in its report); this never creates a contact from free text, and has no looser rung: the answer
 * decides who an article is "bought from", and a near name is another company until a person says otherwise.
 * ⚠ The pattern is built at runtime from a string: a Cyrillic regex LITERAL would be transpiled by Bun to \uXXXX
 * escapes and rejected by Mongo (PCRE2 51091), as the product ladder's whitespace rung is.
 */
export async function matchSupplierByName(orgId: string, partner: string): Promise<SupplierNameMatch> {
  const key = normalizeName(partner)
  if (!key) return { status: 'none' }
  const pattern = '^\\s*' + key.split(' ').map(escapeRe).join('\\s+') + '\\s*$'
  const rows: any[] = await Contact.find(
    { orgId, type: { $in: ['supplier', 'both'] }, isActive: { $ne: false }, companyNameLower: { $regex: pattern } } as any,
    { companyName: 1, type: 1, isActive: 1 },
  ).lean()
  return pickSupplierByName(key, rows.map(c => ({ id: String(c._id), companyName: c.companyName, type: c.type, isActive: c.isActive })))
}

/**
 * #484: what an analysis left for the commit to write about the counterparty, written now. An analysis
 * persists nothing, so it carries:
 *  - `contactFill`: the empty fields of a contact it matched that the document fills, filled now only if
 *    they are still empty;
 *  - `newContact`: a counterparty no contact matched, which the caller asked to create
 *    (`createMissingContact`). It is matched again first (ЕИК → VAT → exact name), so two documents
 *    for the same new customer in one batch make one contact, not two.
 * Both keys are taken off `mapped`, which goes on to be persisted. A `mapped` from before (a cached
 * analysis that already names its `contactId`) carries neither, and is left as it is.
 */
export async function settleMappedContact(
  orgId: string,
  mapped: { contactId?: string; contactName?: string; contactFill?: ContactFill; newContact?: NewContact },
): Promise<void> {
  const { contactFill, newContact } = mapped
  delete mapped.contactFill
  delete mapped.newContact
  if (mapped.contactId) {
    if (!contactFill) return
    const c: any = await Contact.findOne({ _id: mapped.contactId, orgId }, { taxNumber: 1, taxId: 1, addresses: 1 }).lean()
    if (!c) return
    const set: ContactFill = {}
    if (contactFill.taxNumber && !clean(c.taxNumber)) set.taxNumber = contactFill.taxNumber
    if (contactFill.taxId && !clean(c.taxId)) set.taxId = contactFill.taxId
    if (contactFill.addresses?.length && !(c.addresses || []).length) set.addresses = contactFill.addresses
    if (Object.keys(set).length) await Contact.updateOne({ _id: c._id }, { $set: set })
    return
  }
  if (!newContact?.name) return
  const party: Party = { name: newContact.name, company_id: newContact.eik, vat_id: newContact.vat, address: newContact.address, city: newContact.city } as Party
  const m = await matchContact(orgId, party, newContact.type, { create: true })
  if (!m) return
  mapped.contactId = m.contactId
  mapped.contactName = m.name
}

/** A counterparty an analysis found no contact for, to create at commit (#484). */
export interface NewContact {
  type: 'customer' | 'supplier'
  name: string
  eik?: string
  vat?: string
  address?: string
  city?: string
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
  // Each description, plus the same name with its TERMINAL period added or removed (see
  // `terminalDotVariants`). Still ONE `$in` query for the whole document.
  const wanted = [...new Set(lowers.flatMap(terminalDotVariants).filter(Boolean))]
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
  /** The first of this name's terminal-dot variants that the two maps know. */
  const lookup = (lower: string): any | undefined => {
    for (const v of terminalDotVariants(lower)) {
      const hit = byName.get(v) || bySku.get(v)
      if (hit) return hit
    }
    return undefined
  }

  // Rung 3: legacy exports keep multi-space padding ("НОЖ   ТЕХНИЧЕСКИ") that PDF text
  // collapses — still an exact match by content, only the run length of spaces differs.
  const wsCache = new Map<string, any | null>()
  for (let i = 0; i < descriptions.length; i++) {
    const lower = lowers[i]
    if (!lower) continue
    const exact = lookup(lower)
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
    if (!sepCache.has(key)) sepCache.set(key, await fetchSepCandidates(orgId, anchor))
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

/** Candidate rows for rung 3d's anchor, in either script. Shared with `findSeparatorTwins`. */
async function fetchSepCandidates(orgId: string, anchor: string): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = []
  const seen = new Set<string>()
  for (const v of [...new Set([anchor, foldHomoglyphs(anchor), latiniseHomoglyphs(anchor)])]) {
    const found: any[] = await Product
      .find({ orgId, isActive: true, nameLower: { $regex: sepTolerantPrefix(v) } } as any)
      .limit(SEP_CANDIDATE_CAP + 1).lean()
    for (const p of found) if (!seen.has(String(p._id))) { seen.add(String(p._id)); rows.push(p) }
  }
  return { rows, truncated: rows.length > SEP_CANDIDATE_CAP }
}

/**
 * The catalog rows whose name differs from this one only in separators — rung 3d's comparison,
 * exposed for ONE caller that must tell "none" from "several" where the rung reports only `null`.
 *
 * `createMissingProducts` is that caller. A name reaches it precisely because every rung missed,
 * and after rung 3d shipped one of the ways to miss is **ambiguity**: the rung refuses a name that
 * resolves to several twins. Left to its exact-`nameLower` check, it would then create a THIRD row
 * in a group that already has two — growing the very duplication the refusal exists to protect.
 */
export async function findSeparatorTwins(orgId: string, name: string): Promise<Array<{ _id: any; sku: string; name: string }>> {
  const lower = clean(name).toLocaleLowerCase('bg')
  const squashed = squashSeparators(lower)
  const anchor = squashed.slice(0, SEP_ANCHOR_CHARS)
  if (anchor.length < 3) return []
  const { rows, truncated } = await fetchSepCandidates(orgId, anchor)
  if (truncated) return []     // cannot prove anything about a capped set — same rule as the rung
  const needle = foldHomoglyphs(squashed)
  return rows.filter(p => foldHomoglyphs(squashSeparators(String(p.nameLower || ''))) === needle) as any
}

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
 * A name with its TERMINAL period both present and absent.
 *
 * ⚠ Dots are preserved everywhere else on purpose — `13.5ММ` must never collapse onto `135ММ`, so
 * rung 3d keeps them. But a Bulgarian abbreviation carries a terminal stop that documents drop
 * freely (`Ш.П.` / `ПОДЛ.` / `ОРАНЖ.`), and no quantity or dimension ever ENDS in one, which makes
 * the final character the one place it is safe to ignore.
 *
 * Found 2026-10-23: regal-pz transfer note 0000615802 moved 1000 units of
 * „ШАЙБА - ПОДЛ. - Ф6Х24 - Ш.П" while the catalog held „… - Ш.П." — identical but for that dot.
 * No rung folded it, so the line read as a NEW article; on a transfer note the fork would have
 * gone to −1000 while the real product kept its stock, drifting two rows from one character.
 *
 * Both directions are needed: the document may omit a dot the catalog has, or carry one it lacks.
 */
export function terminalDotVariants(lower: string): string[] {
  const bare = lower.replace(/[.\s]+$/, '')
  if (!bare) return [lower]
  return [...new Set([lower, bare, bare + '.'])]
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

/**
 * AI candidate-match through the ocr-server (on a master, through lgrai.app: `orgId`).
 * Failure-tolerant: errors → all-null.
 */
export async function aiMatchLines(
  lines: string[],
  candidates: Array<{ id: string; name: string; sku?: string }>,
  opts: { timeoutMs?: number; orgId?: string } = {},
): Promise<(string | null)[]> {
  if (!lines.length || !candidates.length) return lines.map(() => null)
  try {
    const matches = await ocrMatchLines(lines, candidates, opts)
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
      const ai = await aiMatchLines(leftover.map(i => descriptions[i]), opts.aiCandidates, { orgId })
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
