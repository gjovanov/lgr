/**
 * FR-31.22 (#796, slice B5) — jump to a document by its number: what the lookup answers.
 *
 * `GET /api/org/:orgId/lookup/documents?number=…` (`services/biz/document-lookup.service.ts`) matches the number
 * exactly, then as a prefix, over the invoices of every type, supplier orders, customer orders, reservations and stock
 * movements, and finds an issued document by the draft number it had. The top bar's field
 * (`ui-shell/components/DocumentJump.vue`) opens the one match, or lists several.
 *
 * Import-pure: the server and the browser read the same shapes.
 */

/**
 * Where a match belongs, which is also the page that opens it. The invoices are four: the sales documents (an invoice,
 * a credit or a debit note), the quotes (a proforma, an offer), the bills (every incoming document) and the till's
 * documents (a cash sale, its storno, a payment's receipt and its storno), each read by its own capability.
 */
export const LOOKUP_FAMILIES = ['sales', 'proforma', 'bill', 'cash', 'supplierOrder', 'customerOrder', 'reservation', 'movement'] as const
export type LookupFamily = (typeof LOOKUP_FAMILIES)[number]

export interface LookupMatch {
  family: LookupFamily
  id: string
  /** The document's number today. */
  number: string
  /** Set when the number asked for is the draft number this issued document had. */
  draftNumber?: string
  /** An invoice's type (`credit_note`, `offer`, …) or a movement's (`receipt`, `transfer`, …). */
  type?: string
  /** A till document's origin (`pos`, `backoffice`, `import`): it decides which page opens it. */
  origin?: string
  status?: string
  /** ISO: an invoice's or an order's issue date, a movement's date, when a reservation was made. */
  date?: string
  contactName?: string
}

export interface LookupAnswer {
  /** The number asked for, trimmed. */
  number: string
  /** The matches are exact (the number, or a draft number); otherwise they begin with it. */
  exact: boolean
  matches: LookupMatch[]
  /** More documents begin with it than are listed. */
  more: boolean
}

/** At most this many matches are listed. */
export const LOOKUP_LIMIT = 20

/** The longest number the field sends: every series of the app is far shorter. */
export const LOOKUP_MAX_LENGTH = 64

/** The number as it is looked up: trimmed, inner spaces kept (a typed number has none, a pasted one may end in one). */
export function lookupNumber(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, LOOKUP_MAX_LENGTH) : ''
}

/**
 * The spellings looked for: as typed, and in capitals, since every series the app numbers in is written in capitals
 * (`INV-`, `DRF-`, `SM-`, …) and a person types „inv-2026-7". Each is an exact value of the numbers' indexes, never a
 * case-insensitive scan of them.
 */
export function lookupSpellings(number: string): string[] {
  const upper = number.toUpperCase()
  return upper === number ? [number] : [number, upper]
}

/** A spelling as the start of a number: an anchored, escaped pattern, which an index reads as a range. */
export function prefixPattern(spelling: string): RegExp {
  return new RegExp(`^${spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
}
