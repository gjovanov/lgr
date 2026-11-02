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
