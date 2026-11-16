/**
 * Issuer line printed in the page foot of a document, beneath the software-credit line printed by
 * the generators (see `reporting/product-credit`).
 *
 * One definition for every printed form: the invoice and its companions (`invoicing-api`, which
 * re-exports it from `lib/invoice-pdf`), and the stock movement (`stock-movement-document.service`).
 */
export function orgFooterLine(org: any): string {
  return [
    org?.phone ? `тел.: ${org.phone}` : '',
    org?.website,
  ].filter(Boolean).join('   ')
}
