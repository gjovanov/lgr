/**
 * What a posting is and who owes one (FR-29.14, .15). One place for the rule the handlers used to apply each on its
 * own, so the transaction that owes a posting and the drain that makes it agree.
 *
 * ── The postings and their keys ──────────────────────────────────────────────────────────────────────────────────
 * A posting key is `<event>:<source>`. One key is one journal entry (`JournalEntry.postingKey`, unique per org):
 *
 * - `invoice.posted:<invoiceId>` — an issued document's entry (an invoice, a credit or debit note, a bill issued with
 *   `/send`). A document is issued once.
 * - `payment.recorded:<invoiceId>:<paymentId>` — one payment row's entry, by the row's own id; and
 *   `payment.recorded:<invoiceId>:receipt:<receiptId>` for a payment a receipt took at the counter (FR-23). Each
 *   payment is a posting of its own.
 * - `stock.movement.confirmed:<movementId>` — a completed movement's valuation. A movement completes once.
 * - `pos.session.closed:<sessionId>` — a till session's one entry, at its close.
 *
 * Not postings of an event, and carrying no key: a void's reversal and a withdrawn payment's void (made by the void
 * itself, `accounting.service#voidJournalEntry`), an entry made by hand, and the books import's (`importKey`).
 */
import { Org, type IOrg, type PostingEvent } from 'db/models'

export type { PostingEvent }

export type OwedPosting =
  | { event: 'invoice.posted'; invoiceId: string; userId?: string }
  | { event: 'payment.recorded'; invoiceId: string; paymentId?: string; receiptId?: string; userId?: string }
  | { event: 'stock.movement.confirmed'; movementId: string; movementType?: string; userId?: string }
  | { event: 'pos.session.closed'; sessionId: string; userId?: string }

/** The posting's key (see the file head). */
export function postingKeyOf(p: OwedPosting): string {
  switch (p.event) {
    case 'invoice.posted': return `invoice.posted:${p.invoiceId}`
    case 'payment.recorded': return p.paymentId
      ? `payment.recorded:${p.invoiceId}:${p.paymentId}`
      : `payment.recorded:${p.invoiceId}:receipt:${p.receiptId ?? ''}`
    case 'stock.movement.confirmed': return `stock.movement.confirmed:${p.movementId}`
    case 'pos.session.closed': return `pos.session.closed:${p.sessionId}`
  }
}

/** The movement types whose confirm is valued in the journal (`createMovementValuationEntry`). */
export const VALUED_MOVEMENT_TYPES: ReadonlySet<string> = new Set(['dispatch', 'production_out', 'receipt', 'production_in', 'return'])

export type PostingSettings = Pick<NonNullable<IOrg['settings']>, 'accounting' | 'inventory'>

/** The org's settings a posting reads: its journals and its default accounts. */
export async function postingSettingsOf(orgId: string): Promise<PostingSettings> {
  const org = await Org.findById(orgId, { 'settings.accounting': 1, 'settings.inventory': 1 }).lean().exec()
  return { accounting: org?.settings?.accounting, inventory: org?.settings?.inventory }
}

/**
 * Whether an org with these settings posts this event: the journal the entry goes to is set (and, for a movement, the
 * inventory accounts, and a type that is valued). An org that does not post owes nothing, and gets no job.
 */
export function postsEvent(settings: PostingSettings, p: OwedPosting): boolean {
  const a = settings.accounting
  switch (p.event) {
    case 'invoice.posted': return !!(a?.defaultSaleJournalId || a?.defaultPurchaseJournalId)
    case 'payment.recorded': return !!(a?.defaultCashJournalId || a?.defaultBankJournalId)
    case 'pos.session.closed': return !!a?.defaultSaleJournalId
    case 'stock.movement.confirmed':
      return !!(settings.inventory?.defaultInventoryAccountId && settings.inventory?.defaultCOGSAccountId)
        && (!p.movementType || VALUED_MOVEMENT_TYPES.has(p.movementType))
  }
}
