import { describe, it, expect, afterAll } from 'bun:test'
import { config } from 'config'
import { closePdfBrowser, looksLikePdf, markdownToPdf, onRenderedPage, pdfBrowserLaunches, pdfRendersPeak } from 'reporting/pdf/base.pdf'

/**
 * FR-30 slice F (#795): PDFs.
 *
 * FR-30.19: after a process's first PDF, a render starts no browser (launches counted over ten renders); two renders
 * never share a browser context; a browser killed mid-render fails its renders into the retry, which starts another.
 * FR-30.20: at most two renders run at once; ten asked for at once all arrive.
 *
 * The renderer's own guards keep their tests (`pdf-render-deadline`, `pdf-page-lock`, `pdf-renderer`), unmodified.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

afterAll(async () => { await closePdfBrowser() })

describe('FR-30.19: one browser per process', () => {
  it('ten renders start one browser at most', async () => {
    expect(looksLikePdf(await markdownToPdf('# First'))).toBe(true)
    const before = pdfBrowserLaunches()
    for (let i = 0; i < 10; i++) expect(looksLikePdf(await markdownToPdf(`# Document ${i}`))).toBe(true)
    expect(pdfBrowserLaunches() - before).toBe(0)
  }, 180_000)

  it('two renders at once never share a browser context, and neither is the default one', async () => {
    const seen: any[] = []
    const hold = (page: any) => new Promise<any>((resolve) => {
      seen.push(page.browserContext())
      setTimeout(() => resolve(page.browserContext()), 500)
    })
    const [a, b] = await Promise.all([onRenderedPage('# A', undefined, hold), onRenderedPage('# B', undefined, hold)])
    expect(a).not.toBe(b)
    const browser = a.browser()
    expect(a).not.toBe(browser.defaultBrowserContext())
    expect(b).not.toBe(browser.defaultBrowserContext())
    // Each context is closed once its render is done.
    expect(browser.browserContexts().filter((c: any) => c === a || c === b)).toHaveLength(0)
  }, 60_000)

  it('a browser killed mid-render: the renders on it go to the retry, which starts another', async () => {
    const before = pdfBrowserLaunches()
    let killed = false
    const killer = onRenderedPage('# Killer', undefined, async (page) => {
      await new Promise((r) => setTimeout(r, 200))
      page.browser().process()?.kill('SIGKILL')
      killed = true
      throw new Error('its browser is gone')
    }).catch(() => 'failed')
    const printed = markdownToPdf('# Printed through the kill')
    expect(await killer).toBe('failed')
    expect(killed).toBe(true)
    expect(looksLikePdf(await printed)).toBe(true)
    expect(pdfBrowserLaunches() - before).toBeGreaterThanOrEqual(1)
  }, 120_000)
})

describe('FR-30.20: a limit on renders at once', () => {
  it('ten PDFs asked for at once all arrive, never more than two rendering together', async () => {
    expect(config.pdf.concurrency).toBe(2)
    const pdfs = await Promise.all(Array.from({ length: 10 }, (_, i) => markdownToPdf(`# At once ${i}\n\n${'Ред. '.repeat(200)}`)))
    expect(pdfs.every((p) => looksLikePdf(p))).toBe(true)
    expect(pdfRendersPeak()).toBeLessThanOrEqual(2)
    expect(pdfRendersPeak()).toBe(2)
  }, 180_000)

  it('a render that waits for its turn waits inside its deadline', async () => {
    const was = config.pdf.renderTimeoutMs
    ;(config.pdf as any).renderTimeoutMs = 2_000
    try {
      const hold = () => new Promise<string>((r) => setTimeout(() => r('held'), 1_500))
      const busy = [onRenderedPage('# 1', undefined, hold), onRenderedPage('# 2', undefined, hold)]
      // The third waits for a slot; its deadline counts from when it was asked for.
      const started = Date.now()
      let error = ''
      try { await onRenderedPage('# 3', undefined, () => new Promise((r) => setTimeout(r, 1_500))) } catch (e: any) { error = String(e?.message) }
      expect(error).toContain('did not finish within 2000 ms')
      expect(Date.now() - started).toBeLessThan(2_000 + 1_000)
      await Promise.allSettled(busy)
    } finally {
      ;(config.pdf as any).renderTimeoutMs = was
    }
  }, 60_000)
})
