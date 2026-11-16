import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { AuditLog, EmailLog, InternalOrder, Org, Outbox } from 'db/models'
import type { CapabilityId, Grant } from 'config/access'
import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import { MAX_SELECTION } from 'config/doc-email'
import { drainOne } from 'services/biz/relay/outbox-worker'
import { docEmailController } from 'invoicing-api/src/controllers/doc-email.controller'
import { DOC_EMAIL_KINDS, INTERNAL_ORDER_ENTITY, docEmailRenderers, previewDocEmail, sendDocEmail } from 'invoicing-api/src/lib/doc-email'
import { renderInternalOrderPdf } from 'invoicing-api/src/lib/internal-order-pdf'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'

/**
 * The customer orders list's ticked orders, by e-mail (2026-11-16): kind `internal-order` of
 * `POST invoicing/export/email/preview` and `POST invoicing/export/email`.
 *
 * Asked through the real routes (the auth plugin, the route's floor, the body's schema, the handler), except where
 * a session of exactly some capabilities is needed, which only the library takes. The provider is faked (`fetch`),
 * and so is the printing: a render is a fresh Chrome, and what is asked here is who gets which file, what is logged
 * about each order and what the answer says. The sheet itself is `unit/customer-order-sheet` and
 * `integration/internal-order-print.flow`.
 *
 * ⚠ No mail leaves this file: every provider call is answered here.
 *
 * NOTE: no `.rejects` / `.resolves` (they deadlock the Windows runner).
 */

const { Types } = mongoose
const TO = 'orders@client-one.test'
const KIND = 'internal-order'
const realFetch = globalThis.fetch
const saved = {
  key: config.email.sendgridApiKey, role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile,
  internalOrder: docEmailRenderers.internalOrder, invoice: docEmailRenderers.invoice,
}
let tmp = ''
/** What was printed: each order's id and the language asked. Two are printed at a time, so never in a known order. */
let printed: Array<{ id: string; locale?: string }> = []

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

afterEach(async () => {
  globalThis.fetch = realFetch
  ;(config.email as any).sendgridApiKey = saved.key
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  docEmailRenderers.internalOrder = saved.internalOrder
  docEmailRenderers.invoice = saved.invoice
  forgetAllHomes()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
  printed = []
}, 30_000)

/** SendGrid, faked: every request is kept, and answered `status`. */
function fakeSendGrid(status = 202) {
  ;(config.email as any).sendgridApiKey = 'SG.test-key'
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

/** Printing, faked: a file that names its order, so a test can tell whose it is. */
function fakePrinting(opts: { failing?: Set<string> } = {}) {
  docEmailRenderers.internalOrder = (async (orgId: string, id: string, o?: { locale?: string }) => {
    printed.push({ id, locale: o?.locale })
    const order: any = await InternalOrder.findOne({ _id: id, orgId }).lean()
    if (!order) return { ok: false, status: 404, message: 'Incoming order not found' }
    if (opts.failing?.has(id)) return { ok: false, status: 503, message: 'PDF renderer unavailable', detail: 'no browser' }
    return { ok: true, buffer: Buffer.from(`%PDF ${order.orderNumber}`), filename: `${order.orderNumber}.pdf`, order }
  }) as any
}

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
const bytesOf = (attachment: any) => Buffer.from(attachment.content, 'base64').toString()
const printedIds = () => printed.map(p => p.id).sort()

/** `createAuditEntry` does not wait for its write: neither does a test that reads it. */
async function auditOf(orgId: string, want: number): Promise<any[]> {
  for (let i = 0; i < 60; i++) {
    const rows = await AuditLog.find({ orgId, action: 'email' }).lean()
    if (rows.length >= want) return rows
    await new Promise(r => setTimeout(r, 50))
  }
  return AuditLog.find({ orgId, action: 'email' }).lean()
}

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const app = new Elysia().onError(spaErrorHandler({}) as any).use(docEmailController)

async function world() {
  const org = await createTestOrg({ name: 'Example Ltd' } as any)
  // On an organization's own server its home is recorded before anything else is written for it.
  await homeNewOrg(org._id)
  await Org.updateOne({ _id: org._id }, { $set: { email: 'office@example.test' } })
  const orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const user = { id: String(admin._id), role: 'admin', permissions: [...DEFAULT_ROLE_PERMISSIONS.admin] }
  const client = await createTestContact(org._id, { companyName: 'Client One', email: TO } as any)
  const product = await createTestProduct(org._id)
  let seq = 0
  /** A customer order of the client, confirmed unless told otherwise. A draft carries its `DRF-` number. */
  async function order(extra: Record<string, any> = {}) {
    const n = String(++seq).padStart(5, '0')
    const status = extra.status ?? 'confirmed'
    const o: any = await InternalOrder.create({
      orgId: org._id,
      orderNumber: status === 'draft' ? `DRF-ORDI-2026-${n}` : `ORDI-2026-${n}`,
      status,
      statusHistory: [{ status, changedAt: new Date() }],
      contactId: client._id,
      issueDate: new Date('2026-11-16T00:00:00Z'),
      requestedDeliveryDate: new Date('2026-11-20T00:00:00Z'),
      priority: 'normal',
      currency: 'EUR',
      exchangeRate: 1,
      // A price no number, date or quantity of the fixture repeats: it may reach neither the answer nor the note.
      lines: [{ productId: product._id, description: product.name, quantity: 12, unit: 'pcs', expectedUnitPrice: 7.31 }],
      createdBy: admin._id,
      ...extra,
    } as any)
    return { id: String(o._id), number: o.orderNumber as string }
  }

  /** A session of a role as its token is issued, and its two routes. */
  async function session(role: Role) {
    const person = role === 'admin' ? { _id: user.id } : await createTestUser(org._id, { role } as any)
    const token = await (signer as any).decorator.jwt.sign({
      id: String(person._id), orgId, role, email: `${role}@test.com`, username: role,
      firstName: 'Test', lastName: 'User', permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
      ...(DEFAULT_ROLE_AREAS[role] ? { areas: DEFAULT_ROLE_AREAS[role] } : {}),
    })
    return async (path: '' | '/preview', body: unknown, opts: { anonymous?: boolean; orgId?: string } = {}) => {
      const res = await app.handle(new Request(`http://localhost/org/${opts.orgId ?? orgId}/invoicing/export/email${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.anonymous ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
      }))
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
  }

  return { org, orgId, admin, user, client, order, session }
}

describe('the kind', () => {
  it('is the third of the two routes, printed by the function the order\'s Print button downloads from', () => {
    expect([...DOC_EMAIL_KINDS]).toEqual(['invoice', 'order', KIND])
    expect(saved.internalOrder).toBe(renderInternalOrderPdf)
    // What the audit log already calls a customer order (`internal-order.controller`).
    expect(INTERNAL_ORDER_ENTITY).toBe('internal_order')
  })
})

describe('the preview', () => {
  it('names each order and its client, says why one will not go, and writes nothing', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const post = await w.session('admin')
    const quiet = await createTestContact(w.org._id, { companyName: '', firstName: 'Ana', lastName: 'Client', email: '  ' } as any)
    const withAddress = await w.order()
    const noAddress = await w.order({ contactId: quiet._id })
    const draft = await w.order({ status: 'draft' })
    const cancelled = await w.order({ status: 'cancelled' })
    const delivered = await w.order({ status: 'partially_delivered', issueDate: new Date('2026-11-10T00:00:00Z') })
    // A contact that is another organization's is not read: the order has nobody to be addressed to.
    const orphan = await w.order({ contactId: other.client._id })
    const foreign = await other.order()
    const nowhere = String(new Types.ObjectId())

    const reply = await post('/preview', {
      kind: KIND,
      ids: [withAddress.id, noAddress.id, draft.id, cancelled.id, delivered.id, orphan.id, foreign.id, withAddress.id, 'nope', nowhere],
    })

    expect(reply.status).toBe(200)
    const client = { id: String(w.client._id), name: 'Client One', email: TO }
    const day = '2026-11-16T00:00:00.000Z'
    expect(reply.json.documents).toEqual([
      { id: withAddress.id, number: withAddress.number, docType: 'internal_order', date: day, status: 'confirmed', partner: client },
      // A client with no address on its card: named, and the dialog's line starts empty.
      { id: noAddress.id, number: noAddress.number, docType: 'internal_order', date: day, status: 'confirmed', partner: { id: String(quiet._id), name: 'Ana Client' } },
      // A draft is named by the number it has, and why it stays.
      { id: draft.id, number: draft.number, docType: 'internal_order', date: day, status: 'draft', partner: client, blocked: 'draft' },
      // ⚠ A cancelled order goes: nothing blocks it.
      { id: cancelled.id, number: cancelled.number, docType: 'internal_order', date: day, status: 'cancelled', partner: client },
      { id: delivered.id, number: delivered.number, docType: 'internal_order', date: '2026-11-10T00:00:00.000Z', status: 'partially_delivered', partner: client },
      { id: orphan.id, number: orphan.number, docType: 'internal_order', date: day, status: 'confirmed' },
      // Another organization's order, a string that is no id and an id of nothing are one row, and say nothing.
      { id: foreign.id, number: '', docType: '', blocked: 'not_found' },
      { id: 'nope', number: '', docType: '', blocked: 'not_found' },
      { id: nowhere, number: '', docType: '', blocked: 'not_found' },
    ])
    expect(draft.number).toMatch(/^DRF-ORDI-/)
    // It read, and did nothing else.
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
    expect(await Outbox.countDocuments({})).toBe(0)
    await new Promise(r => setTimeout(r, 100))
    expect(await AuditLog.countDocuments({ action: 'email' })).toBe(0)
  })

  it('takes a hundred ticked orders and no more', async () => {
    const w = await world()
    const post = await w.session('admin')
    const ids = Array.from({ length: MAX_SELECTION + 1 }, () => String(new Types.ObjectId()))
    const over = await post('/preview', { kind: KIND, ids })
    expect(over.status).toBe(422)
    expect(over.json).toMatchObject({ code: 'selection_too_large', max: 100 })
    expect((await post('/preview', { kind: KIND, ids: ids.slice(1) })).status).toBe(200)
    expect((await post('/preview', { kind: KIND, ids: [] })).status).toBe(400)
  })
})

describe('the mail', () => {
  it('three orders to their client are ONE mail of three files, and each order has its own log row and audit entry', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const post = await w.session('admin')
    const orders = [await w.order(), await w.order({ status: 'completed' }), await w.order({ status: 'cancelled' })]
    const before: any[] = await InternalOrder.find({ orgId: w.orgId }).sort({ orderNumber: 1 }).lean()

    const reply = await post('', { kind: KIND, to: TO, items: orders.map(o => ({ id: o.id })), message: 'Thank you', locale: 'en' })

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      to: TO, mails: 1, queued: false,
      results: orders.map(o => ({ id: o.id, number: o.number, status: 'sent' })),
    })
    // One provider call, to the one recipient, with a reply reaching the org.
    expect(sent).toHaveLength(1)
    expect(sent[0].personalizations).toEqual([{ to: [{ email: TO }] }])
    expect(sent[0].reply_to).toEqual({ email: 'office@example.test' })
    expect(sent[0].subject).toBe('3 documents — Example Ltd')
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual(orders.map(o => `${o.number}.pdf`))
    expect(sent[0].attachments.map(bytesOf)).toEqual(orders.map(o => `%PDF ${o.number}`))
    expect(sent[0].attachments.every((a: any) => a.type === 'application/pdf')).toBe(true)
    // The note lists them, each as its sheet is titled, above the person's message. A cancelled one says so.
    const html: string = sent[0].content[0].value
    expect(html).toContain('Please find attached 3 documents:')
    for (const o of orders) expect(html).toContain(`<strong>${o.number}</strong>`)
    expect(html.split('Order confirmation')).toHaveLength(3)
    expect(html.split('Order (cancelled)')).toHaveLength(2)
    expect(html.indexOf(orders[2]!.number)).toBeLessThan(html.indexOf('Thank you'))
    // The sheet states no price, and neither does the note.
    for (const money of ['7.31', '87.72', 'EUR', 'Total']) expect({ money, said: html.includes(money) }).toEqual({ money, said: false })

    // Each order printed once, in the mail's language, from this org.
    expect(printedIds()).toEqual(orders.map(o => o.id).sort())
    expect(printed.every(p => p.locale === 'en')).toBe(true)

    // A log row per order: its own id and its own file, the mail's recipient and subject.
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).lean()
    expect(logs).toHaveLength(3)
    for (const o of orders) {
      const row = logs.find(l => String(l.entityId) === o.id)
      expect(row).toMatchObject({ entityType: 'internal_order', to: TO, status: 'sent', subject: '3 documents — Example Ltd', attachmentNames: [`${o.number}.pdf`] })
      expect(String(row.creatorId)).toBe(w.user.id)
    }
    // An audit entry each, named by the order's number.
    const audit = await auditOf(w.orgId, 3)
    expect(audit.map(a => [String(a.entityId), a.entityName]).sort()).toEqual(orders.map(o => [o.id, o.number]).sort())
    expect(audit.every(a => a.module === 'invoicing' && a.entityType === 'internal_order' && String(a.userId) === w.user.id)).toBe(true)
    // An order keeps no send history of its own: mailing wrote nothing on it.
    expect(await InternalOrder.find({ orgId: w.orgId }).sort({ orderNumber: 1 }).lean()).toEqual(before)
  })

  it('one order alone is named as its sheet is titled, in the mail\'s language, and states no total', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const post = await w.session('admin')
    const confirmed = await w.order()
    const cancelled = await w.order({ status: 'cancelled' })

    expect((await post('', { kind: KIND, to: TO, items: [{ id: confirmed.id }], locale: 'bg' })).json.results)
      .toEqual([{ id: confirmed.id, number: confirmed.number, status: 'sent' }])
    await post('', { kind: KIND, to: TO, items: [{ id: cancelled.id }], locale: 'bg' })
    await post('', { kind: KIND, to: 'colleague@example.test', items: [{ id: confirmed.id }], subject: '  Your order  ', locale: 'de' })

    expect(sent).toHaveLength(3)
    expect(sent[0].subject).toBe(`Потвърждение на поръчка ${confirmed.number} — Example Ltd`)
    expect(sent[0].content[0].value).toContain(`Прикачено ще намерите <strong>Потвърждение на поръчка ${confirmed.number}</strong>.`)
    expect(sent[0].content[0].value).toContain('2026-11-16')
    // No total: the row is not there at all.
    expect(sent[0].content[0].value).not.toContain('Общо')
    // A cancelled order's mail says it is one before the file is opened.
    expect(sent[1].subject).toBe(`Поръчка (отказана) ${cancelled.number} — Example Ltd`)
    expect(sent[1].content[0].value).toContain(`<strong>Поръчка (отказана) ${cancelled.number}</strong>`)
    // The subject the dialog gives is taken, trimmed; the note is in the language asked.
    expect(sent[2].subject).toBe('Your order')
    expect(sent[2].content[0].value).toContain(`<strong>Auftragsbestätigung ${confirmed.number}</strong>`)
    expect(printed.map(p => p.locale)).toEqual(['bg', 'bg', 'de'])
    await auditOf(w.orgId, 3)
  })

  it('a draft, another organization\'s order and an id that names nothing are skipped, and the rest go', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const post = await w.session('admin')
    const confirmed = await w.order()
    const draft = await w.order({ status: 'draft' })
    const cancelled = await w.order({ status: 'cancelled' })
    const foreign = await other.order()
    const nowhere = String(new Types.ObjectId())

    const reply = await post('', {
      kind: KIND, to: TO, locale: 'en',
      items: [
        { id: confirmed.id }, { id: draft.id }, { id: foreign.id }, { id: 'not-an-id' }, { id: nowhere },
        // An order has no groups: one named beside it is not read, so this is the first item again.
        { id: confirmed.id, groupId: String(new Types.ObjectId()) },
        { id: cancelled.id },
      ],
    })

    expect(reply.status).toBe(200)
    expect(reply.json.results).toEqual([
      { id: confirmed.id, number: confirmed.number, status: 'sent' },
      { id: draft.id, number: draft.number, status: 'skipped', reason: 'draft' },
      // Another organization's order, a string that is no id and an id of nothing are one answer, with no number.
      { id: foreign.id, number: '', status: 'skipped', reason: 'not_found' },
      { id: 'not-an-id', number: '', status: 'skipped', reason: 'not_found' },
      { id: nowhere, number: '', status: 'skipped', reason: 'not_found' },
      // ⚠ A cancelled order goes.
      { id: cancelled.id, number: cancelled.number, status: 'sent' },
    ])
    expect(reply.json).toMatchObject({ mails: 1, queued: false })
    expect(sent).toHaveLength(1)
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual([`${confirmed.number}.pdf`, `${cancelled.number}.pdf`])
    // Only what goes is printed, and only what went is logged.
    expect(printedIds()).toEqual([confirmed.id, cancelled.id].sort())
    expect((await EmailLog.find({}).lean()).map((l: any) => String(l.entityId)).sort()).toEqual([confirmed.id, cancelled.id].sort())
    expect((await auditOf(w.orgId, 2)).map(a => String(a.entityId)).sort()).toEqual([confirmed.id, cancelled.id].sort())
    expect(await AuditLog.countDocuments({ orgId: other.orgId, action: 'email' })).toBe(0)
  })

  it('the same order to the same address inside a minute is a double click; another address, and a retry of a failure, go', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const post = await w.session('admin')
    const [a, b] = [await w.order(), await w.order()]
    const mail = (items: Array<{ id: string }>, to = TO) => post('', { kind: KIND, to, items, locale: 'en' })

    expect((await mail([{ id: a.id }])).json.results).toEqual([{ id: a.id, number: a.number, status: 'sent' }])
    // Again, with another order beside it: the one just sent stays, the other goes.
    const again = await mail([{ id: a.id }, { id: b.id }])
    expect(again.json).toEqual({
      to: TO, mails: 1, queued: false,
      results: [
        { id: a.id, number: a.number, status: 'skipped', reason: 'just_sent' },
        { id: b.id, number: b.number, status: 'sent' },
      ],
    })
    // Nothing but double clicks: no mail at all, and nothing printed for it.
    const nothing = await mail([{ id: a.id }, { id: b.id }])
    expect(nothing.json).toMatchObject({ mails: 0, results: [{ status: 'skipped', reason: 'just_sent' }, { status: 'skipped', reason: 'just_sent' }] })
    expect(sent).toHaveLength(2)
    expect(printedIds()).toEqual([a.id, b.id].sort())
    // The window is per order AND address: the same order to a colleague goes.
    expect((await mail([{ id: a.id }], 'colleague@example.test')).json.results).toEqual([{ id: a.id, number: a.number, status: 'sent' }])
    expect(sent).toHaveLength(3)

    // A mail the provider refused is no block: the failure is why the person asks again.
    const c = await w.order()
    fakeSendGrid(500)
    const failed = await mail([{ id: c.id }])
    expect(failed.json).toMatchObject({ mails: 0, results: [{ id: c.id, number: c.number, status: 'failed', reason: 'provider_error' }] })
    expect(await EmailLog.countDocuments({ entityId: c.id, status: 'failed' })).toBe(1)
    fakeSendGrid()
    expect((await mail([{ id: c.id }])).json.results).toEqual([{ id: c.id, number: c.number, status: 'sent' }])
    // Three orders went (one of them twice, to two addresses); the failed attempt has no audit entry.
    expect(await auditOf(w.orgId, 4)).toHaveLength(4)
  })

  it('an order that cannot be printed is dropped alone', async () => {
    const sent = fakeSendGrid()
    const w = await world()
    const post = await w.session('admin')
    const [good, bad] = [await w.order(), await w.order()]
    fakePrinting({ failing: new Set([bad.id]) })

    const reply = await post('', { kind: KIND, to: TO, items: [{ id: bad.id }, { id: good.id }], locale: 'en' })

    expect(reply.json.results).toEqual([
      { id: bad.id, number: bad.number, status: 'failed', reason: 'render_failed', message: 'PDF renderer unavailable (no browser)' },
      { id: good.id, number: good.number, status: 'sent' },
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual([`${good.number}.pdf`])
    expect((await auditOf(w.orgId, 1)).map(a => String(a.entityId))).toEqual([good.id])
  })

  it('a server with no mail key answers 503 before anything is printed, and logs nothing', async () => {
    fakePrinting()
    ;(config.email as any).sendgridApiKey = ''
    let called = false
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).startsWith('https://api.sendgrid.com/')) called = true
      return realFetch(url, init)
    }) as any
    const w = await world()
    const post = await w.session('admin')
    const o = await w.order()

    const reply = await post('', { kind: KIND, to: TO, items: [{ id: o.id }] })

    expect(reply.status).toBe(503)
    expect(reply.json).toEqual({ code: 'not_configured', message: 'Email is not configured on this server' })
    expect(called).toBe(false)
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
    await new Promise(r => setTimeout(r, 100))
    expect(await AuditLog.countDocuments({ action: 'email' })).toBe(0)
    // The preview still answers: it mails nothing.
    expect((await post('/preview', { kind: KIND, ids: [o.id] })).status).toBe(200)
  })

  it('the request itself is refused for what is true of all of it, each with what the dialog shows', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const post = await w.session('admin')
    const o = await w.order()
    const body = { kind: KIND, to: TO, items: [{ id: o.id }] }

    expect((await post('', body, { anonymous: true })).status).toBe(401)
    expect((await post('/preview', { kind: KIND, ids: [o.id] }, { anonymous: true })).status).toBe(401)
    expect((await post('', { ...body, to: 'nobody' })).status).toBe(400)
    expect((await post('', { ...body, items: [] })).status).toBe(400)
    expect((await post('', { ...body, items: [{ id: '  ' }] })).status).toBe(400)
    // A sheet has no columns to choose: named, they are not read.
    expect((await post('', { ...body, to: 'other@example.test', columns: ['no-such-column'] })).status).toBe(200)
    const eleven = await post('', { ...body, items: Array.from({ length: 11 }, () => ({ id: String(new Types.ObjectId()) })) })
    expect(eleven.status).toBe(422)
    expect(eleven.json).toMatchObject({ code: 'selection_too_large', max: 10 })
    // A kind the routes do not know is the body's fault.
    expect((await post('', { ...body, kind: 'internal_order' })).status).toBe(422)
    expect(printedIds()).toEqual([o.id])
    await auditOf(w.orgId, 1)
  })
})

describe('who mails a customer order', () => {
  it('a read-only role is refused before its body is read: 403, never the body\'s shape', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const o = await w.order()
    // Both read orders and print a sheet, and neither works on orders.
    for (const role of ['member', 'nra_auditor'] as Role[]) {
      const post = await w.session(role)
      for (const path of ['', '/preview'] as const) {
        const garbage = await post(path, { nothing: 'the schema asks for' })
        expect({ role, path, status: garbage.status, code: garbage.json.code }).toEqual({ role, path, status: 403, code: 'permission_required' })
      }
      expect((await post('', { kind: KIND, to: TO, items: [{ id: o.id }] })).status).toBe(403)
      expect((await post('/preview', { kind: KIND, ids: [o.id] })).status).toBe(403)
    }
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
    // The same body from a role that mails is the body's own fault.
    expect((await (await w.session('admin'))('', { nothing: 'the schema asks for' })).status).toBe(422)
  })

  it('a role that mails other documents and reads no customer order is refused by this kind\'s own rule', async () => {
    fakeSendGrid()
    fakePrinting()
    docEmailRenderers.invoice = (async (_orgId: string, id: string) => ({ ok: true, buffer: Buffer.from('%PDF'), filename: `${id}.pdf`, invoice: {} })) as any
    const w = await world()
    const o = await w.order()
    const invoice: any = await createTestInvoice(w.org._id, w.client._id as any, { invoiceNumber: 'INV-00001', status: 'sent', total: 10 } as any)
    // A Seller works on sales documents, which is the routes' floor, and reads no customer order.
    const post = await w.session('seller')

    const preview = await post('/preview', { kind: KIND, ids: [o.id] })
    expect([preview.status, preview.json]).toEqual([403, { message: 'Forbidden' }])
    const mail = await post('', { kind: KIND, to: TO, items: [{ id: o.id }] })
    expect([mail.status, mail.json]).toEqual([403, { message: 'Forbidden' }])
    // Refused whatever is asked for: an order that is not there answers the same.
    expect((await post('', { kind: KIND, to: TO, items: [{ id: String(new Types.ObjectId()) }] })).status).toBe(403)
    expect(printed).toEqual([])
    // The same session mails a sales document: the 403 is the kind's, not the route's.
    const sales = await post('', { kind: 'invoice', to: TO, items: [{ id: String(invoice._id) }] })
    expect([sales.status, sales.json.results[0].status]).toEqual([200, 'sent'])
    // The roles that work on orders and print mail them.
    for (const role of ['manager', 'accountant', 'sales', 'sales_consultant'] as Role[]) {
      const reply = await (await w.session(role))('/preview', { kind: KIND, ids: [o.id] })
      expect({ role, status: reply.status, blocked: reply.json.documents?.[0]?.blocked }).toEqual({ role, status: 200, blocked: undefined })
    }
    await auditOf(w.orgId, 1)
  })

  it('takes the read, the export and the work on orders, each of them: a session without one mails none', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const o = await w.order()
    const as = (...c: string[]) => ({ id: w.user.id, role: 'member', permissions: [], access: caps(...c) })
    const ask = async (user: any) => [
      (await previewDocEmail({ orgId: w.orgId, user, kind: KIND, ids: [o.id] })).status,
      (await sendDocEmail({ orgId: w.orgId, user, kind: KIND, to: 'x@example.test', items: [{ id: o.id }] })).status,
    ]

    // Reads and prints, does not write · writes, may not print · the page-less reads, which reach a SUPPLIER order only.
    expect(await ask(as('orders.view', 'sales-docs.export'))).toEqual([403, 403])
    expect(await ask(as('orders.view', 'orders.create', 'orders.edit'))).toEqual([403, 403])
    expect(await ask(as('orders.browse', 'orders.lookup', 'orders.edit', 'sales-docs.export'))).toEqual([403, 403])
    expect(await ask(as('orders.view', 'orders.delete', 'sales-docs.export'))).toEqual([403, 403])
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
    // With all three it goes; creating orders is the work as much as editing them.
    expect(await ask(as('orders.view', 'orders.create', 'sales-docs.export'))).toEqual([200, 200])
    await auditOf(w.orgId, 1)
  })

  it('another organization\'s session is refused by the tenant guard, as on every route', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const o = await w.order()
    const post = await other.session('admin')
    expect((await post('/preview', { kind: KIND, ids: [o.id] }, { orgId: w.orgId })).status).toBe(403)
    expect((await post('', { kind: KIND, to: TO, items: [{ id: o.id }] }, { orgId: w.orgId })).status).toBe(403)
    // In its own organization the same id names nothing.
    expect((await post('/preview', { kind: KIND, ids: [o.id] })).json.documents).toEqual([{ id: o.id, number: '', docType: '', blocked: 'not_found' }])
    expect((await post('', { kind: KIND, to: TO, items: [{ id: o.id }] })).json.results).toEqual([{ id: o.id, number: '', status: 'skipped', reason: 'not_found' }])
    expect(printed).toEqual([])
  })
})

describe('on an organization\'s own server', () => {
  const NODE = 'master-ordiemailtestaa'.padEnd(23, 'a')

  it('the mail is queued and said to be waiting, and its log rows are settled when it has gone', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lgr-ordi-email-'))
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    ;(config.email as any).sendgridApiKey = ''
    fakePrinting()
    const w = await world()
    const orders = [await w.order(), await w.order({ status: 'cancelled' })]
    const mail = (items: Array<{ id: string }>) => sendDocEmail({ orgId: w.orgId, user: w.user, kind: KIND, to: TO, items, locale: 'en' })

    const reply = await mail(orders.map(o => ({ id: o.id })))

    // Queued, and said so: never "sent" while the mail waits for lgrai.app.
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ to: TO, mails: 1, queued: true, results: orders.map(o => ({ id: o.id, number: o.number, status: 'queued' })) })
    const item: any = await Outbox.findOne({ orgId: w.orgId }).lean()
    expect(item.state).toBe('queued')
    expect(item.payload.attachments.map((a: any) => a.filename)).toEqual(orders.map(o => `${o.number}.pdf`))
    expect(item.payload.entities).toEqual(orders.map(o => ({ entityType: 'internal_order', entityId: o.id, attachmentName: `${o.number}.pdf` })))
    const queued: any[] = await EmailLog.find({ outboxId: item._id }).lean()
    expect(queued.map(l => l.status)).toEqual(['queued', 'queued'])
    expect(queued.map(l => String(l.entityId)).sort()).toEqual(orders.map(o => o.id).sort())
    // A second click while it waits would queue a second mail: it is the double click too.
    expect((await mail([{ id: orders[0]!.id }])).body).toMatchObject({ mails: 0, results: [{ status: 'skipped', reason: 'just_sent' }] })
    expect(await Outbox.countDocuments({ orgId: w.orgId })).toBe(1)
    // A queued order is audited as mailed: the person did their part.
    expect(await auditOf(w.orgId, 2)).toHaveLength(2)

    // lgrai.app sends it. An order keeps no send history, so the worker has nothing of its own to do for one:
    // the log rows are settled by the outbox item, as any mail's are.
    const file = join(tmp, 'node-token.json')
    writeFileSync(file, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 600 }))
    ;(config.outbox as any).tokenFile = file
    const asked: any[] = []
    const global = (async (_url: any, init: any) => {
      asked.push(JSON.parse(init.body))
      return Response.json({ state: 'sent' }, { status: 200 })
    }) as any
    expect(await drainOne(new Date(), global)).toBe('sent')

    expect(asked[0].attachments).toHaveLength(2)
    expect((await EmailLog.find({ outboxId: item._id }).lean()).map((l: any) => l.status)).toEqual(['sent', 'sent'])
    const done: any = await Outbox.findById(item._id).lean()
    expect(done.state).toBe('sent')
    expect(done.payload.entities).toHaveLength(2)
  })
})
