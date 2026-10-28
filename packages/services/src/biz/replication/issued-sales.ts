/**
 * FR-20.51: what no sync or repair path deletes or alters — an issued sale. An invoice that carries a
 * number and is no longer a draft (whatever its type and direction: a credit note, a bill, a cash
 * sale), and every till transaction (there is no draft of one: it is written when the sale is made).
 *
 * Import-pure: the apply on lgrai.app and the move worker on a master both decide with it.
 */

/** The collections that hold them, and the fields `issuedSale` reads. */
export const ISSUED_SALE_FIELDS: Readonly<Record<string, Record<string, 1>>> = {
  invoices: { status: 1, invoiceNumber: 1 },
  postransactions: { transactionNumber: 1, unpNumber: 1 },
}

/** The sale's number when `doc` (of `coll`) is an issued sale, else null. */
export function issuedSale(coll: string, doc: Record<string, any> | null | undefined): string | null {
  if (!doc) return null
  if (coll === 'invoices') return doc.status !== 'draft' && typeof doc.invoiceNumber === 'string' ? doc.invoiceNumber : null
  if (coll === 'postransactions') return String(doc.unpNumber ?? doc.transactionNumber ?? doc._id)
  return null
}
