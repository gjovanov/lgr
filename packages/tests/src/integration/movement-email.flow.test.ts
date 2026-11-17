import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { AuditLog, EmailLog, Identity, Org, Outbox, StockLevel, StockMovement } from 'db/models'
import { templateGrant, type CapabilityId, type Grant } from 'config/access'
import { MAX_DOCS_PER_MAIL, MAX_SELECTION, chunkDocuments, groupByPartner, planForOneAddress } from 'config/doc-email'
import { sessionFor } from 'services/biz/auth.service'
import { drainOne } from 'services/biz/relay/outbox-worker'
import { renderStockMovementPdf } from 'services/biz/stock-movement-document.service'
import { MOVEMENT_ENTITY, emailMovements, movementEmailRenderers, previewMovementEmail } from 'warehouse-api/src/lib/movement-email'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestUser, createTestWarehouse } from '../helpers/factories'

/**
 * The movements list's ticked movements, by e-mail (2026-11-16): `POST warehouse/movement/email/preview` and
 * `POST warehouse/movement/email`, the kind `movement` of `config/doc-email`.
 *
 * The provider is faked (`fetch`), and so is the printing in all but one test: a render is a fresh Chrome, and what
 * is asked here is who gets which file, what is logged about each movement, and who may mail which. The last part
 * mounts the whole route table, so the two routes are the ones a client reaches, beside the movement routes that
 * share their prefix, and every session there is the one sign-in issues.
 *
 * ⚠ No mail leaves this file: a request to the provider that no test faked is refused here, not sent.
 *
 * NOTE: no `.rejects` / `.resolves` (they deadlock the Windows runner).
 */

const { Types } = mongoose
const TO = 'colleague@othersite.test'
const realFetch = globalThis.fetch
const saved = {
  key: config.email.sendgridApiKey, role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile,
  movement: movementEmailRenderers.movement,
}
let tmp = ''
/** The ids printed. ⚠ Two are printed at a time: their order is not a thing to assert. */
let printed: string[] = []
/** The locale each print was asked in. */
let printedIn: string[] = []

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sign = (claims: object): Promise<string> => (signer as any).decorator.jwt.sign(claims)

let app: Elysia
let passwordHash: string

/** The provider is out of reach unless a test fakes it: a mail that would really leave fails the test instead. */
const guardedFetch = (async (url: any, init: any) => {
  if (String(url).includes('sendgrid')) throw new Error('a test tried to reach the mail provider')
  return realFetch(url, init)
}) as typeof fetch

beforeAll(async () => {
  await setupTestDB()
  globalThis.fetch = guardedFetch
  passwordHash = await Bun.password.hash('test123')
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
}, 60_000)
afterAll(async () => {
  globalThis.fetch = realFetch
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  globalThis.fetch = guardedFetch
  ;(config.email as any).sendgridApiKey = saved.key
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  movementEmailRenderers.movement = saved.movement
  forgetAllHomes()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
  printed = []
  printedIn = []
}, 30_000)

/** SendGrid, faked: every request is kept, and answered `status`. Nothing is forwarded. */
function fakeSendGrid(status = 202) {
  ;(config.email as any).sendgridApiKey = 'SG.test-key'
  const sent: any[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).startsWith('https://api.sendgrid.com/')) {
      sent.push(JSON.parse(init.body))
      return new Response(status < 300 ? '' : 'provider down', { status })
    }
    return guardedFetch(url, init)
  }) as any
  return sent
}

/** Printing, faked: a file that names its movement, so a test can tell whose it is. */
function fakePrinting(opts: { failing?: Set<string> } = {}) {
  movementEmailRenderers.movement = (async (orgId: string, id: string, o: { locale?: string } = {}) => {
    printed.push(id)
    printedIn.push(String(o.locale))
    const movement: any = await StockMovement.findOne({ _id: id, orgId }).lean()
    if (!movement) return { ok: false, status: 404, message: 'Stock movement not found' }
    if (opts.failing?.has(id)) return { ok: false, status: 503, message: 'PDF renderer unavailable', detail: 'no browser' }
    return { ok: true, buffer: Buffer.from(`%PDF ${movement.movementNumber}`), filename: `${movement.movementNumber}.pdf`, movement }
  }) as any
}

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
const bytesOf = (attachment: any) => Buffer.from(attachment.content, 'base64').toString()
const sorted = (ids: readonly string[]) => [...ids].sort()

/** `createAuditEntry` does not wait for its write: neither does a test that reads it. */
async function auditOf(orgId: string, want: number): Promise<any[]> {
  for (let i = 0; i < 60; i++) {
    const rows = await AuditLog.find({ orgId, action: 'email' }).lean()
    if (rows.length >= want) return rows
    await new Promise(r => setTimeout(r, 50))
  }
  return AuditLog.find({ orgId, action: 'email' }).lean()
}

/** A member linked to a person, and their session as sign-in issues it. */
async function member(org: any, role: string, setName?: string) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@mvmail.test`
  const identity = await Identity.create({ email, firstName: 'F', lastName: role, isActive: true, passwordSetBy: 'self', password: passwordHash } as any)
  const set = null as { _id: unknown } | null // FR-27 P3-6: no permission sets; the person holds the built-in role of their key
  const user = await createTestUser(org._id, { role, email, identityId: identity._id, ...(set ? { permissionSetIds: [set._id] } : {}) } as any)
  return { user, token: await sign(await sessionFor(user, identity)) }
}

async function world() {
  const org = await createTestOrg({ name: 'Example Ltd' } as any)
  // On an organization's own server its home is recorded before anything else is written for it.
  await homeNewOrg(org._id)
  await Org.updateOne({ _id: org._id }, { $set: { email: 'office@example.test' } })
  const orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  const user = { id: String(admin._id), access: templateGrant('admin') }
  const main = await createTestWarehouse(org._id, { name: 'Main warehouse', code: 'MAIN', isDefault: true } as any)
  const second = await createTestWarehouse(org._id, { name: 'Second warehouse', code: 'SECOND' } as any)
  const site = await createTestWarehouse(org._id, { name: 'Other site', code: 'SITE', isExternal: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Bolt M8', unit: 'pcs' } as any)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Supplier One', email: 'orders@supplier.test' } as any)
  let seq = 0
  /** What each type names, as a booked movement keeps it: a transfer here goes to the other site. */
  const sides = (type: string): Record<string, unknown> => {
    if (type === 'transfer') return { fromWarehouseId: main._id, externalToWarehouseId: site._id }
    if (type === 'receipt') return { toWarehouseId: main._id, contactId: supplier._id }
    return { fromWarehouseId: main._id }
  }
  /** A movement as it stands in the database: booked, unless told otherwise. */
  async function movement(type = 'transfer', extra: Record<string, any> = {}) {
    const m: any = await StockMovement.create({
      orgId, movementNumber: `SM-2026-${String(++seq).padStart(5, '0')}`, type, status: 'completed', date: new Date('2026-11-10T00:00:00Z'),
      createdBy: admin._id, lines: [{ productId: bolt._id, quantity: 4, unitCost: 5, totalCost: 20 }], totalAmount: 20,
      ...sides(type), ...extra,
    } as any)
    return { id: String(m._id), number: m.movementNumber as string }
  }
  const mail = (ids: string[], over: Record<string, any> = {}) =>
    emailMovements({ orgId, user, to: TO, items: ids.map(id => ({ id })), locale: 'en', ...over } as any)
  const preview = (ids: unknown[], who: any = user) => previewMovementEmail({ orgId, user: who, ids })
  /** A session of this org with exactly these capabilities, as an org on `roles` gives one. */
  const holding = (...c: string[]) => ({ id: user.id, role: 'member', permissions: [], access: caps(...c) })
  return { org, orgId, admin, user, main, second, site, bolt, supplier, movement, mail, preview, holding }
}

type World = Awaited<ReturnType<typeof world>>

describe('several movements to one address', () => {
  it('three booked movements are ONE mail of three files, and each movement has its own log row and audit entry', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const docs = [await w.movement('transfer'), await w.movement('receipt'), await w.movement('dispatch', { status: 'confirmed' })]

    const reply = await w.mail(docs.map(d => d.id), { message: 'Arriving on Thursday' })

    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      to: TO, mails: 1, queued: false,
      results: docs.map(d => ({ id: d.id, number: d.number, status: 'sent' })),
    })
    // One provider call, to the one recipient, with a reply reaching the org.
    expect(sent).toHaveLength(1)
    expect(sent[0].personalizations).toEqual([{ to: [{ email: TO }] }])
    expect(sent[0].reply_to).toEqual({ email: 'office@example.test' })
    expect(sent[0].subject).toBe('3 documents — Example Ltd')
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual(docs.map(d => `${d.number}.pdf`))
    expect(sent[0].attachments.map(bytesOf)).toEqual(docs.map(d => `%PDF ${d.number}`))
    expect(sent[0].attachments.every((a: any) => a.type === 'application/pdf')).toBe(true)
    expect(sorted(printed)).toEqual(sorted(docs.map(d => d.id)))
    expect(new Set(printedIn)).toEqual(new Set(['en']))
    // The note lists them, each by its type as the screens name it, above the person's message. No total: the
    // sheet carries no price.
    const html: string = sent[0].content[0].value
    expect(html).toContain('Please find attached 3 documents:')
    for (const d of docs) expect(html).toContain(`<strong>${d.number}</strong>`)
    for (const word of ['Transfer', 'Receipt', 'Dispatch']) expect(html).toContain(`>${word}</td>`)
    expect(html).toContain('2026-11-10')
    expect(html).not.toContain('Total')
    expect(html).not.toContain('20.00')
    expect(html.indexOf(docs[2]!.number)).toBeLessThan(html.indexOf('Arriving on Thursday'))

    // A log row per movement: its own id and its own file, the mail's recipient and subject.
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).lean()
    expect(logs).toHaveLength(3)
    for (const d of docs) {
      const row = logs.find(l => String(l.entityId) === d.id)
      expect(row).toMatchObject({ entityType: 'stock_movement', to: TO, status: 'sent', subject: '3 documents — Example Ltd', attachmentNames: [`${d.number}.pdf`] })
      expect(String(row.creatorId)).toBe(w.user.id)
    }
    // And an audit entry each, as the movement's other entries name it.
    const audit = await auditOf(w.orgId, 3)
    expect(sorted(audit.map(a => String(a.entityId)))).toEqual(sorted(docs.map(d => d.id)))
    expect(sorted(audit.map(a => String(a.entityName)))).toEqual(sorted(docs.map(d => d.number)))
    expect(audit.every(a => a.module === 'warehouse' && a.entityType === 'stock_movement' && String(a.userId) === w.user.id)).toBe(true)
    expect(MOVEMENT_ENTITY).toBe('stock_movement')
    // Mailing a sheet changes nothing of the movement or of the stock.
    for (const d of docs) expect(((await StockMovement.findById(d.id).lean()) as any).status).toMatch(/^(completed|confirmed)$/)
    expect(await StockLevel.countDocuments({ orgId: w.orgId })).toBe(0)
  })

  it('each address gets its own movements: the supplier its receipt, the other site its transfers', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const receipt = await w.movement('receipt')
    const transfers = [await w.movement('transfer'), await w.movement('transfer')]

    // The dialog asks once per recipient, as it plans them from the preview.
    const rows = ((await w.preview([receipt.id, ...transfers.map(t => t.id)])).body as any).documents
    const lines = groupByPartner(rows)
    expect(lines.map(g => [g.key, g.email, g.rows.map(r => r.id)])).toEqual([
      [String(w.supplier._id), 'orders@supplier.test', [receipt.id]],
      ['none', '', transfers.map(t => t.id)],
    ])
    await w.mail(lines[0]!.rows.map(r => r.id), { to: lines[0]!.email })
    await w.mail(lines[1]!.rows.map(r => r.id), { to: TO })

    expect(sent.map(m => m.personalizations[0].to[0].email)).toEqual(['orders@supplier.test', TO])
    expect(sent.map(m => m.attachments.map((a: any) => a.filename))).toEqual([[`${receipt.number}.pdf`], transfers.map(t => `${t.number}.pdf`)])
    expect(sent.map(m => m.attachments.map(bytesOf))).toEqual([[`%PDF ${receipt.number}`], transfers.map(t => `%PDF ${t.number}`)])
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).lean()
    expect(sorted(logs.map(l => `${l.to} ${l.attachmentNames.join()}`))).toEqual(sorted([
      `orders@supplier.test ${receipt.number}.pdf`, ...transfers.map(t => `${TO} ${t.number}.pdf`),
    ]))
    await auditOf(w.orgId, 3)
  })

  it('one movement is named by its type in the mail\'s language, and takes the subject the dialog gives', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const transfer = await w.movement('transfer')
    const receipt = await w.movement('receipt')

    await w.mail([transfer.id], { locale: 'bg' })
    await w.mail([receipt.id], { locale: 'bg', subject: '  Доставка от вторник  ', message: 'Първи ред\nВтори <ред>' })

    expect(sent[0].subject).toBe(`Прехвърляне ${transfer.number} — Example Ltd`)
    const html: string = sent[0].content[0].value
    expect(html).toContain(`Прикачено ще намерите <strong>Прехвърляне ${transfer.number}</strong>.`)
    expect(html).toContain('<td>2026-11-10</td>')
    expect(html).toContain('С уважение,<br>Example Ltd')
    expect(html).not.toContain('Общо')
    expect(sent[1].subject).toBe('Доставка от вторник')
    expect(sent[1].content[0].value).toContain(`<strong>Заприходяване ${receipt.number}</strong>`)
    expect(sent[1].content[0].value).toContain('Първи ред<br>Втори &lt;ред&gt;')
    // The sheet is printed in the language asked for.
    expect(printedIn).toEqual(['bg', 'bg'])
    await auditOf(w.orgId, 2)
  })

  it('a draft, a cancelled one and an id that names nothing here are skipped, and the rest go', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const booked = await w.movement('transfer')
    const draft = await w.movement('transfer', { status: 'draft' })
    const cancelled = await w.movement('receipt', { status: 'cancelled' })
    const foreign = await other.movement('transfer')
    const nowhere = String(new Types.ObjectId())

    const reply = await w.mail([booked.id, draft.id, cancelled.id, foreign.id, 'not-an-id', nowhere, booked.id, booked.id.toUpperCase()])

    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      to: TO, mails: 1, queued: false,
      results: [
        { id: booked.id, number: booked.number, status: 'sent' },
        { id: draft.id, number: draft.number, status: 'skipped', reason: 'draft' },
        { id: cancelled.id, number: cancelled.number, status: 'skipped', reason: 'cancelled' },
        // Another organization's movement, a string that is no id and an id of nothing are one answer, with no number.
        { id: foreign.id, number: '', status: 'skipped', reason: 'not_found' },
        { id: 'not-an-id', number: '', status: 'skipped', reason: 'not_found' },
        { id: nowhere, number: '', status: 'skipped', reason: 'not_found' },
      ],
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual([`${booked.number}.pdf`])
    // Only what goes is printed, and only what went is logged.
    expect(printed).toEqual([booked.id])
    expect(await EmailLog.countDocuments({})).toBe(1)
    const audit = await auditOf(w.orgId, 1)
    expect(audit.map(a => String(a.entityId))).toEqual([booked.id])
    expect(await AuditLog.countDocuments({ orgId: other.orgId })).toBe(0)
  })

  it('the same movement to the same address inside a minute is a double click; another address, a later click and a retry of a failure go', async () => {
    fakePrinting()
    const w = await world()
    const a = await w.movement('transfer')
    const b = await w.movement('transfer')

    let sent = fakeSendGrid()
    expect((await w.mail([a.id])).body).toMatchObject({ mails: 1, results: [{ status: 'sent' }] })
    // Again, with a movement that has not gone: only that one goes.
    const again = await w.mail([a.id, b.id])
    expect((again.body as any).results).toEqual([
      { id: a.id, number: a.number, status: 'skipped', reason: 'just_sent' },
      { id: b.id, number: b.number, status: 'sent' },
    ])
    expect(sent).toHaveLength(2)
    expect(sent[1].attachments.map((x: any) => x.filename)).toEqual([`${b.number}.pdf`])
    // Both again: nothing leaves, and nothing is printed for it.
    const printedSoFar = printed.length
    expect((await w.mail([a.id, b.id])).body).toEqual({
      to: TO, mails: 0, queued: false,
      results: [a, b].map(m => ({ id: m.id, number: m.number, status: 'skipped', reason: 'just_sent' })),
    })
    expect(sent).toHaveLength(2)
    expect(printed).toHaveLength(printedSoFar)
    // To somebody else it goes.
    expect((await w.mail([a.id], { to: 'warehouse@othersite.test' })).body).toMatchObject({ mails: 1, results: [{ status: 'sent' }] })
    // And to the same address once the minute is over.
    await EmailLog.collection.updateMany({ entityId: new Types.ObjectId(a.id), to: TO }, { $set: { createdAt: new Date(Date.now() - 61_000) } })
    expect((await w.mail([a.id])).body).toMatchObject({ mails: 1, results: [{ status: 'sent' }] })
    expect(sent).toHaveLength(4)

    // A FAILED attempt is no block: the failure is why the person asks again.
    const c = await w.movement('transfer')
    fakeSendGrid(500)
    expect((await w.mail([c.id])).body).toMatchObject({ mails: 0, results: [{ status: 'failed', reason: 'provider_error' }] })
    sent = fakeSendGrid()
    expect((await w.mail([c.id])).body).toMatchObject({ mails: 1, results: [{ status: 'sent' }] })
    expect(sent).toHaveLength(1)
    await auditOf(w.orgId, 5)
  })

  it('twelve ticked movements are two requests and two mails; one request takes no more than ten', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const docs = []
    for (let i = 0; i < 12; i++) docs.push(await w.movement('transfer'))

    const preview = await w.preview(docs.map(d => d.id))
    const plan = planForOneAddress((preview.body as any).documents, TO)
    const requests = chunkDocuments(plan.entries[0]!.rows)
    expect(requests.map(r => r.length)).toEqual([10, 2])
    const replies = []
    for (const rows of requests) replies.push(await w.mail(rows.map(r => r.id)))

    expect(replies.map(r => (r.body as any).mails)).toEqual([1, 1])
    expect(sent.map(m => m.attachments.length)).toEqual([10, 2])
    expect(sent.flatMap(m => m.attachments.map((a: any) => a.filename))).toEqual(docs.map(d => `${d.number}.pdf`))
    expect(await EmailLog.countDocuments({ orgId: w.orgId, status: 'sent', entityType: 'stock_movement' })).toBe(12)

    const over = await w.mail(docs.slice(0, MAX_DOCS_PER_MAIL + 1).map(d => d.id), { to: 'other@example.test' })
    expect(over.status).toBe(422)
    expect(over.body).toMatchObject({ code: 'selection_too_large', max: 10 })
    expect(sent).toHaveLength(2)
    await auditOf(w.orgId, 12)
  })

  it('a provider failure fails every movement of the mail and logs it; nothing is in the audit log', async () => {
    const sent = fakeSendGrid(500)
    fakePrinting()
    const w = await world()
    const docs = [await w.movement('transfer'), await w.movement('receipt')]

    const reply = await w.mail(docs.map(d => d.id))

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ mails: 0, queued: false })
    for (const [i, d] of docs.entries()) {
      expect((reply.body as any).results[i]).toMatchObject({ id: d.id, number: d.number, status: 'failed', reason: 'provider_error' })
      expect((reply.body as any).results[i].message).toContain('SendGrid 500')
    }
    expect(sent).toHaveLength(1)
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).lean()
    expect(logs.map(l => l.status)).toEqual(['failed', 'failed'])
    expect(sorted(logs.map(l => String(l.entityId)))).toEqual(sorted(docs.map(d => d.id)))
    await new Promise(r => setTimeout(r, 200))
    expect(await AuditLog.countDocuments({ orgId: w.orgId, action: 'email' })).toBe(0)
  })

  it('a movement that cannot be printed is dropped alone', async () => {
    const sent = fakeSendGrid()
    const w = await world()
    const docs = [await w.movement('transfer'), await w.movement('transfer'), await w.movement('transfer')]
    fakePrinting({ failing: new Set([docs[1]!.id]) })

    const reply = await w.mail(docs.map(d => d.id))

    expect((reply.body as any).results).toEqual([
      { id: docs[0]!.id, number: docs[0]!.number, status: 'sent' },
      { id: docs[1]!.id, number: docs[1]!.number, status: 'failed', reason: 'render_failed', message: 'PDF renderer unavailable (no browser)' },
      { id: docs[2]!.id, number: docs[2]!.number, status: 'sent' },
    ])
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual([`${docs[0]!.number}.pdf`, `${docs[2]!.number}.pdf`])
    expect(sent[0].subject).toBe('2 documents — Example Ltd')
    expect(await EmailLog.countDocuments({ orgId: w.orgId, entityId: docs[1]!.id })).toBe(0)
    const audit = await auditOf(w.orgId, 2)
    expect(sorted(audit.map(a => String(a.entityId)))).toEqual(sorted([docs[0]!.id, docs[2]!.id]))
  })

  it('a server with no mail key answers 503 before anything is printed, and logs nothing', async () => {
    fakePrinting()
    ;(config.email as any).sendgridApiKey = ''
    const w = await world()
    const m = await w.movement('transfer')

    const reply = await w.mail([m.id])

    expect(reply.status).toBe(503)
    expect(reply.body).toEqual({ code: 'not_configured', message: 'Email is not configured on this server' })
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
    await new Promise(r => setTimeout(r, 100))
    expect(await AuditLog.countDocuments({ orgId: w.orgId, action: 'email' })).toBe(0)
  })

  it('the request itself is refused for an address that is none, an empty list, and nothing else', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const m = await w.movement('transfer')
    expect((await w.mail([m.id], { to: 'nobody' })).status).toBe(400)
    expect((await w.mail([m.id], { to: '' })).status).toBe(400)
    expect((await w.mail([])).status).toBe(400)
    expect((await w.mail(['  '])).status).toBe(400)
    expect(printed).toEqual([])
  })

  it('what prints a movement for the mail is what prints it for its Print button', async () => {
    // The seam the other tests swap: left alone, the attachment is the print route's own render.
    expect(saved.movement).toBe(renderStockMovementPdf)
    const sent = fakeSendGrid()
    const w = await world()
    const transfer = await w.movement('transfer')

    const reply = await w.mail([transfer.id], { locale: 'bg' })

    expect(reply.body).toEqual({ to: TO, mails: 1, queued: false, results: [{ id: transfer.id, number: transfer.number, status: 'sent' }] })
    const [file] = sent[0].attachments
    expect(file.filename).toBe(`${transfer.number}.pdf`)
    expect(file.type).toBe('application/pdf')
    const bytes = Buffer.from(file.content, 'base64')
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
    expect(bytes.length).toBeGreaterThan(1000)
    await auditOf(w.orgId, 1)
  }, 180_000)
})

describe('who mails which movement', () => {
  it('a transfer-only session mails a transfer and is refused a receipt, on both models', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const transfer = await w.movement('transfer')
    const receipt = await w.movement('receipt')
    const dispatch = await w.movement('dispatch')
    const sellers = [
      // An org on `roles`: the Seller's part of the movements.
      w.holding('movements.lookup', 'movements.create:transfer'),
      // The built-in Seller (FR-26.7).
      { id: w.user.id, access: templateGrant('seller') },
    ]

    for (const [i, seller] of sellers.entries()) {
      const rows = ((await w.preview([transfer.id, receipt.id, dispatch.id], seller)).body as any).documents
      expect(rows.map((r: any) => [r.id, r.number, r.blocked])).toEqual([
        [transfer.id, transfer.number, undefined],
        // It reads the receipt, so it is told which one it may not mail.
        [receipt.id, receipt.number, 'forbidden'],
        [dispatch.id, dispatch.number, 'forbidden'],
      ])

      const reply = await w.mail([transfer.id, receipt.id, dispatch.id], { user: seller, to: `site-${i}@othersite.test` })
      expect(reply.status).toBe(200)
      expect((reply.body as any).results).toEqual([
        { id: transfer.id, number: transfer.number, status: 'sent' },
        { id: receipt.id, number: receipt.number, status: 'skipped', reason: 'forbidden' },
        { id: dispatch.id, number: dispatch.number, status: 'skipped', reason: 'forbidden' },
      ])
    }
    // Two mails of one file each, and the receipt was never printed.
    expect(sent.map(m => m.attachments.map((a: any) => a.filename))).toEqual([[`${transfer.number}.pdf`], [`${transfer.number}.pdf`]])
    expect(printed).toEqual([transfer.id, transfer.id])
    await auditOf(w.orgId, 2)
  })

  it('a session that works on movements and reads none is told of none', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const transfer = await w.movement('transfer')
    const blind = w.holding('movements.create', 'movements.edit')

    expect(((await w.preview([transfer.id], blind)).body as any).documents).toEqual([{ id: transfer.id, number: '', docType: '', blocked: 'not_found' }])
    expect((await w.mail([transfer.id], { user: blind })).body).toEqual({
      to: TO, mails: 0, queued: false, results: [{ id: transfer.id, number: '', status: 'skipped', reason: 'not_found' }],
    })
    expect(printed).toEqual([])
  })

  it('a session that only reads movements mails none: refused outright, both ways', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const transfer = await w.movement('transfer')
    const readers = [
      w.holding('movements.view', 'movements.lookup'),
      w.holding('sales-docs.view', 'sales-docs.edit'),
      { id: w.user.id, access: templateGrant('member') },
      { id: w.user.id, access: templateGrant('accountant') },
    ]
    for (const reader of readers) {
      expect((await w.preview([transfer.id], reader)).status).toBe(403)
      expect((await w.mail([transfer.id], { user: reader })).status).toBe(403)
      // Before the address or the list is looked at.
      expect((await w.mail([], { user: reader, to: 'nobody' })).status).toBe(403)
    }
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
  })
})

describe('on an organization\'s own server', () => {
  const NODE = 'master-mvmailtestaaaaaa'.padEnd(23, 'a')

  it('the mail is queued with its movements and goes when lgrai.app sends it: a movement keeps no history to settle', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lgr-mvm-email-'))
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    ;(config.email as any).sendgridApiKey = ''
    fakePrinting()
    const w = await world()
    const docs = [await w.movement('transfer'), await w.movement('transfer')]
    const before = await Promise.all(docs.map(d => StockMovement.findById(d.id).lean()))

    const reply = await w.mail(docs.map(d => d.id))

    // Queued, and said so: never "sent" while the mail waits for lgrai.app.
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ to: TO, mails: 1, queued: true, results: docs.map(d => ({ id: d.id, number: d.number, status: 'queued' })) })
    const item: any = await Outbox.findOne({ orgId: w.orgId }).lean()
    expect(item.state).toBe('queued')
    expect(item.payload.attachments.map((a: any) => a.filename)).toEqual(docs.map(d => `${d.number}.pdf`))
    expect(item.payload.entities).toEqual(docs.map(d => ({ entityType: 'stock_movement', entityId: d.id, attachmentName: `${d.number}.pdf` })))
    const queued: any[] = await EmailLog.find({ outboxId: item._id }).lean()
    expect(queued.map(l => l.status)).toEqual(['queued', 'queued'])
    expect(sorted(queued.map(l => String(l.entityId)))).toEqual(sorted(docs.map(d => d.id)))
    // A second click while it waits would queue a second mail: it is the double click too.
    expect((await w.mail([docs[0]!.id])).body).toMatchObject({ mails: 0, results: [{ status: 'skipped', reason: 'just_sent' }] })
    await auditOf(w.orgId, 2)

    // lgrai.app sends it. The worker has no branch for a movement, and needs none.
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
    expect(done.payload.attachments).toBeUndefined()
    expect(done.payload.entities).toHaveLength(2)
    // The movements are as they were, to the last field.
    expect(await Promise.all(docs.map(d => StockMovement.findById(d.id).lean()))).toEqual(before)
  })
})

describe('the preview', () => {
  it('names each movement and its contact, says why one will not go, and writes nothing', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const receipt = await w.movement('receipt')
    const transfer = await w.movement('transfer')
    const quiet = await createTestContact(w.org._id, { companyName: '', firstName: 'Ana', lastName: 'Buyer', email: '  ' } as any)
    const dispatch = await w.movement('dispatch', { status: 'confirmed', contactId: quiet._id, date: new Date('2026-11-12T00:00:00Z') })
    const draft = await w.movement('transfer', { status: 'draft' })
    const cancelled = await w.movement('receipt', { status: 'cancelled' })
    const foreign = await other.movement('transfer')

    const reply = await w.preview([receipt.id, transfer.id, dispatch.id, draft.id, cancelled.id, foreign.id, receipt.id, 'nope'])

    expect(reply.status).toBe(200)
    const supplier = { id: String(w.supplier._id), name: 'Supplier One', email: 'orders@supplier.test' }
    const day = '2026-11-10T00:00:00.000Z'
    expect((reply.body as any).documents).toEqual([
      // A receipt names its supplier, with the address on its card.
      { id: receipt.id, number: receipt.number, docType: 'receipt', date: day, status: 'completed', partner: supplier },
      // A transfer has no contact: the dialog opens on one address.
      { id: transfer.id, number: transfer.number, docType: 'transfer', date: day, status: 'completed' },
      // A contact with no address on its card: named, and the dialog's line starts empty.
      { id: dispatch.id, number: dispatch.number, docType: 'dispatch', date: '2026-11-12T00:00:00.000Z', status: 'confirmed', partner: { id: String(quiet._id), name: 'Ana Buyer' } },
      { id: draft.id, number: draft.number, docType: 'transfer', date: day, status: 'draft', blocked: 'draft' },
      { id: cancelled.id, number: cancelled.number, docType: 'receipt', date: day, status: 'cancelled', partner: supplier, blocked: 'cancelled' },
      // Another organization's movement and a string that is no id are one row, with nothing in it.
      { id: foreign.id, number: '', docType: '', blocked: 'not_found' },
      { id: 'nope', number: '', docType: '', blocked: 'not_found' },
    ])
    expect(await EmailLog.countDocuments({})).toBe(0)
    expect(await Outbox.countDocuments({})).toBe(0)
    expect(printed).toEqual([])
    await new Promise(r => setTimeout(r, 100))
    expect(await AuditLog.countDocuments({ orgId: { $in: [w.orgId, other.orgId] }, action: 'email' })).toBe(0)
  })

  it('what it blocks is what the mail request skips, for the same reason', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const docs = [
      await w.movement('transfer'), await w.movement('transfer', { status: 'draft' }), await w.movement('receipt', { status: 'cancelled' }),
      await w.movement('adjustment'), await w.movement('return', { status: 'confirmed' }),
    ]
    const ids = [...docs.map(d => d.id), String(new Types.ObjectId())]
    let went = 0
    for (const [i, who] of [w.user, w.holding('movements.lookup', 'movements.create:transfer'), w.holding('movements.view', 'movements.delete')].entries()) {
      const rows = ((await w.preview(ids, who)).body as any).documents
      const results = ((await w.mail(ids, { user: who, to: `site-${i}@othersite.test` })).body as any).results
      expect(results.map((r: any) => [r.id, r.status === 'skipped' ? r.reason : undefined])).toEqual(rows.map((r: any) => [r.id, r.blocked]))
      went += results.filter((r: any) => r.status === 'sent').length
    }
    // Everything for the session that works on movements, the one transfer for the two that write transfers only.
    expect(went).toBe(3 + 1 + 1)
    await auditOf(w.orgId, went)
  })

  it('takes a hundred ticked movements and no more', async () => {
    const w = await world()
    const ids = Array.from({ length: MAX_SELECTION + 1 }, () => String(new Types.ObjectId()))
    const over = await w.preview(ids)
    expect(over.status).toBe(422)
    expect(over.body).toMatchObject({ code: 'selection_too_large', max: 100 })
    expect((await w.preview(ids.slice(1))).status).toBe(200)
    expect((await w.preview([])).status).toBe(400)
    expect((await w.preview(['', '  '])).status).toBe(400)
  })
})

describe('the two routes, in the whole route table', () => {
  const PREVIEW = '/warehouse/movement/email/preview'
  const MAIL = '/warehouse/movement/email'

  /** Calls as a client makes them, with the session given. */
  function caller(w: World) {
    return async (method: string, path: string, body: unknown, token: string | null, orgId = w.orgId) => {
      const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }))
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
  }

  it('are mounted once each, beside the movement routes that share their prefix', () => {
    const posts = ((app as any).routes as { method: string; path: string }[])
      .filter(r => String(r.method).toUpperCase() === 'POST' && r.path.startsWith('/api/org/:orgId/warehouse/movement'))
      .map(r => r.path.replace(/\/$/, ''))
    expect(posts.filter(p => p === '/api/org/:orgId/warehouse/movement/email')).toHaveLength(1)
    expect(posts.filter(p => p === '/api/org/:orgId/warehouse/movement/email/preview')).toHaveLength(1)
    // The neighbours a parameter could have swallowed them into.
    expect(posts).toContain('/api/org/:orgId/warehouse/movement/:id/confirm')
    expect(posts).toContain('/api/org/:orgId/warehouse/movement')
  })

  it('preview, then mail: the answers the dialog reads, and a movement is still booked next door', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const admin = await member(w.org, 'admin')
    const call = caller(w)
    const docs = [await w.movement('transfer'), await w.movement('transfer', { status: 'draft' })]

    const preview = await call('POST', PREVIEW, { kind: 'movement', ids: docs.map(d => d.id) }, admin.token)
    expect(preview.status).toBe(200)
    expect(preview.json.documents.map((d: any) => [d.id, d.number, d.docType, d.blocked])).toEqual([
      [docs[0]!.id, docs[0]!.number, 'transfer', undefined], [docs[1]!.id, docs[1]!.number, 'transfer', 'draft'],
    ])

    // As the dialog posts it: the rows' ids, and what it has no use for is dropped, not refused.
    const mail = await call('POST', MAIL, { kind: 'movement', to: TO, items: docs.map(d => ({ id: d.id })), locale: 'en', message: 'With the van' }, admin.token)
    expect(mail.status).toBe(200)
    expect(mail.json).toEqual({
      to: TO, mails: 1, queued: false,
      results: [
        { id: docs[0]!.id, number: docs[0]!.number, status: 'sent' },
        { id: docs[1]!.id, number: docs[1]!.number, status: 'skipped', reason: 'draft' },
      ],
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe(`Transfer ${docs[0]!.number} — Example Ltd`)
    expect(sent[0].content[0].value).toContain('With the van')
    expect(String((await EmailLog.findOne({ orgId: w.orgId }).lean() as any).creatorId)).toBe(String(admin.user._id))
    await auditOf(w.orgId, 1)

    // `email` is not an id: the routes with a parameter in its place still answer as they did.
    const draft = await call('POST', '/warehouse/movement', {
      type: 'receipt', date: '2026-11-16', toWarehouseId: String(w.main._id),
      lines: [{ productId: String(w.bolt._id), quantity: 3, unitCost: 5, totalCost: 15 }], totalAmount: 15,
    }, admin.token)
    expect(draft.status).toBe(200)
    const id = draft.json.stockMovement._id || draft.json.stockMovement.id
    const booked = await call('POST', `/warehouse/movement/${id}/confirm`, {}, admin.token)
    expect([booked.status, booked.json?.code]).toEqual([200, undefined])
    const got = await call('GET', `/warehouse/movement/${id}`, undefined, admin.token)
    expect([got.status, got.json?.stockMovement?.type, got.json?.stockMovement?.status]).toEqual([200, 'receipt', 'completed'])
    expect(Number(((await StockLevel.findOne({ orgId: w.orgId, productId: w.bolt._id, warehouseId: w.main._id }).lean()) as any)?.quantity)).toBe(3)
  })

  it('refuse the request only for what is true of all of it, each with what the dialog shows', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const admin = await member(w.org, 'admin')
    const call = caller(w)
    const m = await w.movement('transfer')
    const body = { kind: 'movement', to: TO, items: [{ id: m.id }] }

    expect((await call('POST', MAIL, body, null)).status).toBe(401)
    expect((await call('POST', PREVIEW, { kind: 'movement', ids: [m.id] }, null)).status).toBe(401)
    expect((await call('POST', MAIL, { ...body, to: 'nobody' }, admin.token)).status).toBe(400)
    expect((await call('POST', MAIL, { ...body, items: [] }, admin.token)).status).toBe(400)
    expect((await call('POST', PREVIEW, { kind: 'movement', ids: [] }, admin.token)).status).toBe(400)
    // Another kind's name is not this route's: the body's own fault.
    expect((await call('POST', MAIL, { ...body, kind: 'invoice' }, admin.token)).status).toBe(422)
    expect((await call('POST', PREVIEW, { kind: 'order', ids: [m.id] }, admin.token)).status).toBe(422)

    const eleven = await call('POST', MAIL, { ...body, items: Array.from({ length: 11 }, () => ({ id: String(new Types.ObjectId()) })) }, admin.token)
    expect(eleven.status).toBe(422)
    expect(eleven.json).toMatchObject({ code: 'selection_too_large', max: 10 })
    const many = await call('POST', PREVIEW, { kind: 'movement', ids: Array.from({ length: 101 }, () => String(new Types.ObjectId())) }, admin.token)
    expect(many.status).toBe(422)
    expect(many.json).toMatchObject({ code: 'selection_too_large', max: 100 })

    ;(config.email as any).sendgridApiKey = ''
    const unconfigured = await call('POST', MAIL, body, admin.token)
    expect(unconfigured.status).toBe(503)
    expect(unconfigured.json).toEqual({ code: 'not_configured', message: 'Email is not configured on this server' })
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
  })

  it('a role that mails no movement is refused before its body is read: 403, never the body\'s shape', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const call = caller(w)
    const m = await w.movement('transfer')
    // They read the movements and work on none; the last reads none at all.
    for (const role of ['member', 'accountant', 'nra_auditor', 'hr_manager']) {
      const who = await member(w.org, role)
      for (const path of [MAIL, PREVIEW]) {
        const empty = await call('POST', path, {}, who.token)
        expect([role, path, empty.status, empty.json?.code]).toEqual([role, path, 403, 'permission_required'])
      }
      expect((await call('POST', MAIL, { kind: 'movement', to: TO, items: [{ id: m.id }] }, who.token)).status).toBe(403)
      expect((await call('POST', PREVIEW, { kind: 'movement', ids: [m.id] }, who.token)).status).toBe(403)
    }
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
    // The same body from a role that mails is the body's own fault.
    const admin = await member(w.org, 'admin')
    for (const path of [MAIL, PREVIEW]) expect([path, (await call('POST', path, {}, admin.token)).status]).toEqual([path, 422])
  })

  it('a Seller\'s session mails a transfer and is refused a receipt; a warehouse manager\'s mails both', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const seller = await member(w.org, 'seller', 'Seller')
    const keeper = await member(w.org, 'warehouse_manager')
    const call = caller(w)
    const transfer = await w.movement('transfer')
    const receipt = await w.movement('receipt')
    const ids = [transfer.id, receipt.id]

    const preview = await call('POST', PREVIEW, { kind: 'movement', ids }, seller.token)
    expect([preview.status, preview.json?.code]).toEqual([200, undefined])
    expect(preview.json.documents.map((d: any) => [d.id, d.number, d.blocked])).toEqual([
      [transfer.id, transfer.number, undefined], [receipt.id, receipt.number, 'forbidden'],
    ])
    const mail = await call('POST', MAIL, { kind: 'movement', to: TO, items: ids.map(id => ({ id })) }, seller.token)
    expect(mail.status).toBe(200)
    expect(mail.json.results).toEqual([
      { id: transfer.id, number: transfer.number, status: 'sent' },
      { id: receipt.id, number: receipt.number, status: 'skipped', reason: 'forbidden' },
    ])
    expect(sent.map(m => m.attachments.map((a: any) => a.filename))).toEqual([[`${transfer.number}.pdf`]])
    expect(printed).toEqual([transfer.id])
    const log: any = await EmailLog.findOne({ orgId: w.orgId }).lean()
    expect([String(log.creatorId), String(log.entityId), log.entityType]).toEqual([String(seller.user._id), transfer.id, 'stock_movement'])

    // Whoever works on every movement mails every type.
    const all = await call('POST', MAIL, { kind: 'movement', to: 'accounts@example.test', items: ids.map(id => ({ id })) }, keeper.token)
    expect(all.json.results.map((r: any) => r.status)).toEqual(['sent', 'sent'])
    expect(sent[1].attachments.map((a: any) => a.filename)).toEqual([`${transfer.number}.pdf`, `${receipt.number}.pdf`])
    await auditOf(w.orgId, 3)
  })

  it('another organization\'s session is refused by the tenant guard, as on every route', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const outsider = await member(other.org, 'admin')
    const m = await w.movement('transfer')
    const call = caller(w)

    expect((await call('POST', PREVIEW, { kind: 'movement', ids: [m.id] }, outsider.token)).status).toBe(403)
    expect((await call('POST', MAIL, { kind: 'movement', to: TO, items: [{ id: m.id }] }, outsider.token)).status).toBe(403)
    // In its own organization the same id names nothing.
    const own = await call('POST', PREVIEW, { kind: 'movement', ids: [m.id] }, outsider.token, other.orgId)
    expect(own.json.documents).toEqual([{ id: m.id, number: '', docType: '', blocked: 'not_found' }])
    const mailed = await call('POST', MAIL, { kind: 'movement', to: TO, items: [{ id: m.id }] }, outsider.token, other.orgId)
    expect(mailed.json).toEqual({ to: TO, mails: 0, queued: false, results: [{ id: m.id, number: '', status: 'skipped', reason: 'not_found' }] })
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
  })
})
