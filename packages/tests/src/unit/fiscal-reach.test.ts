import { describe, it, expect, afterEach } from 'bun:test'
import { tracked, fiscalInFlight } from 'fiscal/in-flight'
import { noteAnswered, reachedWithin, setReachWriterForTests, REACH_WINDOW_MS } from 'fiscal/device-reach'

/**
 * FR-20.49 (P1-10b) — Прил. 29 т. 8's two hours, and the time the rule reads.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

afterEach(() => setReachWriterForTests(null))

function recorder() {
  const writes: Array<{ id: string; at: number }> = []
  setReachWriterForTests(async (id, at) => { writes.push({ id, at: at.getTime() }) })
  return writes
}

describe('the two-hour window', () => {
  const now = Date.parse('2026-10-25T12:00:00Z')
  it('counts a device reached within two hours, and nothing else', () => {
    expect(reachedWithin(new Date(now - 60_000), now)).toBe(true)
    expect(reachedWithin(new Date(now - REACH_WINDOW_MS), now)).toBe(true)
    expect(reachedWithin(new Date(now - REACH_WINDOW_MS - 1), now)).toBe(false)
    expect(reachedWithin(new Date(now - REACH_WINDOW_MS).toISOString(), now)).toBe(true)
    // Never reached is not reached.
    for (const never of [undefined, null, '', 'not a date']) expect(reachedWithin(never as any, now)).toBe(false)
  })
})

describe('recording that a device answered', () => {
  it('writes once a minute per device, however many commands it answers', () => {
    const writes = recorder()
    const t = Date.parse('2026-10-25T08:00:00Z')
    noteAnswered('dev-a', 'openFiscalReceipt', undefined, t)
    for (let i = 1; i <= 12; i++) noteAnswered('dev-a', 'printSaleLine', undefined, t + i * 1000)
    noteAnswered('dev-b', 'printSaleLine', undefined, t + 2000)
    noteAnswered('dev-a', 'closeFiscalReceipt', undefined, t + 61_000)
    expect(writes).toEqual([
      { id: 'dev-a', at: t },
      { id: 'dev-b', at: t + 2000 },
      { id: 'dev-a', at: t + 61_000 },
    ])
  })

  it('does not count the transport, nor a status read that says the device is not there', () => {
    const writes = recorder()
    const t = Date.parse('2026-10-25T08:00:00Z')
    noteAnswered('dev-a', 'connect', undefined, t)
    noteAnswered('dev-a', 'disconnect', undefined, t)
    noteAnswered('dev-a', 'getStatus', { connected: false }, t)
    expect(writes).toHaveLength(0)
    noteAnswered('dev-a', 'getStatus', { connected: true }, t)
    expect(writes).toHaveLength(1)
  })
})

describe("the counted printer's answers", () => {
  class Printer {
    async getStatus() { return { connected: true } }
    async printSaleLine() { /* the device took the line */ }
    async closeFiscalReceipt(): Promise<never> { throw new Error('no paper') }
  }

  it('hands every fulfilled command to the callback, and none that failed', async () => {
    const heard: string[] = []
    const p = tracked(new Printer(), (method, result) => heard.push(`${method}:${JSON.stringify(result ?? null)}`))
    await p.getStatus()
    await p.printSaleLine()
    let failed = ''
    try { await p.closeFiscalReceipt() } catch (e: any) { failed = e.message }
    expect(failed).toBe('no paper')
    expect(heard).toEqual(['getStatus:{"connected":true}', 'printSaleLine:null'])
    expect(fiscalInFlight()).toBe(0)
  })

  it('never lets the callback turn a printed receipt into an error', async () => {
    const p = tracked(new Printer(), () => { throw new Error('the database is down') })
    expect(await p.getStatus()).toEqual({ connected: true })
    expect(fiscalInFlight()).toBe(0)
  })
})
