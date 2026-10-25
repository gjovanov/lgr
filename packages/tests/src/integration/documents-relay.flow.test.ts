import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { randomBytes, randomUUID } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Identity, RelayJob, ServerNode } from 'db/models'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { sessionFor } from 'services/biz/auth.service'
import { OcrError, ocrDraft, ocrExtract } from 'services/biz/doc-import/ocr-client'
import { aiMatchLines } from 'services/biz/doc-import/matching'
import { attachmentCeiling, MAX_ATTACHMENT_BINARY_BYTES } from 'services/biz/backup/backup-runner.service'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * Documents through lgrai.app (FR-20.59, plan step P2-6b). A master's package carries no OCR sidecar
 * and none of the model credentials, so its document import asks lgrai.app to read for it: text out
 * of a PDF, an AI draft, AI line matching. Posted as a job and polled; once the org's admin turned
 * it on for that server; within per-server daily caps; one model run per request.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const realFetch = globalThis.fetch
const saved = {
  role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile,
  ocrUrl: config.ocr.serverUrl, ocrConfigured: config.ocr.configured,
  caps: { ...config.relay.documentsPerDay }, verifyVat: config.companyLookup.verifyVatToken,
}
const calls: Record<string, number> = { extract: 0, draft: 0, 'match-lines': 0 }
let sidecar: ReturnType<typeof Bun.serve>
let tmp = ''

beforeAll(async () => {
  await setupTestDB()
  process.env.OCR_RELAY_POLL_MS = '20'
  // lgrai.app's own sidecar, as the relay reaches it.
  sidecar = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.slice(1)
      calls[path] = (calls[path] ?? 0) + 1
      if (path === 'extract') {
        const file = (await req.formData()).get('file') as File
        return Response.json({ text: `TEXT OF ${file.name} (${file.size} bytes)`, method: 'native', pages: 1 })
      }
      if (path === 'draft') {
        const body: any = await req.json()
        await Bun.sleep(60)
        return Response.json({ extraction: { echo: body.text.slice(0, 12) }, validation: { status: 'ok', checks: [] }, model: 'fake', engine: 'fake', profile: body.profile ?? 'invoice' })
      }
      if (path === 'match-lines') {
        const body: any = await req.json()
        return Response.json({ matches: body.lines.map((_: unknown, i: number) => body.candidates[i % body.candidates.length].id) })
      }
      return new Response('no', { status: 404 })
    },
  })
  ;(config.ocr as any).serverUrl = `http://localhost:${sidecar.port}`
})
afterAll(async () => {
  sidecar.stop(true)
  delete process.env.OCR_RELAY_POLL_MS
  ;(config.ocr as any).serverUrl = saved.ocrUrl
  await teardownTestDB()
})
afterEach(async () => {
  globalThis.fetch = realFetch
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  ;(config.ocr as any).configured = saved.ocrConfigured
  Object.assign(config.relay.documentsPerDay, saved.caps)
  ;(config.companyLookup as any).verifyVatToken = saved.verifyVat
  for (const k of Object.keys(calls)) calls[k] = 0
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
const call = (app: any, method: string, path: string, token?: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}))

async function aServer() {
  const org = await createTestOrg()
  const identity: any = await Identity.create({ email: `admin-${randomBytes(3).toString('hex')}@shop.test`, firstName: 'Ana', lastName: 'Shop' })
  const admin: any = await createTestUser(org._id, { role: 'admin', identityId: identity._id, email: identity.email } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(admin._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const nodeToken = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  const session = await (await jwt()).sign({ ...(await sessionFor(admin, identity)), exp: Math.floor(Date.now() / 1000) + 3600 })
  const app = new Elysia().use(createApiApp())
  const relays = (body: Record<string, boolean>) => call(app, 'PUT', `/api/org/${org._id}/nodes/${stub.nodeId}/relays`, session, body)
  return { orgId: String(org._id), nodeId: stub.nodeId, nodeToken, session, app, relays }
}

/** Post a job and poll it until it is not running. */
async function job(s: Awaited<ReturnType<typeof aServer>>, op: string, input: unknown, requestId = randomUUID()) {
  const posted = await call(s.app, 'POST', '/api/node/v1/relay/documents', s.nodeToken, { requestId, orgId: s.orgId, op, input })
  if (posted.status !== 202) return { status: posted.status, body: await posted.json(), requestId }
  for (let i = 0; i < 100; i++) {
    const r = await (await call(s.app, 'GET', `/api/node/v1/relay/documents/${requestId}`, s.nodeToken)).json()
    if (r.state !== 'running') return { status: 202, body: r, requestId }
    await Bun.sleep(20)
  }
  throw new Error('the job never finished')
}

describe('lgrai.app reads documents for a master', () => {
  it('once its org turned it on, as a job, one model run per request', async () => {
    const s = await aServer()
    expect((await call(s.app, 'POST', '/api/node/v1/relay/documents', undefined, { requestId: randomUUID(), orgId: s.orgId, op: 'draft', input: { text: 'x' } })).status).toBe(401)
    const off = await job(s, 'draft', { text: 'Фактура 1' })
    expect([off.status, off.body.code]).toEqual([403, 'relay_disabled'])

    // The two relays are chosen separately: turning documents on leaves mail at its default.
    const on = await (await s.relays({ documents: true })).json()
    expect(on.node.relays).toEqual({ mail: false, mailChosen: false, documents: true, documentsChosen: true })
    const mail = await (await s.relays({ mail: true })).json()
    expect(mail.node.relays).toMatchObject({ mail: true, documents: true, documentsChosen: true })

    const draft = await job(s, 'draft', { text: 'Фактура 1000001', profile: 'invoice' })
    expect(draft.body).toMatchObject({ state: 'done', result: { extraction: { echo: 'Фактура 1000' }, profile: 'invoice' } })
    // The same request again is the same job: no second model run.
    const again = await call(s.app, 'POST', '/api/node/v1/relay/documents', s.nodeToken, { requestId: draft.requestId, orgId: s.orgId, op: 'draft', input: { text: 'Фактура 1000001' } })
    expect([again.status, (await again.json()).state]).toEqual([202, 'done'])
    expect(calls.draft).toBe(1)

    const extract = await job(s, 'extract', { filename: 'a.pdf', pdfBase64: Buffer.from('%PDF-1.4 fake').toString('base64') })
    expect(extract.body.result).toMatchObject({ text: 'TEXT OF a.pdf (13 bytes)', method: 'native' })
    const match = await job(s, 'match-lines', { lines: ['винт', 'гайка'], candidates: [{ id: 'p1', name: 'Винт' }] })
    expect(match.body.result).toEqual({ matches: ['p1', 'p1'] })
    // Nothing of the input is kept, only the answer.
    const kept: any = await RelayJob.findById(`${s.nodeId}:${draft.requestId}`).lean()
    expect(JSON.stringify(kept)).not.toContain('Фактура 1000001')
  })

  it('refuses another org, too much, a clone, and beyond the daily cap; a lost job runs again', async () => {
    const s = await aServer()
    await s.relays({ documents: true })
    const other = await call(s.app, 'POST', '/api/node/v1/relay/documents', s.nodeToken, { requestId: randomUUID(), orgId: '0123456789abcdef01234567', op: 'draft', input: { text: 'x' } })
    expect([other.status, (await other.json()).code]).toEqual([403, 'org_not_on_node'])
    const big = await job(s, 'draft', { text: 'x'.repeat(config.relay.maxDocumentText + 1) })
    expect([big.status, big.body.code]).toEqual([413, 'too_large'])
    const pdf = await job(s, 'extract', { filename: 'big.pdf', pdfBase64: 'A'.repeat(Math.ceil(config.relay.maxDocumentBytes * 4 / 3) + 8) })
    expect([pdf.status, pdf.body.code]).toEqual([413, 'too_large'])

    config.relay.documentsPerDay.draft = 1
    expect((await job(s, 'draft', { text: 'one' })).body.state).toBe('done')
    const capped = await job(s, 'draft', { text: 'two' })
    expect([capped.status, capped.body.code]).toEqual([429, 'too_many'])

    // A job whose process went (its lease passed while running) is lost; posting it again runs it.
    const requestId = randomUUID()
    await RelayJob.create({ _id: `${s.nodeId}:${requestId}`, nodeId: s.nodeId, orgId: s.orgId, op: 'extract', state: 'running', leaseUntil: new Date(Date.now() - 1000) })
    expect((await (await call(s.app, 'GET', `/api/node/v1/relay/documents/${requestId}`, s.nodeToken)).json()).state).toBe('lost')
    const rerun = await job(s, 'extract', { filename: 'b.pdf', pdfBase64: Buffer.from('%PDF').toString('base64') }, requestId)
    expect(rerun.body.state).toBe('done')

    await ServerNode.updateOne({ _id: s.nodeId }, { $set: { cloneAlarm: { at: new Date(), channel: 'interactive', bootNonces: ['a', 'b'] } } })
    const clone = await job(s, 'extract', { filename: 'c.pdf', pdfBase64: 'JVBERg==' })
    expect([clone.status, clone.body.code]).toEqual([409, 'clone_alarm'])
  })
})

describe('a master', () => {
  /** A linked master in this same process: lgrai.app's answers run as global. */
  async function aMaster() {
    const s = await aServer()
    tmp = mkdtempSync(join(tmpdir(), 'lgr-docs-'))
    const file = join(tmp, 'node-token.json')
    writeFileSync(file, JSON.stringify({ server: 'https://lgrai.test', token: s.nodeToken, expiresAt: Math.floor(Date.now() / 1000) + 600 }))
    ;(config.outbox as any).tokenFile = file
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = s.nodeId
    ;(config.ocr as any).configured = false
    globalThis.fetch = (async (url: any, init: any) => {
      const u = new URL(String(url))
      if (u.host !== 'lgrai.test') return realFetch(url, init)
      ;(config.node as any).role = 'global'
      try {
        return await s.app.handle(new Request(`http://localhost${u.pathname}${u.search}`, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body }))
      } finally {
        ;(config.node as any).role = 'master'
      }
    }) as any
    const asGlobal = async <T>(fn: () => Promise<T>) => {
      ;(config.node as any).role = 'global'
      try {
        return await fn()
      } finally {
        ;(config.node as any).role = 'master'
      }
    }
    return { ...s, asGlobal }
  }

  it('reads its documents through lgrai.app once the org turned it on', async () => {
    const m = await aMaster()
    const off = await captureRejection(ocrDraft('Фактура', 'invoice', { orgId: m.orgId }))
    expect(off).toBeInstanceOf(OcrError)
    expect(off.message).toContain("lgrai.app's Servers page")

    await m.asGlobal(() => m.relays({ documents: true }))
    expect((await ocrDraft('Фактура 2000002', 'invoice', { orgId: m.orgId })).extraction).toEqual({ echo: 'Фактура 2000' })
    expect(await ocrExtract(Buffer.from('%PDF-1.4 x'), 'd.pdf', { orgId: m.orgId })).toMatchObject({ text: 'TEXT OF d.pdf (10 bytes)' })
    expect(await aiMatchLines(['a', 'b'], [{ id: 'p9', name: 'P9' }], { orgId: m.orgId })).toEqual(['p9', 'p9'])

    // Without the org, or without lgrai.app, it says so.
    expect((await captureRejection(ocrDraft('x')))?.message).toContain('needs the organization')
    rmSync(config.outbox.tokenFile)
    expect((await captureRejection(ocrDraft('x', undefined, { orgId: m.orgId })))?.message).toContain('cannot reach lgrai.app')
    // Line matching stays failure-tolerant: nothing matched rather than an error.
    expect(await aiMatchLines(['a'], [{ id: 'p9', name: 'P9' }], { orgId: m.orgId })).toEqual([null])
  })
})

describe('small things a master needs', () => {
  it('an EU VAT lookup that cannot run says so, not "Company not found"', async () => {
    const s = await aServer()
    ;(config.companyLookup as any).verifyVatToken = ''
    const r = await call(s.app, 'GET', `/api/org/${s.orgId}/invoicing/contact/lookup/ATU12345678`, s.session)
    expect([r.status, (await r.json()).code]).toEqual([503, 'lookup_unavailable'])
  })

  it('a backup mail on a master attaches no more than the relay carries', () => {
    expect(attachmentCeiling()).toBe(MAX_ATTACHMENT_BINARY_BYTES)
    ;(config.node as any).role = 'master'
    expect(attachmentCeiling()).toBe(config.relay.maxAttachmentBytes)
  })
})
