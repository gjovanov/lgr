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

  it('global serves lgrai.app\'s analytics tag and its API docs; the master neither (AC 66)', async () => {
    const shell = async (url: string) => (await fetch(url)).text()
    const globalShell = await shell(`${nodes.global.url}/`)
    const masterShell = await shell(`${nodes.master.url}/`)
    expect(globalShell).toContain('purestat.ai')
    expect(masterShell).toContain('<div id="app">')
    expect(masterShell).not.toMatch(/(src|href)="(https?:)?\/\//)
    expect(await shell(`${nodes.global.url}/swagger`)).toContain('LGR Unified API')
    expect(await shell(`${nodes.master.url}/swagger`)).not.toContain('LGR Unified API')
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
