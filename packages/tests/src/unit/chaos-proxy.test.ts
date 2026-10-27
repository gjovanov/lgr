import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { chaosProxy, type ChaosProxy } from '../two-node/chaos-proxy'

/**
 * The two-node harness's chaos proxy (FR-20 plan Part F.2, step T-1), against a real HTTP server:
 * each verb does what a failing uplink does, and lifting it restores the link. The harness's cells
 * lean on these, so the proxy is tested on its own first.
 */

const BODY = 'x'.repeat(50_000)
let upstream: ReturnType<typeof Bun.serve>
let proxy: ChaosProxy
const url = () => `http://127.0.0.1:${proxy.port}/`

/** The status, or the error's name when the request did not complete. */
async function get(timeoutMs = 2_000): Promise<number | string> {
  try {
    const res = await fetch(url(), { signal: AbortSignal.timeout(timeoutMs), keepalive: false })
    await res.text()
    return res.status
  } catch (e: any) {
    return e?.name ?? 'Error'
  }
}

beforeAll(async () => {
  upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(BODY) })
  proxy = await chaosProxy({ hostname: '127.0.0.1', port: upstream.port })
})
afterAll(async () => {
  await proxy.close()
  upstream.stop(true)
})

describe('the chaos proxy', () => {
  it('forwards, both ways, byte for byte', async () => {
    const res = await fetch(url())
    expect(await res.text()).toBe(BODY)
    expect(proxy.stats().bytesDown).toBeGreaterThanOrEqual(BODY.length)
  })

  it('delay(ms) holds every chunk, each way', async () => {
    proxy.delay(250)
    const t0 = performance.now()
    expect(await get()).toBe(200)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(480)
    proxy.delay(0)
  })

  it('throttle(Bps) makes it a slow link, and null lifts it', async () => {
    proxy.throttle(100_000)
    const t0 = performance.now()
    expect(await get(5_000)).toBe(200)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(400)
    proxy.throttle(null)
    const t1 = performance.now()
    expect(await get()).toBe(200)
    expect(performance.now() - t1).toBeLessThan(400)
  })

  it('uplink(Bps) is ONE line toward the server: a small request waits behind another connection\'s upload', async () => {
    const sink = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => new Response(String((await req.arrayBuffer()).byteLength)) })
    const p = await chaosProxy({ hostname: '127.0.0.1', port: sink.port })
    const at = `http://127.0.0.1:${p.port}/`
    // Unshared, per connection: the small request does not wait for the big one.
    p.throttle(40_000)
    const big0 = fetch(at, { method: 'POST', body: new Uint8Array(80_000), keepalive: false })
    await Bun.sleep(50)
    const t0 = performance.now()
    expect(await (await fetch(at, { method: 'POST', body: 'tiny', keepalive: false })).text()).toBe('4')
    const alone = performance.now() - t0
    await big0
    p.throttle(null)
    // Shared: 80 KB at 40 KB/s is two seconds of queue in front of it.
    p.uplink(40_000)
    const big = fetch(at, { method: 'POST', body: new Uint8Array(80_000), keepalive: false })
    await Bun.sleep(50)
    expect(p.queuedMs()).toBeGreaterThan(1_500)
    const t1 = performance.now()
    expect(await (await fetch(at, { method: 'POST', body: 'tiny', keepalive: false })).text()).toBe('4')
    const behind = performance.now() - t1
    expect(await (await big).text()).toBe('80000')
    expect(alone).toBeLessThan(1_000)
    expect(behind).toBeGreaterThan(1_500)
    p.uplink(null)
    expect(p.queuedMs()).toBe(0)
    await p.close()
    sink.stop(true)
  }, 15_000)

  it('blackhole() accepts and never answers; lifting it brings the link back', async () => {
    proxy.blackhole()
    expect(await get(500)).toBe('TimeoutError')
    proxy.blackhole(false)
    expect(await get()).toBe(200)
  })

  it('down() refuses new connections and up() restores them', async () => {
    const before = proxy.stats().refused
    proxy.down()
    expect(await get()).not.toBe(200)
    expect(proxy.stats().refused).toBeGreaterThan(before)
    proxy.up()
    expect(await get()).toBe(200)
  })

  it('drop() closes a connection in the middle of an answer', async () => {
    const slow = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode('first'))
          await Bun.sleep(1_000)
          c.enqueue(new TextEncoder().encode('second'))
          c.close()
        },
      })),
    })
    const p = await chaosProxy({ hostname: '127.0.0.1', port: slow.port })
    const res = await fetch(`http://127.0.0.1:${p.port}/`)
    setTimeout(() => p.drop(), 200)
    let failed = false
    try { await res.text() } catch { failed = true }
    expect(failed).toBe(true)
    await p.close()
    slow.stop(true)
  })

  it('flapAt([down, up]) cuts the link and restores it on schedule', async () => {
    proxy.flapAt([100, 600])
    await Bun.sleep(200)
    expect(await get(300)).not.toBe(200)
    await Bun.sleep(600)
    expect(await get()).toBe(200)
  })
})
