/**
 * The side margins of every PDF LGR prints, in one place.
 *
 * The document forms (the invoicing family, the protocol and the certificate printed beside
 * them, the stock receipt), the list and report exports, and the plain markdown documents
 * (order sheet, payslip, statements) all print with this width left and right.
 *
 * 18 mm since 2026-11-08: 1.5 × the 12 mm the forms and the lists printed with until then. The
 * side margins went up by half, and by the same amount on every document, so papers handed out
 * together line up alike. The markdown documents had a 15 mm default of their own and take the
 * same 18 mm, not 1.5 × 15 mm, so the margin stays the same on every document.
 *
 * Top and bottom stay each document's own: every form reserves its own room for its letterhead
 * and its page foot.
 *
 * ⚠ A Puppeteer footer template is laid out across the WHOLE sheet, margins included. A footer
 * that should line up with the text pads itself by this same width, so `footerTemplate`
 * (house-style.ts) and the default credit foot (base.pdf.ts) both read it from here. A footer
 * that hardcoded its own width kept the old margin when the page's changed.
 */
export const PAGE_SIDE_MARGIN = '18mm'

export interface PageMargin {
  top: string
  bottom: string
  left: string
  right: string
}

/** Page margins with the shared sides; the top and bottom are the document's own. */
export function pageMargin(top: string, bottom: string): PageMargin {
  return { top, bottom, left: PAGE_SIDE_MARGIN, right: PAGE_SIDE_MARGIN }
}
