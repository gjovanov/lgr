import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestCa, tlsFront, type TestCa, type TlsFront } from '../two-node/tls-front'
import { chaosProxy, type ChaosProxy } from '../two-node/chaos-proxy'

/**
 * The two-node harness's TLS front (FR-20 plan Part F.2, step T-1): HTTPS and WSS with the
 * certificate checked, through the chaos proxy as the uplink will go, and refused to a client that
 * does not trust the run's CA.
 */

const dir = mkdtempSync(join(tmpdir(), 'lgr-tls-'))
let ca: TestCa
let upstream: ReturnType<typeof Bun.serve>
let front: TlsFront
let chaos: ChaosProxy

beforeAll(async () => {
  ca = makeTestCa(dir)
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return Response.json({ path: new URL(req.url).pathname, proto: req.headers.get('x-forwarded-proto') })
    },
    websocket: { message(ws, m) { ws.send(`echo:${m}`) } },
  })
  front = tlsFront({ hostname: '127.0.0.1', port: upstream.port }, ca)
  // As the uplink goes: client → chaos proxy (raw TCP, carrying TLS) → front → the API.
  chaos = await chaosProxy({ hostname: '127.0.0.1', port: front.port })
})

afterAll(async () => {
  await chaos.close()
  front.close()
  upstream.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('the TLS front', () => {
  it('answers HTTPS with a certificate the run\'s CA signed, through the chaos proxy', async () => {
    const res = await fetch(`https://localhost:${chaos.port}/api/health`, { tls: { ca: ca.ca } } as any)
    expect(await res.json()).toEqual({ path: '/api/health', proto: 'https' })
  })

  it('refuses a client that does not trust the CA', async () => {
    let failed = false
    try { await fetch(`https://localhost:${chaos.port}/`) } catch { failed = true }
    expect(failed).toBe(true)
  })

  it('carries a WebSocket as WSS, both ways', async () => {
    const ws = new WebSocket(`wss://localhost:${chaos.port}/ws/node`, { tls: { ca: ca.ca } } as any)
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send('hello')
      ws.onmessage = e => resolve(String(e.data))
      ws.onerror = () => reject(new Error('websocket failed'))
      setTimeout(() => reject(new Error('timeout')), 5_000)
    })
    expect(reply).toBe('echo:hello')
    ws.close()
  })

  it('loses the WebSocket when the chaos proxy drops the link', async () => {
    const ws = new WebSocket(`wss://localhost:${chaos.port}/ws/node`, { tls: { ca: ca.ca } } as any)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('open failed')) })
    const closed = new Promise<boolean>(resolve => { ws.onclose = () => resolve(true); setTimeout(() => resolve(false), 5_000) })
    chaos.drop()
    expect(await closed).toBe(true)
  })
})
