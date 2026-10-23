import { describe, it, expect, afterEach } from 'bun:test'
import net from 'node:net'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { config } from 'config'
import { markdownToPdf, renderedPageDom, mdToPdfPageDom, looksLikePdf, buildHeader, CHROME_OVER_PIPE } from 'reporting/pdf/base.pdf'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { buildReportHtml } from 'reporting/pdf/report.pdf'
import { buildCashAggHtml } from 'reporting/pdf/cash-agg.pdf'

/**
 * The in-process PDF renderer (FR-20.25, plan step P0a-2).
 *
 * Two properties, each with the control that keeps it honest:
 *   • PARITY — Chrome is handed the same page md-to-pdf handed it. Compared as the DOM Chrome
 *     prints (md-to-pdf's `as_html`), not as PDF bytes, which carry timestamps and ids.
 *   • NOTHING LISTENS — no socket is opened for listening while a document renders, measured
 *     in-process AND in the OS socket table (Chrome is another process). The same probe run
 *     on md-to-pdf must find a listener, or the probe proves nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const RENDER_TIMEOUT = 120_000

afterEach(() => { (config.pdf as any).renderer = 'chrome' })

// ── Fixtures: what the real builders hand the renderer ─────────────────────────────────────

const invoice = buildInvoiceHtml(
  {
    invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing',
    issueDate: new Date('2026-03-21'), currency: 'BGN', subtotal: 100, taxTotal: 20, total: 120,
    lines: [{ description: 'Болт М8х25 ZN', quantity: 1, unit: 'бр', unitPrice: 100, taxRate: 20, lineTotal: 120 }],
  } as any,
  { name: 'Test Org' } as any,
  { companyName: 'Acme' } as any,
  undefined,
  { locale: 'bg' },
)

const report = buildReportHtml({
  title: 'Продажби — документи',
  orgName: 'Acme Corp',
  columns: [
    { key: 'd', header: 'Дата', type: 'date' },
    { key: 'n', header: 'Документ', type: 'text' },
    { key: 't', header: 'Общо', type: 'money' },
  ] as any,
  rows: [{ d: '2026-10-16', n: 'INV-2025-0020', t: 575.84 }],
  totals: { t: 575.84 },
  totalsLabel: 'Общо',
  locale: 'bg',
} as any)

const cashAgg = buildCashAggHtml({
  title: 'Касови продажби — по продукт',
  locale: 'bg',
  orgName: 'РЕГАЛ',
  period: { from: '2026-08-01', to: '2026-08-21' },
  sections: [{
    currency: 'BGN',
    rows: [{ productName: 'Болт М8х25 ZN', sku: 'BOLT-M8X25', unit: 'pcs', totalQuantity: 15, avgUnitPrice: 0.11, netTotal: 1.6, taxTotal: 0.32, grossTotal: 1.92 }],
  }],
} as any)

/** The shape payslips, financial statements and order sheets produce: plain markdown. */
const markdown = buildHeader('Profit & Loss Statement', 'Acme Corp', '2026-01-01 – 2026-03-31')
  + '## Revenue\n\n| Account | Amount (EUR) |\n|---|---:|\n| Sales | 1,234.50 |\n| **Total** | **1,234.50** |\n\n'
  + '**Order No** ORDO-2026-00001  \n**Date:** 2026-10-20  \n\n'
  + '- one\n- two\n\n```ts\nconst x = 1\n```\n'

const FIXTURES: Array<[string, string, Record<string, unknown>]> = [
  ['invoice form', invoice.html, { css: invoice.css, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } }],
  ['report', report.html, { css: report.css, landscape: report.landscape }],
  ['cash aggregate', cashAgg.html, { css: cashAgg.css }],
  ['markdown report', markdown, {}],
]

// ── Parity ─────────────────────────────────────────────────────────────────────────────────

/** Stylesheet comments differ by construction (md-to-pdf appends a sourceURL; the vendored
 * copy carries its licence). Nothing else is normalised. */
function normalise(dom: string): string {
  return dom.replace(/<style>([\s\S]*?)<\/style>/g, (_m, css: string) =>
    `<style>${css.replace(/\/\*[\s\S]*?\*\//g, '').trim()}</style>`)
}

describe('the in-process renderer prints the page md-to-pdf printed', () => {
  for (const [name, content, options] of FIXTURES) {
    it(name, async () => {
      const before = normalise(await mdToPdfPageDom(content, options as any))
      const after = normalise(await renderedPageDom(content, options as any))
      expect(after).toBe(before)
    }, RENDER_TIMEOUT)
  }
})

// ── Nothing listens ────────────────────────────────────────────────────────────────────────

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}

/** Every listening TCP socket on the machine, with its owner. */
async function listeningSockets(): Promise<Array<{ pid: number; addr: string }>> {
  if (process.platform === 'win32') {
    return (await run(['netstat', '-ano'])).split('\n')
      .map(l => l.trim().split(/\s+/))
      .filter(c => c[0]?.startsWith('TCP') && c[3] === 'LISTENING')
      .map(c => ({ addr: c[1], pid: Number(c[4]) }))
  }
  if (process.platform === 'darwin') {
    const out: Array<{ pid: number; addr: string }> = []
    let pid = 0
    for (const l of (await run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])).split('\n')) {
      if (l.startsWith('p')) pid = Number(l.slice(1))
      else if (l.startsWith('n')) out.push({ pid, addr: l.slice(1) })
    }
    return out
  }
  return linuxListeningSockets()
}

/**
 * Linux, from /proc: no `ss` or `netstat`, which a minimal CI runner does not have.
 * LISTEN rows (state 0A) of /proc/net/tcp{,6} give the address and the socket inode; the inode is
 * matched to its owner through /proc/<pid>/fd. A process we may not read keeps pid 0, the same as
 * `ss -p` without root.
 */
async function linuxListeningSockets(): Promise<Array<{ pid: number; addr: string }>> {
  const byInode = new Map<string, string>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c[3] !== '0A') continue
      const [hexAddr, hexPort] = c[1].split(':')
      byInode.set(c[9], `${procAddr(hexAddr)}:${parseInt(hexPort, 16)}`)
    }
  }
  const owner = new Map<string, number>()
  for (const pid of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
      const m = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))
      if (m && byInode.has(m[1])) owner.set(m[1], Number(pid))
    }
  }
  return [...byInode].map(([inode, addr]) => ({ addr, pid: owner.get(inode) ?? 0 }))
}

/** A /proc/net hex address: IPv4 is one little-endian word, IPv6 four. */
function procAddr(hex: string): string {
  if (hex.length === 8) return [3, 2, 1, 0].map(i => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.')
  const words = [0, 1, 2, 3].map(w => hex.slice(w * 8, w * 8 + 8).match(/../g)!.reverse().join(''))
  const groups = words.join('').match(/.{4}/g)!.map(g => parseInt(g, 16).toString(16))
  return `[${groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::')}]`
}

async function runningPids(): Promise<Set<number>> {
  const out = process.platform === 'win32'
    ? (await run(['tasklist', '/fo', 'csv', '/nh'])).split('\n').map(l => Number(l.split('","')[1]))
    : process.platform === 'linux'
      ? (await readdir('/proc').catch(() => [] as string[])).map(Number)
      : (await run(['ps', '-A', '-o', 'pid='])).split('\n').map(l => Number(l.trim()))
  return new Set(out.filter(n => Number.isFinite(n) && n > 0))
}

/**
 * Render, and report every socket that started listening meanwhile and belongs to this process
 * or to a process that did not exist before the render (Chrome and its helpers).
 */
async function listenersDuringRender(render: () => Promise<unknown>): Promise<string[]> {
  const inProcess: string[] = []
  const realListen = net.Server.prototype.listen
  net.Server.prototype.listen = function (this: net.Server, ...args: any[]) {
    inProcess.push(`net.Server.listen(${JSON.stringify(args[0] ?? null)})`)
    return (realListen as any).apply(this, args)
  } as any

  const preexisting = await runningPids()
  const baseline = new Set((await listeningSockets()).map(s => `${s.pid} ${s.addr}`))
  const seen = new Set<string>()
  let done = false
  const rendering = render().finally(() => { done = true })
  try {
    while (!done) {
      for (const s of await listeningSockets()) {
        const key = `${s.pid} ${s.addr}`
        if (baseline.has(key)) continue
        if (s.pid === process.pid || !preexisting.has(s.pid)) seen.add(`pid ${s.pid} listening on ${s.addr}`)
      }
      // Yield: Puppeteer drives Chrome through this same event loop.
      await new Promise(r => setTimeout(r, 10))
    }
    await rendering
  } finally {
    net.Server.prototype.listen = realListen
  }
  return [...inProcess, ...seen]
}

describe('rendering opens no listening socket (FR-20.25, AC 10)', () => {
  it('an invoice renders with nothing listening, in-process or in the OS socket table', async () => {
    const found = await listenersDuringRender(() => markdownToPdf(invoice.html, { css: invoice.css }))
    // Windows only (see `CHROME_OVER_PIPE`): Chrome's own DevTools port on loopback is tolerated.
    // Nothing in this process, and nothing on a non-loopback address, ever is.
    const loopbackChrome = (f: string) =>
      /^pid \d+ listening on (127\.0\.0\.1|\[::1\]):\d+$/.test(f) && !f.startsWith(`pid ${process.pid} `)
    const tolerated = CHROME_OVER_PIPE ? [] : found.filter(loopbackChrome)
    expect(found.filter(f => !tolerated.includes(f))).toEqual([])
  }, RENDER_TIMEOUT)

  it('positive control: the same probe sees md-to-pdf\'s server', async () => {
    ;(config.pdf as any).renderer = 'md-to-pdf'
    const found = await listenersDuringRender(() => markdownToPdf(invoice.html, { css: invoice.css }))
    expect(found.length).toBeGreaterThan(0)
  }, RENDER_TIMEOUT)
})

// ── It still makes a document ──────────────────────────────────────────────────────────────

describe('markdownToPdf with the in-process renderer', () => {
  it('returns a real PDF for an HTML form and for markdown', async () => {
    for (const [, content, options] of FIXTURES) {
      const pdf = await markdownToPdf(content, options as any)
      expect(looksLikePdf(pdf)).toBe(true)
      expect(Buffer.isBuffer(pdf)).toBe(true)
    }
  }, RENDER_TIMEOUT)
})
