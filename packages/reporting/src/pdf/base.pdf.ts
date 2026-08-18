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

export async function markdownToPdf(content: string, options?: MarkdownToPdfOptions): Promise<Buffer | undefined> {
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
