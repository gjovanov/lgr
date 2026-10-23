import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { config } from 'config'
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

/** Page setup shared by both renderers, so the kill switch prints the same page. */
function pageOptions(options?: MarkdownToPdfOptions) {
  const footerTemplate = options?.footerHtml
    ?? (options?.defaultFooter === false ? undefined : creditFooter(options?.locale))
  return {
    format: 'A4' as const,
    landscape: options?.landscape ?? false,
    margin: options?.margin ?? { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    ...(footerTemplate
      ? {
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate,
        }
      : {}),
  }
}

/**
 * Chrome runs with its sandbox, except as root (the container image), where it cannot start
 * one. `PDF_CHROME_NO_SANDBOX=1` is for a non-root host whose kernel refuses the user
 * namespaces the sandbox needs (some hardened Linux CI runners).
 */
function chromeArgs(): string[] {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const noSandbox = isRoot || process.env.PDF_CHROME_NO_SANDBOX === '1'
  return [
    ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    '--disable-dev-shm-usage',
  ]
}

/**
 * Chrome is driven over its DevTools WebSocket (`--remote-debugging-port=0`), which Chrome binds
 * to 127.0.0.1 only: reachable from the same machine (in production, the same pod), never from
 * the network. `PDF_CHROME_PIPE=1` drives it over a pipe instead (`--remote-debugging-pipe`, file
 * descriptors 3 and 4), which opens no port at all, on Linux and macOS.
 *
 * ⚠ The pipe is not the default because Bun loses messages on it. Measured 2026-10-23 in the
 * production image (Bun 1.3.10) on mars, 60 renders of one report per mode, each in a fresh Chrome:
 *   pipe + networkidle0: 10 failed (6 in `setContent`, 4 inside `puppeteer.launch`);
 *   pipe + load: 1 failed (`addStyleTag`);
 *   WebSocket + networkidle0: none; WebSocket + load: none in 100, median 0.93 s.
 * A failure inside the launch, before any page exists, is CDP messages that never arrived. CI saw
 * the same thing as renders that hung. Same family as the Bun + serialport trap in CLAUDE.md.
 *
 * ⚠ On Windows, Bun cannot hand a child process descriptors beyond stdio at all: they arrive as
 * EBADF, and a `pipe: true` launch waits forever (measured, Bun 1.3.9), so the pipe is never used
 * there.
 */
export const CHROME_OVER_PIPE = process.platform !== 'win32' && process.env.PDF_CHROME_PIPE === '1'

let stylesheets: string[] | undefined
/**
 * md-to-pdf's default stylesheet, then highlight.js's `github` theme: its `stylesheet` list.
 *
 * ⚠ Line endings are normalised to LF: a Windows checkout (`core.autocrlf=true`) has
 * `markdown.css` with CRLF, and the printed page must be the same on every OS.
 */
function defaultStylesheets(): string[] {
  if (!stylesheets) {
    const read = (path: string | URL) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    const markdownCss = read(new URL('../assets/markdown.css', import.meta.url))
    const highlightCss = read(createRequire(import.meta.url).resolve('highlight.js/styles/github.css'))
    stylesheets = [markdownCss, highlightCss]
  }
  return stylesheets
}

/**
 * The page md-to-pdf 5.2.5 built (`lib/get-html.js`), from the same `marked` (4.3.0) with the
 * same options (`lib/get-marked-with-highlighter.js`).
 *
 * md-to-pdf also ran the input through `gray-matter`, which only acts on text that OPENS with a
 * `---` front-matter block. No builder produces one (each starts with `#` or `<`), so it is not
 * carried over.
 */
export async function pageHtml(content: string): Promise<string> {
  const { marked } = await import('marked')
  const hljs = (await import('highlight.js')).default
  const body = marked.parse(content, {
    highlight: (code: string, languageName: string) => {
      const language = hljs.getLanguage(languageName) ? languageName : 'plaintext'
      return hljs.highlight(code, { language }).value
    },
    langPrefix: 'hljs ',
  })
  return `<!DOCTYPE html>
<html>
	<head><title></title><meta charset="utf-8"></head>
	<body class="">
		${body}
	</body>
</html>
`
}

/**
 * FR-20.25: render without serving anything.
 *
 * md-to-pdf started an HTTP server on every interface for every document, serving the working
 * directory, and navigated Chrome to it before replacing the page with `setContent`. Here the page
 * is set directly, so nothing is served: the only socket a render opens is Chrome's own DevTools
 * port on loopback (`CHROME_OVER_PIPE`). Everything else — stylesheets in the same order, the
 * `screen` media type, `printBackground` — is what md-to-pdf did, so the output is unchanged.
 */
async function renderInProcess(content: string, options?: MarkdownToPdfOptions): Promise<Buffer> {
  return withRenderedPage(content, options, async (page) => {
    await page.emulateMediaType('screen')
    return Buffer.from(await page.pdf({ printBackground: true, ...pageOptions(options) }))
  })
}

/**
 * The page exactly as Chrome is about to print it — the DOM after every stylesheet. Exported
 * for the parity test, which compares it with md-to-pdf's `as_html` output for the same input.
 */
export async function renderedPageDom(content: string, options?: MarkdownToPdfOptions): Promise<string> {
  return withRenderedPage(content, options, page => page.content())
}

/**
 * One render, with a deadline (`config.pdf.renderTimeoutMs`).
 *
 * ⚠ Without one, a render that stalls waits forever. Puppeteer allows each CDP command three
 * minutes, and nothing bounds `document.fonts.ready` or the close. On CI (Linux, over the pipe)
 * the third render in a row hung until the test runner killed the process, twice on 2026-10-23.
 * In production that would be a request that never answers, and a Chrome left behind each
 * time. A stalled attempt now fails, its Chrome is killed, and `markdownToPdf` retries with a
 * fresh browser.
 */
async function withRenderedPage<T>(
  content: string,
  options: MarkdownToPdfOptions | undefined,
  use: (page: any) => Promise<T>,
): Promise<T> {
  const puppeteer = (await import('puppeteer')).default
  const html = await pageHtml(content)
  const deadlineMs = config.pdf.renderTimeoutMs
  let browser
  try {
    browser = await puppeteer.launch({
      pipe: CHROME_OVER_PIPE,
      ...(config.pdf.chromePath ? { executablePath: config.pdf.chromePath } : {}),
      args: chromeArgs(),
      timeout: deadlineMs,
      protocolTimeout: deadlineMs,
    })
  } catch (err: any) {
    const msg = String(err?.message || err)
    throw new Error(/sandbox/i.test(msg)
      ? `Chrome could not start its sandbox (${msg}). Run as a user the kernel allows to, or set PDF_CHROME_NO_SANDBOX=1.`
      : msg)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const render = (async () => {
      const page = await browser.newPage()
      // `load` fires once every image in the page has loaded, so a tenant logo given as an
      // absolute URL is there before printing. `networkidle0` added nothing for a page that
      // fetches nothing else, and cost nearly two seconds a render waiting out a quiet period
      // after the page had settled (median 2.76 s against 0.93 s, same page, same Chrome).
      await page.setContent(html, { waitUntil: 'load' })
      for (const css of defaultStylesheets()) await page.addStyleTag({ content: css })
      if (options?.css) await page.addStyleTag({ content: options.css })
      await page.evaluate('document.fonts.ready')
      return await use(page)
    })()
    // An abandoned render still settles later, against a browser that is gone.
    render.catch(() => {})
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`PDF render did not finish within ${deadlineMs} ms`)), deadlineMs)
    })
    return await Promise.race([render, stalled])
  } finally {
    clearTimeout(timer)
    await closeOrKill(browser)
  }
}

/** Close the browser, but never wait on one that does not answer: kill it instead. */
async function closeOrKill(browser: any): Promise<void> {
  const proc = browser.process?.()
  let timer: ReturnType<typeof setTimeout> | undefined
  const closed = await Promise.race([
    browser.close().then(() => true, () => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000) }),
  ])
  clearTimeout(timer)
  if (!closed && proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
}

/** The previous renderer, kept for one release behind `PDF_RENDERER=md-to-pdf`. */
async function renderWithMdToPdf(content: string, options?: MarkdownToPdfOptions): Promise<Buffer | undefined> {
  const { mdToPdf } = await import('md-to-pdf')
  const result = await mdToPdf({ content }, {
    ...(options?.css ? { css: options.css } : {}),
    pdf_options: pageOptions(options),
    // Required when the process runs as root inside the container image.
    // Puppeteer's Chromium refuses to launch without a sandbox unless opted out.
    launch_options: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  })
  return result?.content
}

/**
 * The page md-to-pdf hands Chrome (its `as_html`). Exported for the parity test only; it goes
 * when the kill switch does.
 */
export async function mdToPdfPageDom(content: string, options?: MarkdownToPdfOptions): Promise<string> {
  const { mdToPdf } = await import('md-to-pdf')
  const result = await mdToPdf({ content }, {
    ...(options?.css ? { css: options.css } : {}),
    as_html: true,
    launch_options: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
  } as any)
  return String(result?.content ?? '')
}

async function renderOnce(content: string, options?: MarkdownToPdfOptions): Promise<Buffer | undefined> {
  return config.pdf.renderer === 'md-to-pdf'
    ? renderWithMdToPdf(content, options)
    : renderInProcess(content, options)
}

/**
 * Render markdown to a PDF, verifying the result is actually a document.
 *
 * Every render launches its own Chromium; when several run in one process a launch can fail in
 * a way that yields a header-only buffer rather than an error (seen with md-to-pdf). Retrying
 * gets a fresh browser and clears it. A run that still can't produce a document throws — an
 * export endpoint returning 500 is recoverable, a 9-byte download that silently opens to
 * nothing is not.
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
    // Give the previous Chromium a moment to exit.
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
