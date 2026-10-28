import type { Migration } from '../types.js'

/**
 * A legal number issued twice is kept, flagged, beside the other document (FR-20.51, AC 51).
 *
 * A server cut off from lgrai.app, or one whose database went back, can issue a number that lgrai.app
 * or the restored copy also gave to another document. Both exist on paper, so both belong in the
 * books under that number. The later one is annulled by a credit note and re-issued under a new
 * number (ЗДДС чл. 116), never edited or deleted. The old unique key `{orgId, invoiceNumber}` could
 * hold only one of them. The new key `{orgId, invoiceNumber, numberClash.withId}` holds the pair,
 * because the second document names the first, and never a third.
 *
 * Every ordinary invoice has no `numberClash`, which the key reads as null, so `(org, number)` stays
 * exactly as unique for them as before. The new key is made first and the old one dropped after, so
 * there is no moment without one. Expand and contract both hold: the previous release never sets the
 * field, and its own index declaration is simply absent once this has run.
 *
 * Collection-wide, like any index: `orgFilter` does not apply. Idempotent: the key made once is not
 * made again, and the old one gone is not dropped again.
 */
const KEY = 'invoice_number_unique'
const OLD = 'orgId_1_invoiceNumber_1'

export const invoiceNumberClash: Migration = {
  id: '0010-invoice-number-clash',
  description: 'The invoice number key gains numberClash.withId, so a number issued twice is kept, flagged, beside the other document (FR-20.51, AC 51)',
  async up({ db, log }) {
    const invoices = db.collection('invoices')
    await invoices.createIndex({ orgId: 1, invoiceNumber: 1, 'numberClash.withId': 1 }, { unique: true, name: KEY })
    const names = (await invoices.indexes()).map(i => i.name)
    if (names.includes(OLD)) {
      await invoices.dropIndex(OLD)
      log(`the old key ${OLD} dropped; ${KEY} holds the numbers now`)
    }
  },
}
