/**
 * What a stock movement's notes say about where it came from (#168).
 *
 * A movement has no field for the kind of document behind it: every importer stamps a marker into
 * `notes` (`stokrazp:<n>`, `corr:<n>`, …) and looks for it before booking the document again. Those
 * notes are also the only thing that tells a `receipt` naming no supplier from a delivery, so the
 * words are defined here, once: the writers build them with these functions and
 * `receipt-bill.service.ts` reads them back. Pure, so the scripts can import it too.
 */

/** The marker prefix per document kind: what makes a re-import a no-op. */
export const MOVEMENT_MARKER_PREFIX: Record<string, string> = {
  goods_receipt: 'stokrazp',
  correction: 'corr',
  transfer_note: 'sklrazp',
  issue_note: 'sklisk',
  store_operations: 'storeOperations',
}

export function movementMarker(kind: string, key: string): string {
  return `${MOVEMENT_MARKER_PREFIX[kind] || 'doc'}:${key}`
}

/** A delivery's note: one разписка (`partner` is who it names), or a day's `Доставки`. */
export function deliveryNote(date: string, marker: string, partner?: string): string {
  return `Доставки — ${date}${partner ? ` — ${partner}` : ''} (${marker})`
}

/** The partner a КОРЕКЦИЯ is printed with, in a supplier's place. It is nobody's name. */
export const CORRECTION_PARTNER = /2000\s+КОРЕКЦИЯ/i

const RECONCILE_PREFIX = 'Reconcile '

/** The compensating movement of a document re-uploaded with other quantities. */
export function reconcileNote(fileName: string, version: unknown, marker: string): string {
  return `${RECONCILE_PREFIX}${fileName} v${version} (${marker})`
}

const REMOVAL_MARKER = '(docdelete:'

/** The mirror of a movement whose document was removed. */
export function removalReversalNote(movementNumber: string, docNumber: string): string {
  return `Reversal of ${movementNumber} — document removed ${REMOVAL_MARKER}${docNumber})`
}

/** Goods put back by a removal: mirroring a dispatch or a write-off books a `receipt`. */
export function isRemovalReversalNote(notes: unknown): boolean {
  return String(notes ?? '').includes(REMOVAL_MARKER)
}

const markedAs = (kind: string) => new RegExp(`(^|[\\s(])${MOVEMENT_MARKER_PREFIX[kind]}:`)
const NOT_A_DELIVERY = [
  markedAs('correction'),
  CORRECTION_PARTNER,
  // A day's `Доставки` holds several suppliers, and one supplier's bill cannot take them whole.
  markedAs('store_operations'),
  // The opposite half of a negative line on a transfer or a write-off note: goods coming back.
  markedAs('transfer_note'),
  markedAs('issue_note'),
]

/**
 * This `receipt` says it is no supplier's delivery: a correction, a reconcile delta or a whole day's
 * aggregate. Own-store and „склад" разписки say nothing of the kind, so the person has to read them.
 */
export function noteSaysNoDelivery(notes: unknown): boolean {
  const text = String(notes ?? '')
  return text.startsWith(RECONCILE_PREFIX) || NOT_A_DELIVERY.some(re => re.test(text))
}
