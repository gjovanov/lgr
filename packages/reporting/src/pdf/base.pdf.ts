import { productCredit } from '../product-credit.js'

export interface MarkdownToPdfOptions {
  /** Extra stylesheet injected into the rendered page (companion docs use it for their
   * fixed-form layout). Omitted for the plain markdown reports. */
  css?: string
  /** Page margins, when the document needs tighter framing than the report default. */
  margin?: { top: string; bottom: string; left: string; right: string }
  /** Landscape A4 — wide column sets (document lists) need it to stay readable. */
  landscape?: boolean
  /** Rendered into the page footer of every page. Supports Puppeteer's pageNumber/totalPages spans. */
  footerHtml?: string
  /** Locale for the default software-credit foot. */
  locale?: string
  /**
   * Forms that paint their own fixed `.page-foot` (invoice, companion documents) carry the
   * credit there and opt out of the Puppeteer footer so the line is not printed twice.
   */
  defaultFooter?: boolean
}

/** Software credit foot used by every PDF that does not paint its own. */
function creditFooter(locale?: string): string {
  return `<div style="width:100%;font-family:'DejaVu Sans',Arial,sans-serif;font-size:7pt;color:#000;padding:0 15mm;display:flex;justify-content:space-between;gap:8px;">
    <span>${escHtml(productCredit(locale))}</span>
    <span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`
}

/**
 * Smallest believable PDF. `md-to-pdf` can return a buffer holding nothing but the
 * `%PDF-1.4\n` header (9 bytes) when its Chromium fails to render — under load it does this
 * instead of throwing. A caller has no way to tell that from a real document, so the file
 * reaches the user as a download that opens to nothing.
 */
const MIN_PDF_BYTES = 500

export class PdfRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfRenderError'
  }
}

/** `%PDF` magic plus enough body to be a real document. Exported for its unit test. */
export function looksLikePdf(buf: Buffer | undefined): boolean {
  if (!buf || buf.length < MIN_PDF_BYTES) return false
  return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46
}

async function renderOnce(content: string, options?: MarkdownToPdfOptions): Promise<Buffer | undefined> {
  const { mdToPdf } = await import('md-to-pdf')
  const footerTemplate = options?.footerHtml
    ?? (options?.defaultFooter === false ? undefined : creditFooter(options?.locale))
  const result = await mdToPdf({ content }, {
    ...(options?.css ? { css: options.css } : {}),
    pdf_options: {
      format: 'A4',
      landscape: options?.landscape ?? false,
      margin: options?.margin ?? { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      ...(footerTemplate
        ? {
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate,
          }
        : {}),
    },
    // Required when the process runs as root inside the container image.
    // Puppeteer's Chromium refuses to launch without a sandbox unless opted out.
    launch_options: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  })
  return result?.content
}

/**
 * Render markdown to a PDF, verifying the result is actually a document.
 *
 * Every `mdToPdf` call starts its own static-file server and its own Chromium; when several
 * run in one process the launch can fail in a way that yields a header-only buffer rather
 * than an error. Retrying gets a fresh browser and clears it. A run that still can't produce
 * a document throws — an export endpoint returning 500 is recoverable, a 9-byte download
 * that silently opens to nothing is not.
 */
export async function markdownToPdf(content: string, options?: MarkdownToPdfOptions): Promise<Buffer | undefined> {
  let last: Buffer | undefined
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      last = await renderOnce(content, options)
      if (looksLikePdf(last)) return last
    } catch (err) {
      lastErr = err
    }
    // Give the previous Chromium and its port a moment to be released.
    if (attempt < 3) await new Promise(r => setTimeout(r, 250 * attempt))
  }
  throw new PdfRenderError(
    lastErr
      ? `PDF rendering failed after 3 attempts: ${String((lastErr as any)?.message || lastErr)}`
      : `PDF rendering produced ${last ? `${last.length} bytes` : 'no output'} after 3 attempts — Chromium did not render the page`,
  )
}

// ── Shared HTML helpers for the HTML-rendered forms (invoice, document lists) ──

/** Escape user data before it goes into the generated markup. */
export function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** dd.mm.yyyy, as on the legacy printed forms. Empty for missing/invalid dates. */
export function fmtDate(d: Date | string | undefined | null): string {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${date.getFullYear()}`
}

const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', BGN: 'лв.', USD: '$', GBP: '£', MKD: 'ден.' }

/** Currency symbol for totals; falls back to the ISO code when unknown. */
export function currencyMark(code: string | undefined): string {
  return CURRENCY_SYMBOL[(code || '').toUpperCase()] || code || ''
}

/**
 * marked treats indented lines as code blocks and blank lines as paragraph breaks, so the
 * HTML we hand it must be flush-left and gap-free.
 */
export function flattenHtml(html: string): string {
  return html.split('\n').map(l => l.trim()).filter(Boolean).join('\n')
}

export function buildHeader(title: string, orgName: string, period?: string): string {
  let md = `# ${title}\n\n`
  md += `**Organization:** ${orgName}\n\n`
  if (period) md += `**Period:** ${period}\n\n`
  md += `**Generated:** ${new Date().toLocaleDateString()}\n\n---\n\n`
  return md
}
