import type { Migration } from '../types.js'

/**
 * One meaning for a cash sale's `lineTotal`: gross, as on every document the UI creates (FR-21.5).
 *
 * The PlusMinus till imports (`map-cash-sale.ts`, `scripts/import-cash-register-sales.ts`) wrote the
 * NET line value there, while the FR-03 aggregated export and the product ledger read
 * `lineTotal − taxAmount` as the net. An imported day therefore exported its net as "gross", and
 * its net as net minus VAT. The importers write gross now; this converts the lines already booked.
 *
 * ⚠ Decided per DOCUMENT, never per line. An imported day's lines sum to its `subtotal` (net); a
 * gross document's lines sum to `subtotal + Σ taxAmount`. A day's VAT is always more than a cent,
 * so the two cannot be confused, and a converted document no longer matches: running this twice
 * changes nothing. A per-line test cannot be exact: on a line of a few cents the net and the gross
 * differ by less than the rounding of `quantity × unitPrice`.
 *
 * Only `lineTotal` changes; the document's totals were always right. Expand only: the previous
 * release reads `lineTotal` as an opaque amount and keeps working.
 */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export const cashSaleLineTotalsGross: Migration = {
  id: '0007-cash-sale-line-totals-gross',
  description: "Cash sales' lineTotal is gross, as the UI writes it: convert the net lines the till imports booked (FR-21.5)",
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
