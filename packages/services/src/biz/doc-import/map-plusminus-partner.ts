/**
 * PlusMinus's partner directory → the contacts LGR should hold, for the daily import (`scripts/import-contacts-api.ts`).
 *
 * PlusMinus keeps its counterparties as analytic accounts, `GROUP:Name`, each with a few properties. The vendor's own
 * client loads them all with ONE call, `apProperties("ДОСТАВЧИЦИ:; КЛИЕНТИ:; ПАРТНЬОРИ:; КОНТРАГЕНТИ:")`, which answers
 * `{ "КЛИЕНТИ:Name": { БУЛСТАТ, ИНДДС, АДРЕС, ГРАД, МОЛ, ТЕЛ./ТЕЛЕФОН, … } }` (`pull-plusminus-api`, `--families partners`).
 * A shop's server has `КЛИЕНТИ` (its customer ledger) and `ПАРТНЬОРИ` (every name a document was ever written to or from,
 * suppliers included); a `ДОСТАВЧИЦИ` supplier ledger lives only in the accountant's books.
 *
 * What an import needs from it is small, and it is decided here, with no I/O so it can be tested on made-up data:
 *
 *  - WHICH partners: the ones the day's documents name (a sales invoice's customer; the supplier of a receipt that brings
 *    stock in), and, only when asked, every `КЛИЕНТИ` entry. Never the whole `ПАРТНЬОРИ` list: most of its thousands of
 *    names never traded with the shop in the period LGR holds.
 *  - WHO it is in LGR, in this order: the same ЕИК/VAT number, then the same name or one of the contact's other names,
 *    then the same words with other punctuation. A contact on file under a DIFFERENT ЕИК is another company, whatever
 *    its name (the rule `matching.ts#otherCompany` already applies): that pair is for a person.
 *  - WHAT to write: a contact nobody holds is created with what PlusMinus knows; a contact somebody holds is only FILLED
 *    where it is empty, given the name the documents use as one of its other names (so the next lookup by name finds it),
 *    and widened to `both` when it plays the other role too. Nothing that a person typed in LGR is overwritten.
 *
 * ⚠ `ЕГН` (a person's civil number, in 100+ entries of each shop) is never read. A sole trader's `БУЛСТАТ` can BE their
 * ЕГН and the seeded contacts already carry it as `taxId`; this module neither widens that nor copies the `ЕГН` field.
 */
import { cleanContactAliases, MAX_CONTACT_ALIASES, MAX_CONTACT_ALIAS_LENGTH } from 'config/contact-aliases'
import { hasRepresentative } from 'config/contact-representative'
import { foldName, normalizeName, partnerOf } from './supplier-name.js'

export type PartnerRole = 'customer' | 'supplier'
export type PartnerProps = Readonly<Record<string, string | undefined>>
/** `apProperties`'s answer: the full analytic name (`КЛИЕНТИ:Name`) → its properties. */
export type PartnerDirectory = Readonly<Record<string, PartnerProps>>

/** The groups the vendor's own client reads as partners, in the order it asks for them. */
export const PARTNER_GROUPS = ['ДОСТАВЧИЦИ', 'КЛИЕНТИ', 'ПАРТНЬОРИ', 'КОНТРАГЕНТИ'] as const
/** The argument of the one call that returns them all. */
export const PARTNER_GROUPS_ARG = PARTNER_GROUPS.map((g) => `${g}:`).join('; ')

const tidy = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '')

/** `КЛИЕНТИ:Name` → its group and its bare name (everything after the FIRST colon: a name may hold one, `СКЛАД:склад`). */
export function splitPartnerKey(key: string): { group: string; name: string } {
  const i = key.indexOf(':')
  return i < 0 ? { group: '', name: key.trim() } : { group: key.slice(0, i).trim(), name: key.slice(i + 1).trim() }
}

/**
 * The ЕИК/БУЛСТАТ in a property: 9 digits (a company), 13 (a company's branch) or 10 (a sole trader's civil number),
 * however it was typed ("204 856 684", "204856684 ЕООД"). A number Excel turned into a float ("1.12E+008") or any other
 * length is not an identifier: undefined.
 */
export function normalizeEik(raw: unknown): string | undefined {
  return /^(\d{13}|\d{10}|\d{9})(?!\d)/.exec(String(raw ?? '').replace(/\s+/g, ''))?.[1]
}

/** `BG204856684` for "BG 204 856 684", "bg204856684 …". A VAT number with no country prefix is no VAT number here. */
export function normalizeVat(raw: unknown): string | undefined {
  const m = /^\s*([A-Za-z]{2})[\s.-]*(\d[\d\s.-]{6,}\d)/.exec(String(raw ?? ''))
  if (!m) return undefined
  const d = digits(m[2])
  return d.length >= 8 && d.length <= 12 ? `${m[1].toUpperCase()}${d}` : undefined
}

/** A number typed to fill the box ("000000000", "999999999", "123456789"): it names no company, so it matches none. */
const JUNK_ID = /^(\d)\1{8,}$|^0?123456789\d?$/

/**
 * Every identifier a company can be found by: the digits of each number given (9 or more), and the first nine of a
 * 13-digit one, because a branch's number starts with its company's. A placeholder number is none.
 */
export function idsOf(...values: unknown[]): string[] {
  const out = new Set<string>()
  for (const v of values) {
    const d = digits(v)
    if (d.length < 9 || JUNK_ID.test(d)) continue
    out.add(d)
    if (d.length === 13) out.add(d.slice(0, 9))
  }
  return [...out]
}

/** What LGR would store for a partner, from its PlusMinus properties. */
export interface PartnerFields {
  name: string
  /** The ЕИК, digits only; what `taxId` and `taxNumber` hold (the form's „Tax Number (EIK)" reads the second). */
  eik?: string
  vat?: string
  phone?: string
  address?: { street: string; city?: string }
  /** The МОЛ: a contact's `representative` (FR-25a). Before it, a notes line `МОЛ: <name>`, which still counts as one. */
  contactPerson?: string
}

export function mapPartner(key: string, props: PartnerProps): PartnerFields {
  const { name } = splitPartnerKey(key)
  const get = (k: string) => tidy(props[k])
  const vat = normalizeVat(props['ИНДДС'])
  // As the seeded contacts: the БУЛСТАТ, else the digits of the VAT number (BG + the ЕИК).
  const eik = normalizeEik(props['БУЛСТАТ']) ?? normalizeEik(digits(props['ИНДДС']))
  const phone = get('ТЕЛЕФОН') || get('ТЕЛ.')
  const street = get('АДРЕС')
  const city = get('ГРАД').replace(/^гр\.?\s*/i, '')
  return {
    name,
    ...(eik ? { eik } : {}),
    ...(vat ? { vat } : {}),
    ...(digits(phone).length >= 6 ? { phone } : {}),
    ...(street || city ? { address: { street: street || city, ...(city ? { city } : {}) } } : {}),
    ...(get('МОЛ') ? { contactPerson: get('МОЛ') } : {}),
  }
}

/** Does PlusMinus say anything that identifies the partner besides its name? */
export const hasIdentity = (f: PartnerFields): boolean => !!(f.eik || f.vat || f.address)

/** On a supplier created from its name alone: where it came from, and that nothing else is known (shown to the staff). */
export const NAME_ONLY_NOTE = 'Създаден от партньор на стокова разписка в PlusMinus; там няма ЕИК или адрес за него.'

/**
 * The org's own stores and warehouses are partners of the documents that move goods between them (a transfer's
 * „МАГАЗИН- РЕГАЛ - СОФИЯ", a receipt from „СКЛАД:склад"): not counterparties, so never contacts.
 */
const INTERNAL_PARTNER = /^(склад|магазин|обект)/i
export function isInternalPartner(name: string, ownEik?: string, eik?: string): boolean {
  if (INTERNAL_PARTNER.test(tidy(name))) return true
  return !!ownEik && !!eik && idsOf(ownEik).some((id) => idsOf(eik).includes(id))
}

// ── Which partners the day names ───────────────────────────────────────────────────────────────────────────────────

export interface PartnerUse {
  key: string
  roles: Set<PartnerRole>
  /** The documents that name it, `invoicem 3000101867`. */
  docs: string[]
}

export interface UsedDocument {
  /** `invoicem` (a sales document: its partner is a customer) or `stokrazp` (a goods receipt: its partner is a supplier). */
  family: 'invoicem' | 'stokrazp'
  number: string
  header: { partner?: string }
  lines?: { quantity?: string | number }[]
}

/**
 * The partners a day's documents name, with the role each plays. A receipt names a supplier only when it brings stock
 * IN (a price-only restatement or a pure outgoing correction buys nothing), and not when its partner is the КОРЕКЦИЯ
 * placeholder or nobody.
 */
export function collectPartnerUses(docs: readonly UsedDocument[]): Map<string, PartnerUse> {
  const uses = new Map<string, PartnerUse>()
  const add = (key: string, role: PartnerRole, doc: UsedDocument) => {
    const u = uses.get(key) ?? uses.set(key, { key, roles: new Set(), docs: [] }).get(key)!
    u.roles.add(role)
    u.docs.push(`${doc.family} ${doc.number}`)
  }
  for (const d of docs) {
    // Trimmed only: the directory keeps PlusMinus's own spacing („ТЕСТ МВ  ООД"), and the key must read the same.
    const key = String(d.header?.partner ?? '').trim()
    if (!key || !key.includes(':')) continue
    if (d.family === 'invoicem') { add(key, 'customer', d); continue }
    if (partnerOf(key).kind !== 'supplier') continue
    if (!(d.lines ?? []).some((l) => Number(l.quantity ?? 0) > 0)) continue
    add(key, 'supplier', d)
  }
  return uses
}

// ── The plan ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A contact as the API lists it: only what the plan reads. */
export interface LgrContact {
  id: string
  type: 'customer' | 'supplier' | 'both'
  companyName?: string
  aliases?: string[]
  isActive?: boolean
  taxId?: string
  taxNumber?: string
  vatNumber?: string
  phone?: string
  notes?: string
  representative?: string
  addresses?: { street?: string; city?: string }[]
}

/** The body of `POST /invoicing/contact`, and (partial) of `PUT /invoicing/contact/:id`. */
export interface ContactBody {
  type?: 'customer' | 'supplier' | 'both'
  companyName?: string
  taxId?: string
  taxNumber?: string
  vatNumber?: string
  phone?: string
  notes?: string
  representative?: string
  aliases?: string[]
  addresses?: { type: string; street: string; city?: string; country: string; isDefault: boolean }[]
  isActive?: boolean
}

export type MatchedBy = 'eik' | 'name' | 'alias' | 'punctuation'

export type PlanItem =
  /**
   * `nameOnly`: PlusMinus holds nothing but the name (a supplier a store typed in on a receipt). `similar`: contacts on file
   * whose names start with the same word, for a person to look at; advice only, the contact is created.
   */
  | { kind: 'create'; key: string; name: string; roles: PartnerRole[]; body: ContactBody; docs: string[]; nameOnly?: boolean; similar?: string[] }
  | { kind: 'update'; key: string; name: string; contactId: string; contactName: string; by: MatchedBy; changes: string[]; body: ContactBody; docs: string[] }
  | { kind: 'same'; key: string; name: string; contactId: string; contactName: string; by: MatchedBy; docs: string[] }
  /** Several contacts fit and nothing narrows them: a person chooses (and may give one of them the name as another name). */
  | { kind: 'ambiguous'; key: string; name: string; reason: string; candidates: string[]; docs: string[] }
  /** The contact with this name holds a DIFFERENT ЕИК: another company, or a typo on one side. For a person. */
  | { kind: 'conflict'; key: string; name: string; reason: string; contactName: string; docs: string[] }
  /** The only contacts that fit are deactivated: reactivating or replacing one is a person's call. */
  | { kind: 'inactive'; key: string; name: string; contactName: string; docs: string[] }
  | { kind: 'skip'; key: string; name: string; why: 'internal' | 'correction' | 'no-data' | 'not-in-directory'; docs: string[] }

export interface ContactPlan {
  items: PlanItem[]
  counts: Record<PlanItem['kind'], number> & {
    /** Updates that give a contact another name / another role / how many empty fields they fill. */
    aliases: number
    roles: number
    fills: number
    /** Partners that are a contact this plan creates under another name: no second contact, an alias on the first. */
    merged: number
  }
}

const typeFor = (roles: Iterable<PartnerRole>): 'customer' | 'supplier' | 'both' => {
  const r = new Set(roles)
  return r.has('customer') && r.has('supplier') ? 'both' : r.has('supplier') ? 'supplier' : 'customer'
}
const covers = (type: LgrContact['type'], role: PartnerRole) => type === 'both' || type === role

interface Entry { c: LgrContact; ids: Set<string>; own: string; fold: string; aliasNames: Set<string>; aliasFolds: Set<string> }

/** Legal forms are no part of what a company is called: „ТЕСТ ЕООД" and „ТЕСТ-ФЛЕКС ООД" do not share „ЕООД". */
const LEGAL_FORM = new Set(['еоод', 'оод', 'еад', 'ад', 'ет', 'дззд', 'сд', 'кд', 'gmbh', 'ltd', 'ood', 'eood', 'sarl', 'srl', 'ag', 'bv', 'doo'])
/** The first word of a name that says anything: four letters or more, and no legal form. */
const firstWordOf = (name: string): string => foldName(name).split(' ').find((w) => w.length >= 4 && !LEGAL_FORM.has(w)) ?? ''

class ContactIndex {
  private entries: Entry[] = []
  private byId = new Map<string, Entry[]>()
  private byName = new Map<string, Entry[]>()
  private byFold = new Map<string, Entry[]>()
  private byFirst = new Map<string, Entry[]>()

  constructor(contacts: readonly LgrContact[]) { for (const c of contacts) this.add(c) }

  private put(map: Map<string, Entry[]>, key: string, e: Entry) {
    if (!key) return
    const list = map.get(key) ?? map.set(key, []).get(key)!
    if (!list.includes(e)) list.push(e)
  }

  add(c: LgrContact): Entry {
    const e: Entry = {
      c,
      ids: new Set(idsOf(c.taxId, c.taxNumber, c.vatNumber)),
      own: normalizeName(c.companyName),
      fold: foldName(c.companyName),
      aliasNames: new Set((c.aliases ?? []).map(normalizeName)),
      aliasFolds: new Set((c.aliases ?? []).map(foldName)),
    }
    this.entries.push(e)
    for (const id of e.ids) this.put(this.byId, id, e)
    this.put(this.byName, e.own, e)
    for (const a of e.aliasNames) this.put(this.byName, a, e)
    this.put(this.byFold, e.fold, e)
    for (const a of e.aliasFolds) this.put(this.byFold, a, e)
    this.put(this.byFirst, firstWordOf(c.companyName ?? ''), e)
    return e
  }

  /** Re-read a contact whose aliases or numbers just changed in the plan, so the next partner sees them. */
  refresh(e: Entry) { this.entries.splice(this.entries.indexOf(e), 1); for (const m of [this.byId, this.byName, this.byFold, this.byFirst]) for (const list of m.values()) { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1) } return this.add(e.c) }

  withIds(ids: readonly string[]): Entry[] { return [...new Set(ids.flatMap((id) => this.byId.get(id) ?? []))] }
  withName(name: string): Entry[] { return this.byName.get(normalizeName(name)) ?? [] }
  withFold(name: string): Entry[] { return this.byFold.get(foldName(name)) ?? [] }
  /** Active contacts whose name starts with the same word: advice for a person looking at a contact about to be created. */
  similar(name: string, limit = 3): string[] {
    const word = firstWordOf(name)
    return word ? (this.byFirst.get(word) ?? []).filter((e) => e.c.isActive !== false).slice(0, limit).map((e) => e.c.companyName ?? e.c.id) : []
  }
}

/** True when the contact's numbers and the partner's are all present and share none: two different companies. */
function disjoint(e: Entry, ids: readonly string[]): boolean {
  return e.ids.size > 0 && ids.length > 0 && !ids.some((id) => e.ids.has(id))
}

export interface PlanInput {
  directory: PartnerDirectory
  uses: ReadonlyMap<string, PartnerUse>
  contacts: readonly LgrContact[]
  ownEik?: string
  /** Also settle every `КЛИЕНТИ` entry that PlusMinus identifies (a one-off catch-up, not the daily default). */
  allClients?: boolean
}

const cloneContact = (c: LgrContact): LgrContact => ({
  ...c,
  ...(c.aliases ? { aliases: [...c.aliases] } : {}),
  ...(c.addresses ? { addresses: c.addresses.map((a) => ({ ...a })) } : {}),
})
const oldest = (list: Entry[]): Entry => [...list].sort((a, b) => a.c.id.localeCompare(b.c.id))[0]

export function planPartnerContacts(input: PlanInput): ContactPlan {
  // The plan edits its own copies: a later partner must see a contact as the plan will leave it, the caller's list stays.
  const index = new ContactIndex(input.contacts.map(cloneContact))
  const items: PlanItem[] = []
  const created = new Map<string, { item: Extract<PlanItem, { kind: 'create' }>; entry: Entry }>()
  const counts: ContactPlan['counts'] = { create: 0, update: 0, same: 0, ambiguous: 0, conflict: 0, inactive: 0, skip: 0, aliases: 0, roles: 0, fills: 0, merged: 0 }

  // The partners to settle, in a stable order: the day's own first.
  const wanted = new Map<string, { roles: Set<PartnerRole>; docs: string[] }>()
  for (const [key, u] of [...input.uses].sort(([a], [b]) => a.localeCompare(b, 'bg'))) wanted.set(key, { roles: new Set(u.roles), docs: u.docs })
  if (input.allClients) {
    for (const key of Object.keys(input.directory).sort((a, b) => a.localeCompare(b, 'bg'))) {
      if (splitPartnerKey(key).group !== 'КЛИЕНТИ') continue
      const w = wanted.get(key) ?? wanted.set(key, { roles: new Set(), docs: [] }).get(key)!
      w.roles.add('customer')
    }
  }

  // A document's partner and the directory's key are the same string, but a stray double space in one that was
  // typed twice differs in nothing else: look the exact key up first, then the same key with its spaces collapsed.
  const collapsed = new Map<string, string>()
  for (const k of Object.keys(input.directory)) if (!collapsed.has(tidy(k))) collapsed.set(tidy(k), k)

  for (const [wantedKey, w] of wanted) {
    const key = wantedKey in input.directory ? wantedKey : (collapsed.get(tidy(wantedKey)) ?? wantedKey)
    const name = splitPartnerKey(key).name
    const docs = w.docs
    const roles = [...w.roles]
    const props = input.directory[key]
    if (!props) { items.push({ kind: 'skip', key, name, why: 'not-in-directory', docs }); continue }
    const fields = mapPartner(key, props)
    if (isInternalPartner(name, input.ownEik, fields.eik)) { items.push({ kind: 'skip', key, name, why: 'internal', docs }); continue }
    if (!w.roles.has('customer') && partnerOf(key).kind === 'correction') { items.push({ kind: 'skip', key, name, why: 'correction', docs }); continue }

    const ids = idsOf(fields.eik, fields.vat)
    const nameKey = normalizeName(name)
    const foldKey = foldName(name)
    const active = (list: Entry[]) => list.filter((e) => e.c.isActive !== false)

    // 1. The same number. Several contacts may hold one (a company entered twice, a branch beside its head office): the
    //    invoice import takes the first it finds, so this takes the one named so, else the oldest, and does not stop.
    let found: Entry | undefined
    let by: MatchedBy | undefined
    const sameId = index.withIds(ids)
    const live = active(sameId)
    if (live.length) {
      const exactNumber = fields.eik ? live.filter((e) => e.ids.has(fields.eik!)) : []
      const pool = exactNumber.length ? exactNumber : live
      const named = pool.filter((e) => e.own === nameKey || e.aliasNames.has(nameKey))
      const worded = named.length ? named : pool.filter((e) => e.fold === foldKey || e.aliasFolds.has(foldKey))
      found = oldest(worded.length ? worded : pool)
      by = 'eik'
    }

    // 2. The same name, a contact's other name, then the same words (`matching.ts#matchContactByName`'s three rungs).
    //    Two contacts with one name: the older, as the import takes it. Two that merely share a other name or the words: a person.
    if (!found) {
      const named = active(index.withName(name))
      const own = named.filter((e) => e.own === nameKey)
      const other = own.length ? [] : named.filter((e) => e.aliasNames.has(nameKey))
      const words = own.length || other.length ? [] : active(index.withFold(name))
      const pool = own.length ? own : other.length ? other : words
      const usable = pool.filter((e) => !disjoint(e, ids))
      if (usable.length && (own.length || usable.length === 1)) { found = oldest(usable); by = own.length ? 'name' : other.length ? 'alias' : 'punctuation' }
      else if (usable.length > 1) { items.push({ kind: 'ambiguous', key, name, reason: `${usable.length} contacts fit the name and none exactly`, candidates: usable.map((e) => e.c.companyName ?? e.c.id), docs }); continue }
      else if (pool.length) { items.push({ kind: 'conflict', key, name, reason: 'a contact with this name holds a different ЕИК/VAT number', contactName: pool[0].c.companyName ?? pool[0].c.id, docs }); continue }
    }

    // Nothing active fits. A deactivated contact that does is not for this import to revive or duplicate.
    if (!found) {
      const dead = [...sameId, ...index.withName(name), ...index.withFold(name)].find((e) => e.c.isActive === false && !disjoint(e, ids))
      if (dead) { items.push({ kind: 'inactive', key, name, contactName: dead.c.companyName ?? dead.c.id, docs }); continue }
    }

    if (found) {
      const planned = created.get(found.c.id)
      const roleSet = roles.length ? roles : ['customer' as PartnerRole]
      if (planned) { mergeIntoCreate(planned.item, name, roleSet, docs, fields, counts); counts.merged++; continue }
      const { body, changes } = fillsFor(found.c, name, by!, roleSet, fields)
      if (!changes.length) { items.push({ kind: 'same', key, name, contactId: found.c.id, contactName: found.c.companyName ?? '', by: by!, docs }); counts.same++; continue }
      counts.update++
      counts.aliases += changes.some((c) => c.startsWith('alias')) ? 1 : 0
      counts.roles += changes.some((c) => c.startsWith('type')) ? 1 : 0
      counts.fills += changes.filter((c) => c.startsWith('fill')).length
      items.push({ kind: 'update', key, name, contactId: found.c.id, contactName: found.c.companyName ?? '', by: by!, changes, body, docs })
      // The next partner sees the contact as it will be.
      applyBody(found.c, body)
      index.refresh(found)
      continue
    }

    // 3. Nobody holds it: create it. A customer PlusMinus says nothing about is left to the invoice import, which creates
    //    it by name when it must; a SUPPLIER of a receipt is created by its name alone, because a receipt can only name a
    //    supplier that exists (FR-28.12) and PlusMinus's own record of it is all there is. Contacts that start with the
    //    same word are listed beside it, for a person to merge if it is a short form of one of them.
    const nameOnly = !hasIdentity(fields)
    if (nameOnly && !w.roles.has('supplier')) { items.push({ kind: 'skip', key, name, why: 'no-data', docs }); continue }
    const body: ContactBody = {
      type: typeFor(roles.length ? roles : ['customer']),
      companyName: name,
      ...(fields.eik ? { taxId: fields.eik, taxNumber: fields.eik } : {}),
      ...(fields.vat ? { vatNumber: fields.vat } : {}),
      ...(fields.phone ? { phone: fields.phone } : {}),
      ...(fields.address ? { addresses: [{ type: 'billing', street: fields.address.street, ...(fields.address.city ? { city: fields.address.city } : {}), country: 'BG', isDefault: true }] } : {}),
      ...(fields.contactPerson ? { representative: fields.contactPerson } : {}),
      ...(nameOnly ? { notes: NAME_ONLY_NOTE } : {}),
      isActive: true,
    }
    const similar = nameOnly ? index.similar(name) : []
    const item: Extract<PlanItem, { kind: 'create' }> = { kind: 'create', key, name, roles: roles.length ? roles : ['customer'], body, docs, ...(nameOnly ? { nameOnly: true } : {}), ...(similar.length ? { similar } : {}) }
    items.push(item)
    counts.create++
    // A later partner with the same number is this contact under another name, not a second contact.
    const virtual: LgrContact = { id: `new:${counts.create}`, type: body.type!, companyName: name, taxId: body.taxId, taxNumber: body.taxNumber, vatNumber: body.vatNumber, isActive: true }
    created.set(virtual.id, { item, entry: index.add(virtual) })
  }

  counts.skip = items.filter((i) => i.kind === 'skip').length
  counts.ambiguous = items.filter((i) => i.kind === 'ambiguous').length
  counts.conflict = items.filter((i) => i.kind === 'conflict').length
  counts.inactive = items.filter((i) => i.kind === 'inactive').length
  return { items, counts }
}

function applyBody(c: LgrContact, b: ContactBody) {
  if (b.type) c.type = b.type
  if (b.taxId) c.taxId = b.taxId
  if (b.taxNumber) c.taxNumber = b.taxNumber
  if (b.vatNumber) c.vatNumber = b.vatNumber
  if (b.phone) c.phone = b.phone
  if (b.notes) c.notes = b.notes
  if (b.representative) c.representative = b.representative
  if (b.aliases) c.aliases = b.aliases
  if (b.addresses) c.addresses = b.addresses.map((a) => ({ street: a.street, city: a.city }))
}

/** A second partner name for a contact this plan creates: one contact, the other name an alias, the roles joined. */
function mergeIntoCreate(item: Extract<PlanItem, { kind: 'create' }>, name: string, roles: PartnerRole[], docs: string[], fields: PartnerFields, counts: ContactPlan['counts']) {
  item.docs.push(...docs)
  const type = typeFor([...item.roles, ...roles])
  for (const r of roles) if (!item.roles.includes(r)) item.roles.push(r)
  item.body.type = type
  const aliases = cleanContactAliases([...(item.body.aliases ?? []), name], item.body.companyName)
  if (aliases.length && aliases.length <= MAX_CONTACT_ALIASES && aliases.every((a) => a.length <= MAX_CONTACT_ALIAS_LENGTH)) { item.body.aliases = aliases; counts.aliases++ }
  if (!item.body.vatNumber && fields.vat) item.body.vatNumber = fields.vat
  if (!item.body.phone && fields.phone) item.body.phone = fields.phone
}

/**
 * What a matched contact is missing that PlusMinus knows. Fill-only: a field somebody typed is theirs. The name the
 * documents use becomes one of the contact's other names when it is not its name already, and only when the match was
 * made by number or by the same words (a name match IS the name).
 */
export function fillsFor(c: LgrContact, name: string, by: MatchedBy, roles: readonly PartnerRole[], f: PartnerFields): { body: ContactBody; changes: string[] } {
  const body: ContactBody = {}
  const changes: string[] = []
  const blank = (v: unknown) => !tidy(v)
  if (f.eik && blank(c.taxId)) { body.taxId = f.eik; changes.push('fill taxId') }
  if (f.eik && blank(c.taxNumber)) { body.taxNumber = f.eik; changes.push('fill taxNumber') }
  if (f.vat && blank(c.vatNumber)) { body.vatNumber = f.vat; changes.push('fill vatNumber') }
  if (f.phone && blank(c.phone)) { body.phone = f.phone; changes.push('fill phone') }
  if (f.address && !(c.addresses ?? []).some((a) => !blank(a.street))) {
    body.addresses = [{ type: 'billing', street: f.address.street, ...(f.address.city ? { city: f.address.city } : {}), country: 'BG', isDefault: true }]
    changes.push('fill address')
  }
  // A contact from before FR-25a keeps its МОЛ in its notes: it has one already (`hasRepresentative`).
  if (f.contactPerson && !hasRepresentative(c)) { body.representative = f.contactPerson; changes.push('fill representative') }
  if (by === 'eik' || by === 'punctuation') {
    const key = normalizeName(name)
    const known = key === normalizeName(c.companyName) || (c.aliases ?? []).some((a) => normalizeName(a) === key)
    if (!known) {
      const next = cleanContactAliases([...(c.aliases ?? []), name], c.companyName)
      if (next.length <= MAX_CONTACT_ALIASES && next.every((a) => a.length <= MAX_CONTACT_ALIAS_LENGTH) && next.length > (c.aliases ?? []).length) {
        body.aliases = next
        changes.push(`alias „${name}"`)
      }
    }
  }
  const missing = roles.filter((r) => !covers(c.type, r))
  if (missing.length) { body.type = 'both'; changes.push(`type ${c.type}→both`) }
  return { body, changes }
}
