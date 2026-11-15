/**
 * Which PlusMinus invoice numbers does LGR already hold? — the "is it imported" test of
 * `import-sales-invoices-api.ts`, pulled out so it can be tested.
 *
 * Two ways a PlusMinus invoice is in LGR:
 *   - IMPORTED: `INV-<number>` (the legacy number is passed through) or an all-digits `reference`;
 *   - ENTERED BY HAND in the LGR app: the app draws the next number from the SALES_DOC counter, which
 *     sits in PlusMinus's range because imports advance it, so the invoice is `INV-<year>-<number>`
 *     (regal-pz 2026-10-05..08: 64 of them, each matching a PlusMinus invoice 1:1 by day and total) with NO
 *     reference.
 * Only the first was recognised. A whole-folder import over those days would have created all 64 a second
 * time and dispatched their goods again. A hand-entered invoice is reported separately so the importer can
 * skip it loudly rather than guess.
 *
 * ⚠ An org that numbers its sales documents WITHOUT a year (the sequences page's option) issues its own
 * invoices as `INV-<number>`, the imported form. One entered by hand there is read as the first kind: the
 * PlusMinus invoice of that number counts as held, and is skipped as "already imported", not as "entered by
 * hand". The outcome is the same (it is not brought in a second time). What differs is who checks it:
 * `audit-coverage-api.ts` then compares it with the PlusMinus invoice of the same number, line count and
 * total, and lists a difference as `DIFF`, where the yearly form was only matched by day and total.
 */
export interface InvoiceRow { invoiceNumber?: string; reference?: unknown; type?: string; direction?: string; status?: string }

export function indexExistingInvoices(rows: InvoiceRow[]): { byNum: Map<string, InvoiceRow>; handEntered: Map<string, InvoiceRow> } {
  const byNum = new Map<string, InvoiceRow>()
  const handEntered = new Map<string, InvoiceRow>()
  for (const inv of rows) {
    const ref = String(inv.reference ?? '')
    if (/^\d+$/.test(ref)) byNum.set(ref, inv)
    const number = String(inv.invoiceNumber ?? '')
    const m = /^INV-(\d{6,})$/.exec(number)
    if (m) byNum.set(m[1], inv)
    const h = /^INV-\d{4}-(\d{6,})$/.exec(number)
    if (h && (inv.type ?? 'invoice') === 'invoice' && (inv.direction ?? 'outgoing') === 'outgoing') handEntered.set(h[1], inv)
  }
  return { byNum, handEntered }
}
