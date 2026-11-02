import type { Migration } from '../types.js'

/**
 * 0007 again, for the cash sales booked since it ran (FR-21.5).
 *
 * `0007-cash-sale-line-totals-gross` made a cash sale's `lineTotal` gross for the till imports that
 * existed when it ran. The importer that reads the PlusMinus API went on writing the NET line value
 * for a while after that (`scripts/import-cash-register-sales-api.ts`, fixed in #429), so a day it
 * booked before the fix is net again, and the FR-03 aggregated export reads its net as "gross". The
 * importer writes gross now; this converts what it booked in between.
 *
 * The rule is 0007's, unchanged, and repeated rather than shared: the runner checksums a released
 * migration's file, so 0007 cannot be edited to export it.
 *
 * ⚠ Decided per DOCUMENT, never per line. An imported day's lines sum to its `subtotal` (net); a
 * gross document's lines sum to `subtotal + Σ taxAmount`. A day's VAT is always more than a cent,
 * so the two cannot be confused, and a converted document no longer matches: running this twice
 * changes nothing, and a document 0007 already converted is not touched. A per-line test cannot be
 * exact: on a line of a few cents the net and the gross differ by less than the rounding of
 * `quantity × unitPrice`.
 *
 * Only `lineTotal` changes; the document's totals were always right. Expand only: the previous
 * release reads `lineTotal` as an opaque amount and keeps working.
 */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export const cashSaleLineTotalsGrossLate: Migration = {
  id: '0011-cash-sale-line-totals-gross-late',
  description: "Cash sales' lineTotal is gross: convert the net lines the PlusMinus API import booked after 0007 ran (FR-21.5)",
  async up({ db, log, orgFilter }) {
    const invoices = db.collection('invoices')
    let converted = 0
    let ops: any[] = []
    const flush = async () => {
      if (!ops.length) return
      await invoices.bulkWrite(ops, { ordered: false })
      ops = []
    }

    for await (const doc of invoices.find(
      { ...orgFilter, type: 'cash_sale', 'lines.0': { $exists: true } },
      { projection: { lines: 1, subtotal: 1 } },
    )) {
      const lines: any[] = doc.lines || []
      // The imports never discount a line, nor does the cash-sale form: a discounted line is not
      // one of theirs, and a discount equal to the VAT must not pass for a net document.
      if (lines.some(l => Number(l.discount) || 0)) continue
      const sumLines = round2(lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0))
      const sumTax = round2(lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0))
      // Not net, or nothing to add: a gross document, or one whose every line is VAT-free.
      if (sumTax <= 0.01 || Math.abs(sumLines - round2(doc.subtotal)) > 0.01) continue

      const next = lines.map(l => ({ ...l, lineTotal: round2((Number(l.lineTotal) || 0) + (Number(l.taxAmount) || 0)) }))
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { lines: next } } } })
      converted++
      if (ops.length >= 500) await flush()
    }
    await flush()
    log(`cash sales whose lines now carry gross line totals: ${converted}`)
  },
}
