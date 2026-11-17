import { config } from 'config'
import { productCredit } from '../product-credit.js'
import { PAGE_SIDE_MARGIN, pageMargin, type PageMargin } from './page-margins.js'
import markdownCss from '../assets/markdown.css' with { type: 'text' }
import highlightCss from 'highlight.js/styles/github.css' with { type: 'text' }

export interface MarkdownToPdfOptions {
  /** Extra stylesheet injected into the rendered page (companion docs use it for their
   * fixed-form layout). Omitted for the plain markdown reports. */
  css?: string
  /**
   * Page margins, when the document frames its top and bottom differently from the default.
   * Build them with `pageMargin()`, so the sides stay the shared `PAGE_SIDE_MARGIN`.
   */
  margin?: PageMargin
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

/** The plain markdown documents' page (order sheet, payslip, statements). */
export const DEFAULT_PAGE_MARGIN = pageMargin('20mm', '20mm')

/**
 * Software credit foot used by every PDF that does not paint its own. A footer template spans
 * the whole sheet, so it pads itself in by the page's side margin to line up with the text.
 */
function creditFooter(locale?: string): string {
  return `<div style="width:100%;font-family:'DejaVu Sans',Arial,sans-serif;font-size:7pt;color:#000;padding:0 ${PAGE_SIDE_MARGIN};display:flex;justify-content:space-between;gap:8px;">
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

/** The page setup of every printed document. */
function pageOptions(options?: MarkdownToPdfOptions) {
  const footerTemplate = options?.footerHtml
    ?? (options?.defaultFooter === false ? undefined : creditFooter(options?.locale))
  return {
    format: 'A4' as const,
    landscape: options?.landscape ?? false,
    margin: options?.margin ?? DEFAULT_PAGE_MARGIN,
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
    ...NO_NETWORK_ARGS,
  ]
}

/**
 * The browser that prints reaches nothing: whatever it would fetch is sent to a proxy that is not
 * there (port 1 on loopback, where nothing listens), and `<-loopback>` takes away the exception
 * Chrome otherwise makes for this machine's own addresses. See `lockPage`, which this backs up.
 */
const NO_NETWORK_ARGS = ['--proxy-server=http://127.0.0.1:1', '--proxy-bypass-list=<-loopback>']

/**
 * A page being printed runs no script and fetches nothing.
 *
 * Every form is built from text people typed (a name, a note, an article), and a browser obeys
 * markup wherever it finds it. The builders print such text as text (`escHtml`, `mdText`); this
 * is the lock behind them, for the place one of them does not. Three parts, each closing what the
 * others leave open, measured 2026-11-16 with one page that tried everything:
 *   - no script: neither a script element nor an `on…` attribute runs;
 *   - every request the page makes is cancelled unless it is a `data:` URL, which is how a form
 *     carries its letterhead. Cancelled as `aborted`, so that a page trying to send itself
 *     elsewhere (a `refresh`) stays where it is: any other reason puts Chrome's error page in
 *     place of the document;
 *   - `NO_NETWORK_ARGS`, because a `<link rel="prefetch">` is fetched by the browser itself and
 *     never passes the page's interception.
 *
 * Puppeteer's own calls (`evaluate`, `addStyleTag`) go through the debugger, which none of the
 * three touches.
 */
async function lockPage(page: any): Promise<void> {
  await page.setJavaScriptEnabled(false)
  await page.setRequestInterception(true)
  page.on('request', (request: any) => {
    if (request.isInterceptResolutionHandled()) return
    const settled = request.url().startsWith('data:') ? request.continue() : request.abort('aborted')
    // The page may be gone by the time Chrome hears the answer.
    settled.catch(() => {})
  })
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
 * Both are imported as text, so a server bundle carries them (FR-20 plan step P0b-9). They used
 * to be read from disk beside this file and from `node_modules`, and a bundle has neither: every
 * PDF failed with ENOENT on `assets/markdown.css`.
 *
 * ⚠ Line endings are normalised to LF: a Windows checkout (`core.autocrlf=true`) has
 * `markdown.css` with CRLF, and the printed page must be the same on every OS.
 */
function defaultStylesheets(): string[] {
  if (!stylesheets) {
    const lf = (css: string) => css.replace(/\r\n/g, '\n')
    stylesheets = [lf(markdownCss), lf(highlightCss)]
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
 * Run `use` on the page exactly as Chrome is about to print it, in the render's own context, under the render's
 * deadline and its share of the render limit. Exported for the tests of FR-30.19 and .20.
 */
export async function onRenderedPage<T>(content: string, options: MarkdownToPdfOptions | undefined, use: (page: any) => Promise<T>): Promise<T> {
  return withRenderedPage(content, options, use)
}

/**
 * Evaluate a script expression in the page exactly as Chrome is about to print it, every
 * stylesheet applied. Exported for the layout tests, which measure where the text lands.
 */
export async function evaluateRenderedPage<T = unknown>(
  content: string,
  options: MarkdownToPdfOptions | undefined,
  expression: string,
): Promise<T> {
  return withRenderedPage(content, options, page => page.evaluate(expression))
}

/**
 * FR-30.19: one Chrome per process, started by the first render and closed after `config.pdf.browserIdleMs` without
 * one (D-7). Every PDF used to launch its own: 0.8 to 0.9 s a render warm, about 6 s the first. Each render gets a
 * browser context of its own (its own pages, storage and cache), closed after it, so two renders share nothing.
 *
 * A browser that dies (a crash, the kill of a stalled render) is forgotten at once: the renders it held fail into
 * `markdownToPdf`'s retry, whose next attempt starts a new one.
 */
interface SharedBrowser { browser: Promise<any>; idle?: ReturnType<typeof setTimeout> }
let shared: SharedBrowser | null = null
let rendering = 0
let launches = 0

/** How many Chromes this process has started (the test counts them over ten renders). */
export function pdfBrowserLaunches(): number {
  return launches
}

async function launchBrowser(deadlineMs: number): Promise<any> {
  const puppeteer = (await import('puppeteer')).default
  try {
    return await puppeteer.launch({
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
}

/** The process's Chrome, started when there is none. */
function sharedBrowser(deadlineMs: number): Promise<any> {
  if (shared) {
    if (shared.idle) clearTimeout(shared.idle)
    shared.idle = undefined
    return shared.browser
  }
  launches++
  const entry: SharedBrowser = { browser: launchBrowser(deadlineMs) }
  shared = entry
  entry.browser.then(
    (b) => b.on?.('disconnected', () => { if (shared === entry) shared = null }),
    () => { if (shared === entry) shared = null },
  )
  return entry.browser
}

/** Close the process's Chrome now (a stalled render, the server stopping), and forget it. */
export async function closePdfBrowser(): Promise<void> {
  const entry = shared
  shared = null
  if (!entry) return
  if (entry.idle) clearTimeout(entry.idle)
  const browser = await entry.browser.catch(() => /* the launch failed, so there is nothing to close; its render already failed with the error */ null)
  if (browser) await closeOrKill(browser)
}

/** With no render left, the browser closes after its idle time. The timer never keeps the process alive. */
function armIdle(): void {
  if (rendering > 0 || !shared || shared.idle) return
  const entry = shared
  entry.idle = setTimeout(() => {
    if (shared === entry && rendering === 0) void closePdfBrowser()
  }, config.pdf.browserIdleMs)
  ;(entry.idle as any).unref?.()
}

/**
 * FR-30.20 (D-6): at most `config.pdf.concurrency` renders at once in a process. A render past that waits for a slot,
 * inside the deadline it already has: one still waiting at its deadline fails as a stalled render does. Nothing used
 * to limit them (the batch e-mail limited itself to two).
 */
const waiting: Array<() => void> = []
let running = 0
let peak = 0

/** The most renders that ran at once in this process (the test reads it). */
export function pdfRendersPeak(): number {
  return peak
}

async function renderSlot(deadlineAt: number, deadlineMs: number): Promise<() => void> {
  if (running < Math.max(1, config.pdf.concurrency)) {
    running++
  } else {
    await new Promise<void>((resolve, reject) => {
      const wake = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        const at = waiting.indexOf(wake)
        if (at >= 0) waiting.splice(at, 1)
        reject(new Error(`PDF render did not finish within ${deadlineMs} ms`))
      }, Math.max(0, deadlineAt - Date.now()))
      waiting.push(wake)
    })
    // A slot handed over by its last holder: `running` still counts it.
  }
  peak = Math.max(peak, running)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

/**
 * One render, with a deadline (`config.pdf.renderTimeoutMs`), on the process's Chrome, in a context of its own.
 *
 * ⚠ Without a deadline, a render that stalls waits forever. Puppeteer allows each CDP command three
 * minutes, and nothing bounds `document.fonts.ready` or the close. On CI (Linux, over the pipe)
 * the third render in a row hung until the test runner killed the process, twice on 2026-10-23.
 * In production that would be a request that never answers, and a Chrome left behind each
 * time. A stalled attempt now fails, the Chrome is killed (a stall is a Chrome not to trust), and
 * `markdownToPdf` retries with a fresh browser.
 */
async function withRenderedPage<T>(
  content: string,
  options: MarkdownToPdfOptions | undefined,
  use: (page: any) => Promise<T>,
): Promise<T> {
  const html = await pageHtml(content)
  const deadlineMs = config.pdf.renderTimeoutMs
  const deadlineAt = Date.now() + deadlineMs
  const release = await renderSlot(deadlineAt, deadlineMs)
  rendering++
  let context: any
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const render = (async () => {
      const browser = await sharedBrowser(deadlineMs)
      context = await browser.createBrowserContext()
      const page = await context.newPage()
      await lockPage(page)
      // `load` fires once every image in the page has loaded (each is inline, see `lockPage`).
      // `networkidle0` added nothing for a page that fetches nothing, and cost nearly two seconds
      // a render waiting out a quiet period after the page had settled (median 2.76 s against
      // 0.93 s, same page, same Chrome).
      await page.setContent(html, { waitUntil: 'load' })
      for (const css of defaultStylesheets()) await page.addStyleTag({ content: css })
      if (options?.css) await page.addStyleTag({ content: options.css })
      await page.evaluate('document.fonts.ready')
      return await use(page)
    })()
    // An abandoned render still settles later, against a browser that is gone.
    render.catch(() => {})
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`PDF render did not finish within ${deadlineMs} ms`)), Math.max(0, deadlineAt - Date.now()))
    })
    try {
      return await Promise.race([render, stalled])
    } catch (err) {
      // A stalled render: its Chrome is killed, and the next render starts another.
      if (String((err as any)?.message || '').includes('did not finish within')) await closePdfBrowser()
      throw err
    }
  } finally {
    clearTimeout(timer)
    if (context) await closeContext(context)
    rendering--
    release()
    armIdle()
  }
}

/** Close a render's context, never waiting on one that does not answer. */
async function closeContext(context: any): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    context.close().catch(() => { /* its browser is gone (a crash, a kill), and the context with it */ }),
    new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000) }),
  ])
  clearTimeout(timer)
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

// The page md-to-pdf handed Chrome, the parity test's reference, is `tests/helpers/md-to-pdf-reference.ts`
// (FR-32.9): md-to-pdf is a dependency of the tests package only, never of one that ships.

/**
 * Render markdown to a PDF, verifying the result is actually a document.
 *
 * A render can fail in a way that yields a header-only buffer rather than an error (seen with
 * md-to-pdf), or because the process's Chrome died under it. Retrying clears it: a dead Chrome is
 * forgotten, and the next attempt starts another. A run that still can't produce a document throws — an
 * export endpoint returning 500 is recoverable, a 9-byte download that silently opens to
 * nothing is not.
 */
export async function markdownToPdf(content: string, options?: MarkdownToPdfOptions): Promise<Buffer | undefined> {
  let last: Buffer | undefined
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      last = await renderInProcess(content, options)
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

/**
 * A stored value as literal text on ONE line of a markdown-built document (the order sheets, the
 * payslip, the statements): its markup is shown, not obeyed, its markdown is not read as markdown
 * (a `[` opens no link and no image, a `*` no emphasis), a `|` does not end a table cell, and a
 * line break of its own becomes a `<br>`.
 */
export function mdText(value: unknown): string {
  return escHtml(String(value ?? '').trim())
    .replace(/[\\`*_[\]~|]/g, '\\$&')
    .replace(/\s*(?:\r\n|\r|\n)\s*/g, '<br>')
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
  md += `**Organization:** ${mdText(orgName)}\n\n`
  if (period) md += `**Period:** ${mdText(period)}\n\n`
  md += `**Generated:** ${new Date().toLocaleDateString()}\n\n---\n\n`
  return md
}
