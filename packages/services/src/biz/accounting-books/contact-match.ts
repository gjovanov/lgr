/**
 * FR-25 §5.2 and R7: which Contact a partner analytic of the books stands for. Import-pure, so the
 * rule is unit-tested as a table.
 *
 * A partner is found by ONE key, as the seed skills find it: its ЕИК, else its VAT number, else its
 * name. ⚠ Never the name of a partner with a number: two companies can share one.
 *
 * - **A books org of its own** (no split): a customer analytic finds a customer, a supplier one a
 *   supplier, a partner one a contact typed `both`, exactly as the import always has. Among several,
 *   the last one held wins, as the map this replaced had it.
 * - **A store org keeping a share of the books** (R7): the store already has its contacts, and one
 *   that buys and sells is typed `both`. So a customer analytic finds a customer or else a `both`, a
 *   supplier one a supplier or else a `both`, and a partner one anyone (a `both` first). The contact's
 *   own type is never changed by being found.
 */

export interface ContactIdentity {
  type: string
  taxId?: string
  vatNumber?: string
  companyName?: string
}

/** The identifiers a contact can be found by, in the order a partner is looked up by them. */
function identifiers(c: Omit<ContactIdentity, 'type'>): string[] {
  return [
    ...(c.taxId ? [`id|${c.taxId}`] : []),
    ...(c.vatNumber ? [`vat|${c.vatNumber}`] : []),
    ...(c.companyName ? [`name|${c.companyName}`] : []),
  ]
}

/**
 * How well a contact of type `held` stands for a partner of type `wanted`: 0 is the type itself, 1 a
 * stand-in a split org accepts, `undefined` someone else.
 */
export function matchRank(wanted: string, held: string, split: boolean): number | undefined {
  if (held === wanted) return 0
  if (!split) return undefined
  if (wanted === 'both') return 1
  return held === 'both' ? 1 : undefined
}

export class ContactIndex<Id> {
  private readonly byIdentifier = new Map<string, { id: Id; type: string }[]>()

  constructor(private readonly split: boolean) {}

  add(id: Id, contact: ContactIdentity): void {
    for (const key of identifiers(contact)) {
      const held = this.byIdentifier.get(key)
      if (held) held.push({ id, type: contact.type })
      else this.byIdentifier.set(key, [{ id, type: contact.type }])
    }
  }

  /** The contact `wanted` is linked to: by its first identifier, the best type, and of those the last held. */
  find(wanted: ContactIdentity): Id | undefined {
    const key = identifiers(wanted)[0]
    if (!key) return undefined
    let best: { id: Id; rank: number } | undefined
    for (const held of this.byIdentifier.get(key) ?? []) {
      const rank = matchRank(wanted.type, held.type, this.split)
      if (rank !== undefined && (!best || rank <= best.rank)) best = { id: held.id, rank }
    }
    return best?.id
  }
}
