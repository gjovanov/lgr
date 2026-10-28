import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { EmailLog, Org, Outbox, RelayReceipt, ServerNode } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { sendEmail } from 'services/biz/email.service'
import { drainOne, giveUp } from 'services/biz/relay/outbox-worker'
import { sendDigestTo } from 'services/biz/digest/digest-runner.service'

/**
 * Mail a master queues, and global sends on its behalf (FR-20.59, FR-20.86, plan step P2-6).
 *
 * Global relays only for a server the org's admin turned it on for (off by default at Control),
 * from its own sender, to one recipient, within size and rate caps, and at most once per outbox
 * id. A master queues every mail with an honest `queued`, drains its outbox through the relay, and
 * keeps what cannot go yet.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const realFetch = globalThis.fetch
const saved = {
  key: config.email.sendgridApiKey, perHour: config.relay.mailPerHour,
  role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile,
}
let tmp = ''

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  globalThis.fetch = realFetch
  ;(config.email as any).sendgridApiKey = saved.key
  ;(config.relay as any).mailPerHour = saved.perHour
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  forgetAllHomes()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
const bearer = async (user: any, orgId: string) => (await jwt()).sign({ id: String(user._id), email: user.email, username: user.username, role: user.role, orgId, permissions: [] })
const call = (app: any, method: string, path: string, token?: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}))

/** SendGrid, faked: every request is kept, and answered `status`. */
function fakeSendGrid(status = 202) {
  const sent: any[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).startsWith('https://api.sendgrid.com/')) {
      sent.push(JSON.parse(init.body))
      return new Response(status < 300 ? '' : 'provider down', { status })
    }
    return realFetch(url, init)
  }) as any
  return sent
}

async function aLinkedOrg() {
  const org = await createTestOrg()
  await Org.updateOne({ _id: org._id }, { $set: { email: 'office@acme.test' } })
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const nodeToken = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  return { orgId: String(org._id), nodeId: stub.nodeId, admin: await bearer(admin, String(org._id)), nodeToken, app: new Elysia().use(createApiApp()) }
}

const mail = (orgId: string, outboxId: string, over: Record<string, unknown> = {}) => ({
  outboxId, orgId, to: 'customer@buyer.test', subject: 'Invoice 1', html: '<p>Hello</p>',
  attachments: [{ filename: 'invoice.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.7').toString('base64') }],
  ...over,
})

describe("global sends a master's mail", () => {
  it('only once the org turns it on (off by default at Control), from its own sender, once per outbox id', async () => {
    ;(config.email as any).sendgridApiKey = 'SG.test-key'
    const sent = fakeSendGrid()
    const g = await aLinkedOrg()
    const relay = (body: any, token: string | undefined = g.nodeToken) => call(g.app, 'POST', '/api/node/v1/relay/mail', token, body)

    expect((await relay(mail(g.orgId, 'mail:1'), '')).status).toBe(401)
    const off = await relay(mail(g.orgId, 'mail:1'))
    expect(off.status).toBe(403)
    expect((await off.json()).code).toBe('relay_disabled')

    // The org's admin turns it on for this server, on lgrai.app's Servers page.
    const put = await call(g.app, 'PUT', `/api/org/${g.orgId}/nodes/${g.nodeId}/relays`, g.admin, { mail: true })
    expect(put.status).toBe(200)
    expect((await put.json()).node.relays).toEqual({ mail: true, mailChosen: true, documents: false, documentsChosen: false })

    const ok = await relay(mail(g.orgId, 'mail:1'))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ state: 'sent' })
    expect(sent).toHaveLength(1)
    expect(sent[0].from).toEqual({ email: config.email.fromEmail })
    expect(sent[0].reply_to).toEqual({ email: 'office@acme.test' })
    expect(sent[0].personalizations[0].to).toEqual([{ email: 'customer@buyer.test' }])
    expect(sent[0].attachments[0].filename).toBe('invoice.pdf')

    // The retry of an item whose answer was lost sends nothing.
    expect(await (await relay(mail(g.orgId, 'mail:1'))).json()).toEqual({ state: 'sent', deduped: true })
    expect(sent).toHaveLength(1)
    expect(await RelayReceipt.countDocuments({ nodeId: g.nodeId, state: 'sent' })).toBe(1)

    // Turned off again: refused.
    await call(g.app, 'PUT', `/api/org/${g.orgId}/nodes/${g.nodeId}/relays`, g.admin, { mail: false })
    expect((await relay(mail(g.orgId, 'mail:2'))).status).toBe(403)
  })

  it('refuses another org, a second recipient, too much, and more than the hour allows', async () => {
    ;(config.email as any).sendgridApiKey = 'SG.test-key'
    const sent = fakeSendGrid()
    const g = await aLinkedOrg()
    await ServerNode.updateOne({ _id: g.nodeId }, { $set: { linkLevel: 'full' } }) // on by default at Full
    const relay = (body: any) => call(g.app, 'POST', '/api/node/v1/relay/mail', g.nodeToken, body)
    const code = async (r: Response) => (await r.json()).code

    expect(await code(await relay(mail('0123456789abcdef01234567', 'm:1')))).toBe('org_not_on_node')
    expect(await code(await relay(mail(g.orgId, 'm:2', { to: 'a@x.test, b@y.test' })))).toBe('bad_recipient')
    const big = Buffer.alloc(config.relay.maxAttachmentBytes + 1).toString('base64')
    const tooBig = await relay(mail(g.orgId, 'm:3', { attachments: [{ filename: 'big.bin', content: big }] }))
    expect(tooBig.status).toBe(413)
    expect(sent).toHaveLength(0)

    ;(config.relay as any).mailPerHour = 1
    expect((await relay(mail(g.orgId, 'm:4'))).status).toBe(200)
    const limited = await relay(mail(g.orgId, 'm:5'))
    expect(limited.status).toBe(429)
    expect((await limited.json()).retryAfterSecs).toBe(3600)
    expect(sent).toHaveLength(1)
  })

  it('a provider failure keeps no receipt, so the retry is sent', async () => {
    ;(config.email as any).sendgridApiKey = 'SG.test-key'
    fakeSendGrid(500)
    const g = await aLinkedOrg()
    await ServerNode.updateOne({ _id: g.nodeId }, { $set: { linkLevel: 'full' } })
    const relay = () => call(g.app, 'POST', '/api/node/v1/relay/mail', g.nodeToken, mail(g.orgId, 'mail:9'))
    expect((await relay()).status).toBe(502)
    expect(await RelayReceipt.countDocuments({})).toBe(0)
    const sent = fakeSendGrid(202)
    expect((await relay()).status).toBe(200)
    expect(sent).toHaveLength(1)
  })
})

describe('a master queues its mail and drains it through the relay', () => {
  const NODE = 'master-outboxtestaaaaa'.padEnd(23, 'a')

  async function aMaster() {
    tmp = mkdtempSync(join(tmpdir(), 'lgr-outbox-'))
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    const org = await createTestOrg()
    await homeNewOrg(String(org._id))
    const user = await createTestUser(org._id, { role: 'admin', email: 'owner@acme.test' } as any)
    return { orgId: String(org._id), userId: String(user._id) }
  }
  function token(expiresInSecs = 600) {
    const file = join(tmp, 'node-token.json')
    writeFileSync(file, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + expiresInSecs }))
    ;(config.outbox as any).tokenFile = file
  }
  /** Global, faked: keeps what it was sent and answers `answer`. */
  function fakeGlobal(answer: { status: number; body: unknown } | 'down') {
    const asked: any[] = []
    const impl = (async (url: any, init: any) => {
      asked.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) })
      if (answer === 'down') throw new Error('connect ECONNREFUSED')
      return Response.json(answer.body, { status: answer.status })
    }) as any
    return { asked, impl }
  }

  it('queues, honestly, and once per deterministic id', async () => {
    const m = await aMaster()
    const r = await sendEmail({ to: 'customer@buyer.test', subject: 'Invoice 1', html: '<p>Hi</p>', orgId: m.orgId, entityType: 'invoice', attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF') }] })
    expect(r).toEqual({ ok: true, queued: true })
    const item: any = await Outbox.findOne({ orgId: m.orgId }).lean()
    expect(item.state).toBe('queued')
    expect(item.payload.attachments[0].content).toBe(Buffer.from('%PDF').toString('base64'))
    const log: any = await EmailLog.findOne({ outboxId: item._id }).lean()
    expect(log.status).toBe('queued')

    // The day's digest has one id per recipient: a re-run queues nothing twice.
    for (let i = 0; i < 2; i++) {
      const outcome = await sendDigestTo(m.orgId, '2026-10-24', [{ userId: m.userId, email: 'owner@acme.test' }])
      expect(outcome.status).toBe('queued')
    }
    expect(await Outbox.countDocuments({ _id: `digest:${m.orgId}:2026-10-24:${m.userId}` })).toBe(1)
  })

  it('sends with the supervisor token, and keeps what cannot go yet', async () => {
    const m = await aMaster()
    await sendEmail({ to: 'customer@buyer.test', subject: 'Invoice 1', html: '<p>Hi</p>', orgId: m.orgId })
    const id = String(((await Outbox.findOne({}).lean()) as any)._id)

    // No token yet (not registered): nothing is taken.
    expect(await drainOne()).toBe('no_token')
    token(8000) // outlives the simulated hour below

    // lgrai.app down: kept, a minute later.
    const down = fakeGlobal('down')
    expect(await drainOne(new Date(), down.impl)).toBe('retry')
    let item: any = await Outbox.findById(id).lean()
    expect(item.state).toBe('queued')
    expect(item.nextAt.getTime()).toBeGreaterThan(Date.now() + 50_000)

    // Mail is off for this server: kept, tried hourly, and the reason is visible.
    const off = fakeGlobal({ status: 403, body: { code: 'relay_disabled', message: 'off' } })
    expect(await drainOne(new Date(Date.now() + 120_000), off.impl)).toBe('retry')
    item = await Outbox.findById(id).lean()
    expect(item.lastError).toContain('relay_disabled')
    expect(item.nextAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000)

    // Sent: the contract global reads, and the log turns `sent`.
    const ok = fakeGlobal({ status: 200, body: { state: 'sent' } })
    expect(await drainOne(new Date(Date.now() + 4_000_000), ok.impl)).toBe('sent')
    expect(ok.asked[0].url).toBe('https://lgrai.test/api/node/v1/relay/mail')
    expect(ok.asked[0].auth).toBe('Bearer node-token')
    expect(ok.asked[0].body).toMatchObject({ outboxId: id, orgId: m.orgId, to: 'customer@buyer.test', subject: 'Invoice 1', html: '<p>Hi</p>' })
    item = await Outbox.findById(id).lean()
    expect(item.state).toBe('sent')
    expect(item.payload.html).toBeUndefined() // the body and the bytes go once it is done
    expect(((await EmailLog.findOne({ outboxId: id }).lean()) as any).status).toBe('sent')
  })

  it('a mail global refuses for good fails, and so does one 7 days old', async () => {
    const m = await aMaster()
    token()
    await sendEmail({ to: 'customer@buyer.test', subject: 'Big', html: '<p>Hi</p>', orgId: m.orgId })
    const refused = fakeGlobal({ status: 413, body: { code: 'too_large', message: 'too big' } })
    expect(await drainOne(new Date(), refused.impl)).toBe('failed')
    expect(((await EmailLog.findOne({ subject: 'Big' }).lean()) as any)).toMatchObject({ status: 'failed', error: expect.stringContaining('too_large') })

    await sendEmail({ to: 'customer@buyer.test', subject: 'Old', html: '<p>Hi</p>', orgId: m.orgId })
    const old: any = await Outbox.findOne({ 'payload.subject': 'Old' }).lean()
    await Outbox.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 8 * 86_400_000) } })
    expect(await giveUp()).toBe(1)
    expect(((await Outbox.findById(old._id).lean()) as any).state).toBe('failed')
    expect(((await EmailLog.findOne({ subject: 'Old' }).lean()) as any).status).toBe('failed')
  })
})
