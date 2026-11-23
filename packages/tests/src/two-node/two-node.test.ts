import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { startTwoNodes, uplinkFetch, type TwoNodes } from './harness'

/**
 * Two nodes and the link between them (FR-20 plan Part F.2, step T-1). Runs with `LGR_TWO_NODE=1`
 * (the CI step after the build sets it, with the built package); `bun run test` skips it.
 *
 * What it can prove before the uplink exists (P2): that the two roles differ where FR-20 says they
 * must, and that the path the uplink will take (TLS with the run's CA, through the chaos proxy)
 * carries requests and WebSockets to global and fails the way a shop's link fails. The protocol
 * cells (AC 2-5, 23-41, 47-57) join this harness as their steps land.
 */

const enabled = process.env.LGR_TWO_NODE === '1'
let nodes: TwoNodes

describe.skipIf(!enabled)('a global and a master', () => {
  beforeAll(async () => { nodes = await startTwoNodes() }, 300_000)
  afterAll(async () => { await nodes?.stop() }, 120_000)

  // S-11: both run with NODE_ENV=production, so global serves its API docs only when SWAGGER_ENABLED asks,
  // and here it does not. The master is asked (harness.ts) and serves none anyway: AC 66.
  it('global serves lgrai.app\'s analytics tag and, in production, no API docs; the master neither, even when asked (AC 66, S-11)', async () => {
    const shell = async (url: string) => (await fetch(url)).text()
    const globalShell = await shell(`${nodes.global.url}/`)
    const masterShell = await shell(`${nodes.master.url}/`)
    expect(globalShell).toContain('purestat.ai')
    expect(masterShell).toContain('<div id="app">')
    expect(masterShell).not.toMatch(/(src|href)="(https?:)?\/\//)
    for (const node of [nodes.global, nodes.master]) {
      for (const path of ['/swagger', '/swagger/json']) {
        expect({ node: node.url, path, docs: (await shell(`${node.url}${path}`)).includes('LGR Unified API') })
          .toEqual({ node: node.url, path, docs: false })
      }
    }
  })

  // A till stores `/pos/` as its start path whichever node it is paired with, and a master runs its
  // own copy of the redirect: the shell only opens the path, on that node.
  it("both roles answer the POS app's old address with a relative 302 into Invoicing", async () => {
    for (const node of [nodes.global, nodes.master]) {
      const res = await fetch(`${node.url}/pos/`, { redirect: 'manual' })
      expect({ node: node.url, status: res.status, location: res.headers.get('location') })
        .toEqual({ node: node.url, status: 302, location: '/invoicing/cash-sales/new' })
    }
  })

  it('each node keeps its own data: an org made on global is not on the master', async () => {
    const slug = `two-node-${Date.now()}`
    const reg = await fetch(`${nodes.global.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgName: 'Two Node', orgSlug: slug, email: `${slug}@two-node.invalid`, username: 'owner',
        password: crypto.randomUUID(), firstName: 'Two', lastName: 'Node',
      }),
    })
    expect(reg.status).toBeLessThan(300)
    const { MongoClient } = (await import('db/connection')).mongoose.mongo
    const count = async (uri: string) => {
      const c = await MongoClient.connect(uri)
      try { return await c.db().collection('orgs').countDocuments({ slug }) } finally { await c.close() }
    }
    expect(await count(nodes.global.mongoUri)).toBe(1)
    expect(await count(nodes.master.mongoUri)).toBe(0)
  })

  it('the master\'s side reaches global over TLS, with the run\'s CA, through the chaos proxy', async () => {
    const res = await uplinkFetch(nodes, '/api/health')
    expect(res.status).toBe(200)
    let refused = false
    try { await fetch(`${nodes.uplinkUrl}/api/health`) } catch { refused = true }
    expect(refused).toBe(true) // without the CA
  })

  it('a blackholed uplink times out, and comes back when the blackhole lifts', async () => {
    nodes.chaos.blackhole()
    const name = await uplinkFetch(nodes, '/api/health', { timeoutMs: 800 }).then(() => 'answered', (e: any) => e?.name)
    expect(name).toBe('TimeoutError')
    nodes.chaos.blackhole(false)
    expect((await uplinkFetch(nodes, '/api/health')).status).toBe(200)
  })

  it('a cut uplink closes a WebSocket to global; once it is back a new one opens', async () => {
    const open = () => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${nodes.uplinkUrl.replace('https', 'wss')}/ws/tasks`, { tls: { ca: nodes.ca.ca } } as any)
      ws.onopen = () => resolve(ws)
      ws.onerror = () => reject(new Error('websocket failed'))
      setTimeout(() => reject(new Error('open timed out')), 5_000)
    })
    const ws = await open()
    const closed = new Promise<boolean>(resolve => { ws.onclose = () => resolve(true); setTimeout(() => resolve(false), 5_000) })
    nodes.chaos.down()
    expect(await closed).toBe(true)
    let refused = false
    try { await open() } catch { refused = true }
    expect(refused).toBe(true)
    nodes.chaos.up()
    const again = await open()
    expect(again.readyState).toBe(WebSocket.OPEN)
    again.close()
  })
})
