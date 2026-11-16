import { describe, it, expect } from 'bun:test'
import { markdownToPdf, evaluateRenderedPage, looksLikePdf, mdText, pageHtml, buildHeader } from 'reporting/pdf/base.pdf'
import { buildOrderSheetMarkdown } from 'reporting/pdf/order-sheet.pdf'
import { resolveLogo, logoImgTag, bundledLogoDataUri } from 'reporting/pdf/logo'
import type { OrderSheetCtx } from 'reporting/order-sheet.i18n'

/**
 * A printed page obeys nothing a person typed.
 *
 * Two locks, each tested on its own:
 *   • THE PAGE (`lockPage`): whatever markup reaches Chrome, it runs no script and asks nothing
 *     of the network. Measured with a page that tries every way, against a listener that counts.
 *   • THE BUILDERS: text typed into a document is printed as text. Held on the markdown-built
 *     sheets through the page the markdown becomes, and on the letterhead, whose stored field
 *     goes into an attribute.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const RENDER_TIMEOUT = 120_000

/** A 1x1 PNG, inline: what a form's letterhead looks like to the page. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** One page that tries to run script and to reach `base` in every way markup has. */
function hostilePage(base: string): string {
  const u = (path: string) => `${base}/${path}`
  return [
    '<p id="mark">untouched</p>',
    `<script>document.getElementById('mark').textContent = 'a script ran'</script>`,
    `<script src="${u('script')}"></script>`,
    `<img src="${u('image')}">`,
    `<img src="${u('handler')}" onerror="document.getElementById('mark').textContent = 'a handler ran'">`,
    `<img id="inline" src="${PIXEL}">`,
    `<iframe src="${u('frame')}"></iframe>`,
    `<iframe src="data:text/html,<img src='${u('data-frame')}'>"></iframe>`,
    `<link rel="stylesheet" href="${u('stylesheet')}">`,
    `<link rel="prefetch" href="${u('prefetch')}">`,
    `<link rel="preload" as="image" href="${u('preload')}">`,
    `<div style="background: url(${u('background')})">x</div>`,
    `<style>@import url("${u('import')}"); @font-face { font-family: lure; src: url("${u('font')}"); } p { font-family: lure; }</style>`,
    `<video src="${u('video')}"></video>`,
    `<object data="${u('object')}"></object>`,
    `<embed src="${u('embed')}">`,
    `<svg width="1" height="1"><image href="${u('svg-image')}" width="1" height="1"/></svg>`,
    `<meta http-equiv="refresh" content="0;url=${u('refresh')}">`,
  ].join('\n')
}

describe('a page being printed runs no script and fetches nothing', () => {
  it('whatever its markup asks for: nothing runs, nothing is requested, it stays the page it was', async () => {
    const asked: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => { asked.push(new URL(req.url).pathname); return new Response('x') },
    })
    try {
      const page = hostilePage(`http://127.0.0.1:${server.port}`)
      // Read after the time a `refresh` of 0 seconds needs, so a page that left is seen to have left.
      // ⚠ Waited out on an animation: a page that runs no script fires no timer either.
      const seen = await evaluateRenderedPage<{ mark: string | null; inlineWidth: number | null; at: string }>(
        page,
        undefined,
        `(async () => {
          await document.documentElement.animate([], 1500).finished
          return {
            mark: document.getElementById('mark') ? document.getElementById('mark').textContent : null,
            inlineWidth: document.getElementById('inline') ? document.getElementById('inline').naturalWidth : null,
            at: location.href,
          }
        })()`,
      )
      expect(seen).toEqual({ mark: 'untouched', inlineWidth: 1, at: 'about:blank' })
      const pdf = await markdownToPdf(page)
      expect(looksLikePdf(pdf)).toBe(true)
      expect(asked).toEqual([])
    } finally {
      server.stop(true)
    }
  }, RENDER_TIMEOUT)
})

// ── The builders ────────────────────────────────────────────────────────────

/**
 * Text that is markup, markdown and a table bar at once.
 * ⚠ No scheme in its addresses: the parser links a bare `http://…` wherever it stands, which is
 * not the text being obeyed and would only blur what is asserted here.
 */
const TYPED = `<img src="//127.0.0.1:9/a" onerror="x()"><script>x()</script> ![i](//127.0.0.1:9/b) [l](//127.0.0.1:9/c) *e* _e_ \`c\` a|b`

/** What the page holds once the markdown is HTML: which elements, and its text as a reader sees it. */
async function pageOf(markdown: string): Promise<{ html: string; elements: string[] }> {
  const html = await pageHtml(markdown)
  const body = html.slice(html.indexOf('<body'))
  const elements = [...new Set([...body.matchAll(/<([a-z][a-z0-9]*)[\s>]/gi)].map(m => m[1]!.toLowerCase()))].sort()
  return { html: body, elements }
}

describe('text typed into a document is printed as text', () => {
  it('mdText: markup is shown, markdown is not read, a bar ends no cell, a line break is a line break', () => {
    expect(mdText('<b>x</b> & y')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(mdText('a|b *c* _d_ `e` [f](g) ~h~ \\i')).toBe('a\\|b \\*c\\* \\_d\\_ \\`e\\` \\[f\\](g) \\~h\\~ \\\\i')
    expect(mdText('  one \r\n two\n\nthree  ')).toBe('one<br>two<br>three')
    expect(mdText(undefined)).toBe('')
    expect(mdText(12.5)).toBe('12.5')
    // What ordinary names look like is left alone.
    expect(mdText('DIN 933 - М8Х25 (Zn) 8.8 №5 "А" + 1/2')).toBe('DIN 933 - М8Х25 (Zn) 8.8 №5 "А" + 1/2')
  })

  it('mdText: through the markdown parser the text comes out as it went in', async () => {
    const { html, elements } = await pageOf(`| a | b |\n|---|---|\n| ${mdText(TYPED)} | second cell |\n`)
    // The table the builder wrote, and nothing the text asked for.
    expect(elements).toEqual(['body', 'table', 'tbody', 'td', 'th', 'thead', 'tr'])
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt;')
    expect(html).toContain('![i](//127.0.0.1:9/b) [l](//127.0.0.1:9/c) *e* _e_ `c` a|b')
    expect(html).toContain('<td>second cell</td>')
  })

  const ctx = (over: Partial<OrderSheetCtx> = {}): OrderSheetCtx => ({
    locale: 'en',
    order: { orderNumber: `ORDO-1 ${TYPED}`, issueDate: '2026-11-16', notes: `first line\n${TYPED}`, terms: TYPED },
    org: { name: `Buyer ${TYPED}`, taxNumber: TYPED, vatNumber: TYPED, email: TYPED, phone: TYPED },
    group: {
      reference: TYPED,
      lines: [
        { description: `Bolt ${TYPED}`, sku: TYPED, unit: TYPED, quantity: 3, allocations: [{ _id: 'a1', warehouseId: 'w1', quantity: 3, receivedQuantity: 0 }] },
        { productId: 'p1', quantity: 2 },
      ],
    },
    supplierName: `Supplier ${TYPED}`,
    supplierTaxId: TYPED,
    productInfo: { p1: { name: `Nut ${TYPED}`, sku: TYPED, unit: TYPED } },
    warehouseNames: { w1: `Main ${TYPED}` },
    contactNames: { c1: `Client ${TYPED}` },
    reservations: { a1: [{ contactId: 'c1', quantity: 1 }] },
    ...over,
  } as any)

  for (const variant of ['supplier', 'internal'] as const) {
    it(`the ${variant} order sheet holds only what the sheet itself wrote, whatever was typed`, async () => {
      const { html, elements } = await pageOf(buildOrderSheetMarkdown(ctx(), variant))
      expect(elements.filter(e => ['script', 'img', 'iframe', 'a', 'code', 'del', 'link', 'style', 'object'].includes(e))).toEqual([])
      // Emphasis is the sheet's own (its labels, its hint), never the text's: the typed `*e*` stays typed.
      expect(html).toContain('*e* _e_ `c` a|b')
      expect(html).not.toContain('<em>e</em>')
      expect(html).toContain('&lt;script&gt;x()&lt;/script&gt;')
      // A note keeps its line break.
      expect(html).toContain('first line<br>')
    })
  }

  it('the plain header of the markdown documents prints the organization as typed', async () => {
    const { html, elements } = await pageOf(buildHeader('Balance Sheet', `Org ${TYPED}`, TYPED))
    expect(elements.filter(e => ['script', 'img', 'a', 'em', 'code'].includes(e))).toEqual([])
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt;')
  })
})

describe('the letterhead is an inline image or the bundled one', () => {
  const bundled = bundledLogoDataUri()

  it('an inline PNG, JPEG or WebP is the organization\'s own', () => {
    expect(resolveLogo(PIXEL)).toBe(PIXEL)
    expect(resolveLogo('data:image/jpeg;base64,/9j/4AAQ')).toBe('data:image/jpeg;base64,/9j/4AAQ')
    expect(resolveLogo('  data:image/webp;base64,UklGRg==  ')).toBe('data:image/webp;base64,UklGRg==')
  })

  it('anything else is not: an address, a path, another kind of data, text that leaves the attribute', () => {
    for (const stored of [
      'https://cdn.example.com/acme.png',
      'http://127.0.0.1:9/logo.png',
      '/api/org/64f000000000000000000001/logo?v=deadbeefdeadbeef',
      'uploads/acme.png',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=',
      'data:image/png;base64,AAAA" onerror="x()',
      'data:image/png;base64,AAAA"><script>x()</script>',
      'data:image/png,AAAA',
      '',
      null,
    ]) {
      expect([stored, resolveLogo(stored)]).toEqual([stored, bundled])
    }
  })

  it('the tag carries the resolved image and nothing of the stored text', () => {
    const tag = logoImgTag('data:image/png;base64,AAAA" onerror="x()')
    expect(tag).toBe(bundled ? `<img class="org-logo" src="${bundled}" alt="" />` : '')
    expect(tag).not.toContain('onerror')
  })
})
