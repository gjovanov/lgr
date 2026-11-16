/**
 * FR-25 §5.2 and R7: which Contact a partner analytic of the books stands for. Import-pure, so the
 * rule is unit-tested as a table.
 *
 * ⚠ Never the name of a partner with a number: two companies can share one.
 *
 * - **A books org of its own** (no split): a partner is found by ONE key, as the seed skills find it: its
 *   ЕИК, else its VAT number, else its name, each exactly as written. A customer analytic finds a customer,
 *   a supplier one a supplier, a partner one a contact typed `both`. Among several, the last one held wins,
 *   as the map this replaced had it. This is exactly what the import always did, and a books org of its own
 *   still runs it: keep it.
 * - **A store org keeping a share of the books** (R7): the store already has its contacts, typed in over
 *   the years by its people, who wrote a number however they liked and typed a company by what the shop
 *   does with it.
 *   - A partner WITH a number is found by its numbers alone (`numbersOf`): their digits, so `BG`, spaces,
 *     dashes and dots do not count, and fewer than 5 digits or a number typed to fill the box
 *     (`000000000`) is no number. Its ЕИК is looked up first, then its VAT number, against every number a
 *     contact holds (`taxId`, `taxNumber`, `vatNumber`). Any type is found: the partner's own type first,
 *     then a `both`, then the other type (a company the shop buys from is the same company when the books
 *     sell to it), and among equals the OLDEST contact, so a re-run links the same one.
 *   - A partner with NO number is found by its name, as before: its own type, else a `both` (a partner:
 *     anyone, a `both` first), and among equals the last one held.
 *   Being found never changes a contact's type.
 *
 * Until this rule, a split compared the numbers as written and by type, and the first import into the
 * stores made a second Contact for a company the store already had. `scripts/relink-books-contacts.ts`
 * points what the books hold of such a contact at the older one, and removes it.
 */

export interface ContactIdentity {
  type: string
  taxId?: string
  /** The contact form keeps the ЕИК here ("Tax Number (EIK)"); the importers write both. */
  taxNumber?: string
  vatNumber?: string
  companyName?: string
  /** When the contact was made: in a split the oldest of equals wins. Unset: made by this run, newer than any held. */
  createdAt?: Date | string | number
}

/** A number with fewer digits than this is no number (R7). */
export const MIN_NUMBER_DIGITS = 5

/**
 * A number typed to fill the box: one digit over and over, or the counting sequence. It names no company, so it
 * finds none (the partner directory's import refuses the same, `doc-import/map-plusminus-partner.ts#idsOf`).
 */
const PLACEHOLDER = /^(\d)\1*$|^0?123456789\d?$/

/** A number as its digits (`BG 000-000-011` is `000000011`); undefined when that is no number. */
export function numberOf(value: unknown): string | undefined {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length >= MIN_NUMBER_DIGITS && !PLACEHOLDER.test(digits) ? digits : undefined
}

/** Every number a contact is found by in a split, each once, in the order a partner is looked up by them: ЕИК, then VAT number. */
export function numbersOf(c: Pick<ContactIdentity, 'taxId' | 'taxNumber' | 'vatNumber'>): string[] {
  return [...new Set([c.taxId, c.taxNumber, c.vatNumber].map(numberOf).filter((n): n is string => !!n))]
}

/** A books org of its own: the identifiers a contact is found by, as written, in the order a partner is looked up by them. */
function identifiers(c: Omit<ContactIdentity, 'type'>): string[] {
  return [
    ...(c.taxId ? [`id|${c.taxId}`] : []),
    ...(c.vatNumber ? [`vat|${c.vatNumber}`] : []),
    ...(c.companyName ? [`name|${c.companyName}`] : []),
  ]
}

/**
 * How well a contact of type `held` stands for a partner of type `wanted` found by its key as written (a books
 * org of its own) or by its name (a split): 0 is the type itself, 1 a stand-in a split org accepts,
 * `undefined` someone else.
 */
export function matchRank(wanted: string, held: string, split: boolean): number | undefined {
  if (held === wanted) return 0
  if (!split) return undefined
  if (wanted === 'both') return 1
  return held === 'both' ? 1 : undefined
}

/** A split, a partner found by its number: 0 its own type, 1 a `both`, 2 the other type. Nobody holding the number is refused. */
export function numberMatchRank(wanted: string, held: string): number {
  if (held === wanted) return 0
  return held === 'both' ? 1 : 2
}

interface Held<Id> {
  id: Id
  type: string
  /** Milliseconds since the epoch; `Infinity` for a contact made by this run. */
  age: number
}

function ageOf(createdAt: ContactIdentity['createdAt']): number {
  if (createdAt === undefined || createdAt === null) return Number.POSITIVE_INFINITY
  const ms = new Date(createdAt).getTime()
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}

function push<Id>(map: Map<string, Held<Id>[]>, key: string, held: Held<Id>): void {
  const list = map.get(key)
  if (list) list.push(held)
  else map.set(key, [held])
}

export class ContactIndex<Id> {
  /** Keys as written: a books org of its own looks up all of them, a split only its names. */
  private readonly byIdentifier = new Map<string, Held<Id>[]>()
  /** A split's numbers, as digits. */
  private readonly byNumber = new Map<string, Held<Id>[]>()

  constructor(private readonly split: boolean) {}

  add(id: Id, contact: ContactIdentity): void {
    const held = { id, type: contact.type, age: ageOf(contact.createdAt) }
    if (!this.split) {
      for (const key of identifiers(contact)) push(this.byIdentifier, key, held)
      return
    }
    if (contact.companyName) push(this.byIdentifier, `name|${contact.companyName}`, held)
    for (const n of numbersOf(contact)) push(this.byNumber, n, held)
  }

  /** The contact `wanted` is linked to (see the header); undefined when there is none. */
  find(wanted: ContactIdentity): Id | undefined {
    if (!this.split) return this.byKey(identifiers(wanted)[0], wanted.type)
    if (numbersOf(wanted).length) return this.findByNumber(wanted)
    return this.byKey(wanted.companyName ? `name|${wanted.companyName}` : undefined, wanted.type)
  }

  /**
   * A split: the contact holding one of `wanted`'s numbers, the ЕИК's first. Of several, the best type, and of
   * those the oldest (then the lowest id). Never by name: a partner without a number finds no one here.
   */
  findByNumber(wanted: ContactIdentity): Id | undefined {
    for (const n of numbersOf(wanted)) {
      let best: (Held<Id> & { rank: number }) | undefined
      for (const held of this.byNumber.get(n) ?? []) {
        const rank = numberMatchRank(wanted.type, held.type)
        if (!best || rank < best.rank || (rank === best.rank && (held.age < best.age || (held.age === best.age && String(held.id) < String(best.id))))) {
          best = { ...held, rank }
        }
      }
      if (best) return best.id
    }
    return undefined
  }

  /** By one key as written: the best type, and of those the last held. */
  private byKey(key: string | undefined, type: string): Id | undefined {
    if (!key) return undefined
    let best: { id: Id; rank: number } | undefined
    for (const held of this.byIdentifier.get(key) ?? []) {
      const rank = matchRank(type, held.type, this.split)
      if (rank !== undefined && (!best || rank <= best.rank)) best = { id: held.id, rank }
    }
    return best?.id
  }
}
