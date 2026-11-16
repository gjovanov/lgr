import { describe, it, expect, afterEach } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { config } from 'config'
import { markdownToPdf, evaluateRenderedPage, looksLikePdf } from 'reporting/pdf/base.pdf'

/**
 * A render that stalls is abandoned at the deadline (`config.pdf.renderTimeoutMs`), its Chrome
 * does not outlive it, and the next render still prints.
 *
 * The stall is made, not waited for. It used to be an image from a local server that accepts the
 * request and never answers; a printed page asks nothing of the network any more
 * (`pdf-page-lock.test.ts`), so the stall is a promise the page never settles, awaited through
 * the same `withRenderedPage` every render goes through.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const was = config.pdf.renderTimeoutMs
afterEach(() => { (config.pdf as any).renderTimeoutMs = was })

/** Chrome processes this process started and that are still alive. Linux only (where CI runs). */
function ownChromes(): number {
  if (process.platform !== 'linux') return 0
  let n = 0
  for (const pid of readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      // A zombie has an empty cmdline, so a killed-but-unreaped Chrome is not counted.
      if (ppid === process.pid && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('chrome')) n++
    } catch { /* exited meanwhile */ }
  }
  return n
}

describe('a stalled render', () => {
  it('is abandoned at the deadline, leaves no Chrome behind, and the next render prints', async () => {
    ;(config.pdf as any).renderTimeoutMs = 3_000
    const started = Date.now()
    let error: unknown
    try {
      await evaluateRenderedPage('<p>Stalls</p>', undefined, 'new Promise(() => {})')
    } catch (e) {
      error = e
    }
    expect(String((error as any)?.message)).toContain('did not finish within 3000 ms')
    // One attempt: the launch, the deadline, and at most the close.
    expect(Date.now() - started).toBeLessThan(3_000 + 5_000 + 10_000)
    expect(ownChromes()).toBe(0)

    ;(config.pdf as any).renderTimeoutMs = was
    expect(looksLikePdf(await markdownToPdf('# Still prints'))).toBe(true)
  }, 120_000)
})
