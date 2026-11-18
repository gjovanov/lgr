import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { AuditLog, EmailLog, Invoice, Order, Org, Outbox } from 'db/models'
import { templateGrant, type CapabilityId, type Grant } from 'config/access'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { MAX_DOCS_PER_MAIL, MAX_SELECTION, chunkDocuments, planForOneAddress } from 'config/doc-email'
import { drainOne } from 'services/biz/relay/outbox-worker'
import { docEmailController } from 'invoicing-api/src/controllers/doc-email.controller'
import { docEmailRenderers, previewDocEmail, sendDocEmail } from 'invoicing-api/src/lib/doc-email'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'

/**
 * The ticked documents of a list, by e-mail (2026-11-16): `POST invoicing/export/email/preview` and
 * `POST invoicing/export/email`, for the invoice collection and for supplier orders.
 *
 * The provider is faked (`fetch`), and so is the printing: a render is a fresh Chrome, and what is asked here is
 * who gets which file, what is logged about each document and what a mailed document then says of itself. The
 * files themselves are the export suites' business, and the builder they are printed from is the real one.
 *
 * NOTE: no `.rejects` / `.resolves` (they deadlock the Windows runner).
 */

const { Types } = mongoose
const TO = 'customer@buyer.test'
const realFetch = globalThis.fetch
const saved = {
  key: config.email.sendgridApiKey, role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile,
  invoice: docEmailRenderers.invoice, orderSheet: docEmailRenderers.orderSheet,
}
let tmp = ''
/** What was printed, in order: an invoice's id, or an order sheet's context. */
let printed: any[] = []

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

afterEach(async () => {
  globalThis.fetch = realFetch
  ;(config.email as any).sendgridApiKey = saved.key
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  docEmailRenderers.invoice = saved.invoice
  docEmailRenderers.orderSheet = saved.orderSheet
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

/** Printing, faked: a file that names its document, so a test can tell whose it is. */
function fakePrinting(opts: { failing?: Set<string> } = {}) {
  docEmailRenderers.invoice = (async (orgId: string, id: string) => {
    printed.push(id)
    const invoice: any = await Invoice.findOne({ _id: id, orgId }).lean()
    if (!invoice) return { ok: false, status: 404, message: 'Document not found' }
    if (opts.failing?.has(id)) return { ok: false, status: 503, message: 'PDF renderer unavailable' }
    return { ok: true, buffer: Buffer.from(`%PDF ${invoice.invoiceNumber}`), filename: `${invoice.invoiceNumber}.pdf`, invoice }
  }) as any
  docEmailRenderers.orderSheet = (async (ctx: any, variant: string) => {
    printed.push({ ctx, variant })
    return Buffer.from(`%PDF ${ctx.order.orderNumber} ${ctx.supplierName} ${variant}`)
  }) as any
}

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
const bytesOf = (attachment: any) => Buffer.from(attachment.content, 'base64').toString()

/** `createAuditEntry` does not wait for its write: neither does a test that reads it. */
async function auditOf(orgId: string, want: number): Promise<any[]> {
  for (let i = 0; i < 60; i++) {
    const rows = await AuditLog.find({ orgId, action: 'email' }).lean()
    if (rows.length >= want) return rows
    await new Promise(r => setTimeout(r, 50))
  }
  return AuditLog.find({ orgId, action: 'email' }).lean()
}

async function world() {
  const org = await createTestOrg({ name: 'Example Ltd' } as any)
  // On an organization's own server its home is recorded before anything else is written for it.
  await homeNewOrg(org._id)
  await Org.updateOne({ _id: org._id }, { $set: { email: 'office@example.test' } })
  const orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin' } as any)
  // FR-27 P3-6: the session the controller decides by carries its role's grant, here the Administrator's.
  const user = { id: String(admin._id), access: templateGrant('admin') }
  const contact = await createTestContact(org._id, { companyName: 'Buyer One', email: 'accounts@buyer.test' } as any)
  let seq = 0
  /** An issued sales invoice, unless told otherwise. */
  async function doc(extra: Record<string, any> = {}) {
    const d: any = await createTestInvoice(org._id, (extra.contactId ?? contact._id) as any, {
      invoiceNumber: `INV-${String(++seq).padStart(5, '0')}`, status: 'sent', total: 1180, ...extra,
    } as any)
    return { id: String(d._id), number: d.invoiceNumber as string }
  }
  const mail = (items: Array<{ id: string; groupId?: string }>, over: Record<string, any> = {}) =>
    sendDocEmail({ orgId, user, kind: 'invoice', to: TO, items, locale: 'en', ...over } as any)
  return { org, orgId, user, contact, doc, mail }
}

type World = Awaited<ReturnType<typeof world>>

/** A supplier order of two groups, issued: one sheet per supplier. */
async function anOrder(w: World, extra: Record<string, any> = {}) {
  const alfa = await createTestContact(w.org._id, { type: 'supplier', companyName: 'Alfa Supply', email: 'sales@alfa.test' } as any)
  const beta = await createTestContact(w.org._id, { type: 'supplier', companyName: 'Beta Supply', email: '' } as any)
  const product = await createTestProduct(w.org._id)
  const line = (quantity: number) => ({
    productId: product._id, description: product.name, sku: product.sku, quantity, unit: 'pcs', expectedUnitPrice: 7.5, allocations: [],
  })
  const order: any = await Order.create({
    orgId: w.org._id,
    orderNumber: 'ORDO-00007',
    status: 'sent',
    statusHistory: [{ status: 'sent', changedAt: new Date() }],
    issueDate: new Date('2026-11-16T00:00:00Z'),
    currency: 'EUR',
    exchangeRate: 1,
    supplierGroups: [{ supplierId: alfa._id, lines: [line(10)] }, { supplierId: beta._id, lines: [line(4)] }],
    createdBy: new Types.ObjectId(),
    ...extra,
  } as any)
  const [g1, g2] = order.supplierGroups.map((g: any) => String(g._id))
  return { id: String(order._id), g1, g2, alfa, beta }
}

describe('several invoices to one address', () => {
  it('three issued invoices are ONE mail of three files, and each document has its own log row and history', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const docs = [await w.doc(), await w.doc(), await w.doc({ type: 'credit_note' })]

    const reply = await w.mail(docs.map(d => ({ id: d.id })), { message: 'Thank you' })

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
    // The note lists them, each by its own word, above the person's message.
    const html: string = sent[0].content[0].value
    expect(html).toContain('Please find attached 3 documents:')
    for (const d of docs) expect(html).toContain(`<strong>${d.number}</strong>`)
    expect(html).toContain('Credit Note')
    expect(html).toContain('1180.00 EUR')
    expect(html.indexOf(docs[2]!.number)).toBeLessThan(html.indexOf('Thank you'))

    // A log row per document: its own id and its own file, the mail's recipient and subject.
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).lean()
    expect(logs).toHaveLength(3)
    for (const d of docs) {
      const row = logs.find(l => String(l.entityId) === d.id)
      expect(row).toMatchObject({ entityType: 'invoice', to: TO, status: 'sent', subject: '3 documents — Example Ltd', attachmentNames: [`${d.number}.pdf`] })
      expect(String(row.creatorId)).toBe(w.user.id)
    }
    // Each invoice says it was mailed, and to whom.
    for (const d of docs) {
      const invoice: any = await Invoice.findById(d.id).lean()
      expect(invoice.emailedTo).toEqual([TO])
      expect(invoice.lastEmailedAt).toBeInstanceOf(Date)
    }
    // And an audit entry each.
    const audit = await auditOf(w.orgId, 3)
    expect(audit.map(a => String(a.entityId)).sort()).toEqual(docs.map(d => d.id).sort())
    expect(audit.every(a => a.module === 'invoicing' && a.entityType === 'invoice' && String(a.userId) === w.user.id)).toBe(true)
  })

  it('one invoice reads as the single route\'s mail does, and takes the subject the dialog gives', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const d = await w.doc()

    await w.mail([{ id: d.id }])
    await w.mail([{ id: (await w.doc()).id }], { subject: '  Your documents  ', columns: ['description', 'quantity'] })

    expect(sent).toHaveLength(2)
    expect(sent[0].subject).toBe(`Invoices ${d.number} — Example Ltd`)
    expect(sent[0].content[0].value).toContain(`Please find attached <strong>Invoices ${d.number}</strong>.`)
    expect(sent[1].subject).toBe('Your documents')
    await auditOf(w.orgId, 2)
  })

  it('a draft and an id that names nothing here are skipped, and the rest go', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const issued = await w.doc()
    const draft = await w.doc({ status: 'draft', invoiceNumber: 'DRF-INV-00001' })
    const foreign = await other.doc()
    const nowhere = String(new Types.ObjectId())

    const reply = await w.mail([{ id: issued.id }, { id: draft.id }, { id: foreign.id }, { id: 'not-an-id' }, { id: nowhere }, { id: issued.id }])

    expect(reply.status).toBe(200)
    expect((reply.body as any).results).toEqual([
      { id: issued.id, number: issued.number, status: 'sent' },
      { id: draft.id, number: 'DRF-INV-00001', status: 'skipped', reason: 'draft' },
      // Another organization's document, a string that is no id and an id of nothing are one answer, with no number.
      { id: foreign.id, number: '', status: 'skipped', reason: 'not_found' },
      { id: 'not-an-id', number: '', status: 'skipped', reason: 'not_found' },
      { id: nowhere, number: '', status: 'skipped', reason: 'not_found' },
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual([`${issued.number}.pdf`])
    // Only what goes is printed, and only what went is logged.
    expect(printed).toEqual([issued.id])
    expect(await EmailLog.countDocuments({})).toBe(1)
    expect(((await Invoice.findById(foreign.id).lean()) as any).emailedTo ?? []).toEqual([])
    expect(((await Invoice.findById(draft.id).lean()) as any).emailedTo ?? []).toEqual([])
    await auditOf(w.orgId, 1)
  })

  it('a supplier\'s bill goes, which the single route never took', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const supplier = await createTestContact(w.org._id, { type: 'supplier', companyName: 'Alfa Supply' } as any)
    const bill = await w.doc({ direction: 'incoming', status: 'received', contactId: supplier._id, invoiceNumber: 'BILL-00001' })

    const reply = await w.mail([{ id: bill.id }], { to: 'accountant@books.test' })

    expect((reply.body as any).results).toEqual([{ id: bill.id, number: 'BILL-00001', status: 'sent' }])
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual(['BILL-00001.pdf'])
    expect(sent[0].personalizations[0].to).toEqual([{ email: 'accountant@books.test' }])
    await auditOf(w.orgId, 1)
  })

  it('held to the session\'s kinds: a kind it does not read is not found, one it only reads is forbidden', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const invoice = await w.doc()
    const bill = await w.doc({ direction: 'incoming', status: 'received' })
    const proforma = await w.doc({ type: 'proforma' })
    // Works on bills, reads sales documents, and has nothing to do with quotes.
    const buyer = { id: w.user.id, role: 'member', permissions: [], access: caps('bills.view', 'bills.edit', 'sales-docs.view') }

    const reply = await w.mail([{ id: invoice.id }, { id: bill.id }, { id: proforma.id }], { user: buyer })

    expect((reply.body as any).results).toEqual([
      { id: invoice.id, number: invoice.number, status: 'skipped', reason: 'forbidden' },
      { id: bill.id, number: bill.number, status: 'sent' },
      { id: proforma.id, number: '', status: 'skipped', reason: 'not_found' },
    ])
    expect(sent).toHaveLength(1)
    // A session that works on no kind is refused outright.
    const reader = { id: w.user.id, role: 'member', permissions: [], access: caps('sales-docs.view', 'bills.view', 'proforma.view') }
    expect((await w.mail([{ id: invoice.id }], { user: reader })).status).toBe(403)
    expect((await previewDocEmail({ orgId: w.orgId, user: reader, kind: 'invoice', ids: [invoice.id] })).status).toBe(403)
    await auditOf(w.orgId, 1)
  })

  it('the same document to the same address inside a minute is a double click; another address, and a retry of a failure, go', async () => {
    fakePrinting()
    const w = await world()
    const a = await w.doc()
    const b = await w.doc()

    let sent = fakeSendGrid()
    expect((await w.mail([{ id: a.id }])).body).toMatchObject({ mails: 1, results: [{ status: 'sent' }] })
    // Again, with a document that has not gone: only that one goes.
    const again = await w.mail([{ id: a.id }, { id: b.id }])
    expect((again.body as any).results).toEqual([
      { id: a.id, number: a.number, status: 'skipped', reason: 'just_sent' },
      { id: b.id, number: b.number, status: 'sent' },
    ])
    expect(sent).toHaveLength(2)
    expect(sent[1].attachments).toHaveLength(1)
    // To somebody else it goes.
    expect((await w.mail([{ id: a.id }], { to: 'colleague@example.test' })).body).toMatchObject({ mails: 1, results: [{ status: 'sent' }] })
    expect(((await Invoice.findById(a.id).lean()) as any).emailedTo).toEqual([TO, 'colleague@example.test'])

    // A FAILED attempt is no block: the failure is why the person asks again.
    const c = await w.doc()
    fakeSendGrid(500)
    expect((await w.mail([{ id: c.id }])).body).toMatchObject({ mails: 0, results: [{ status: 'failed', reason: 'provider_error' }] })
    sent = fakeSendGrid()
    expect((await w.mail([{ id: c.id }])).body).toMatchObject({ mails: 1, results: [{ status: 'sent' }] })
    expect(sent).toHaveLength(1)
    await auditOf(w.orgId, 4)
  })

  it('twelve ticked documents are two requests and two mails; one request takes no more than ten', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const docs = []
    for (let i = 0; i < 12; i++) docs.push(await w.doc())

    const preview = await previewDocEmail({ orgId: w.orgId, user: w.user, kind: 'invoice', ids: docs.map(d => d.id) })
    const plan = planForOneAddress((preview.body as any).documents, TO)
    const requests = chunkDocuments(plan.entries[0]!.rows)
    expect(requests.map(r => r.length)).toEqual([10, 2])
    const replies = []
    for (const rows of requests) replies.push(await w.mail(rows.map(r => ({ id: r.id }))))

    expect(replies.map(r => (r.body as any).mails)).toEqual([1, 1])
    expect(sent.map(m => m.attachments.length)).toEqual([10, 2])
    expect(sent.flatMap(m => m.attachments.map((a: any) => a.filename))).toEqual(docs.map(d => `${d.number}.pdf`))
    expect(await EmailLog.countDocuments({ orgId: w.orgId, status: 'sent' })).toBe(12)

    const over = await w.mail(docs.slice(0, MAX_DOCS_PER_MAIL + 1).map(d => ({ id: d.id })), { to: 'other@example.test' })
    expect(over.status).toBe(422)
    expect(over.body).toMatchObject({ code: 'selection_too_large', max: 10 })
    expect(sent).toHaveLength(2)
    await auditOf(w.orgId, 12)
  })

  it('a provider failure fails every document of the mail, logs it, and leaves their history alone', async () => {
    const sent = fakeSendGrid(500)
    fakePrinting()
    const w = await world()
    const docs = [await w.doc(), await w.doc()]

    const reply = await w.mail(docs.map(d => ({ id: d.id })))

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ mails: 0, queued: false })
    for (const [i, d] of docs.entries()) {
      expect((reply.body as any).results[i]).toMatchObject({ id: d.id, number: d.number, status: 'failed', reason: 'provider_error' })
      expect((reply.body as any).results[i].message).toContain('SendGrid 500')
    }
    expect(sent).toHaveLength(1)
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).lean()
    expect(logs.map(l => l.status)).toEqual(['failed', 'failed'])
    expect(logs.map(l => String(l.entityId)).sort()).toEqual(docs.map(d => d.id).sort())
    for (const d of docs) {
      const invoice: any = await Invoice.findById(d.id).lean()
      expect(invoice.emailedTo ?? []).toEqual([])
      expect(invoice.lastEmailedAt).toBeUndefined()
    }
    // Nothing went, so nothing is in the audit log.
    await new Promise(r => setTimeout(r, 200))
    expect(await AuditLog.countDocuments({ orgId: w.orgId, action: 'email' })).toBe(0)
  })

  it('a document that cannot be printed is dropped alone', async () => {
    const sent = fakeSendGrid()
    const w = await world()
    const docs = [await w.doc(), await w.doc(), await w.doc()]
    fakePrinting({ failing: new Set([docs[1]!.id]) })

    const reply = await w.mail(docs.map(d => ({ id: d.id })))

    expect((reply.body as any).results).toEqual([
      { id: docs[0]!.id, number: docs[0]!.number, status: 'sent' },
      { id: docs[1]!.id, number: docs[1]!.number, status: 'failed', reason: 'render_failed', message: 'PDF renderer unavailable' },
      { id: docs[2]!.id, number: docs[2]!.number, status: 'sent' },
    ])
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual([`${docs[0]!.number}.pdf`, `${docs[2]!.number}.pdf`])
    expect(sent[0].subject).toBe('2 documents — Example Ltd')
    expect(((await Invoice.findById(docs[1]!.id).lean()) as any).emailedTo ?? []).toEqual([])
    await auditOf(w.orgId, 2)
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
    const d = await w.doc()

    const reply = await w.mail([{ id: d.id }])

    expect(reply.status).toBe(503)
    expect(reply.body).toEqual({ code: 'not_configured', message: 'Email is not configured on this server' })
    expect(called).toBe(false)
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
    expect(((await Invoice.findById(d.id).lean()) as any).emailedTo ?? []).toEqual([])
  })

  it('the request itself is refused for an address that is none, an empty list, and nothing else', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const d = await w.doc()
    expect((await w.mail([{ id: d.id }], { to: 'nobody' })).status).toBe(400)
    expect((await w.mail([{ id: d.id }], { to: '' })).status).toBe(400)
    expect((await w.mail([])).status).toBe(400)
    expect((await w.mail([{ id: '  ' }])).status).toBe(400)
    expect(printed).toEqual([])
  })
})

describe('on an organization\'s own server', () => {
  const NODE = 'master-docemailtestaaa'.padEnd(23, 'a')

  it('the mail is queued with its documents, and each invoice\'s history changes when it has gone', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lgr-doc-email-'))
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = NODE
    ;(config.email as any).sendgridApiKey = ''
    fakePrinting()
    const w = await world()
    const docs = [await w.doc(), await w.doc()]

    const reply = await w.mail(docs.map(d => ({ id: d.id })))

    // Queued, and said so: never "sent" while the mail waits for lgrai.app.
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ to: TO, mails: 1, queued: true, results: docs.map(d => ({ id: d.id, number: d.number, status: 'queued' })) })
    const item: any = await Outbox.findOne({ orgId: w.orgId }).lean()
    expect(item.state).toBe('queued')
    expect(item.payload.attachments.map((a: any) => a.filename)).toEqual(docs.map(d => `${d.number}.pdf`))
    expect(item.payload.entities).toEqual(docs.map(d => ({ entityType: 'invoice', entityId: d.id, attachmentName: `${d.number}.pdf` })))
    const queued: any[] = await EmailLog.find({ outboxId: item._id }).lean()
    expect(queued.map(l => l.status)).toEqual(['queued', 'queued'])
    expect(queued.map(l => String(l.entityId)).sort()).toEqual(docs.map(d => d.id).sort())
    for (const d of docs) expect(((await Invoice.findById(d.id).lean()) as any).emailedTo ?? []).toEqual([])
    // A second click while it waits would queue a second mail: it is the double click too.
    expect((await w.mail([{ id: docs[0]!.id }])).body).toMatchObject({ mails: 0, results: [{ status: 'skipped', reason: 'just_sent' }] })
    await auditOf(w.orgId, 2)

    // lgrai.app sends it.
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
    for (const d of docs) {
      const invoice: any = await Invoice.findById(d.id).lean()
      expect(invoice.emailedTo).toEqual([TO])
      expect(invoice.lastEmailedAt).toBeInstanceOf(Date)
    }
    // The bytes go once it is done; which documents it carried stays.
    const done: any = await Outbox.findById(item._id).lean()
    expect(done.state).toBe('sent')
    expect(done.payload.attachments).toBeUndefined()
    expect(done.payload.html).toBeUndefined()
    expect(done.payload.entities).toHaveLength(2)
  })
})

describe('supplier orders', () => {
  it('each supplier group is a sheet of its own, the supplier variant, and a draft order sends none', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const order = await anOrder(w)
    const draft = await anOrder(w, { orderNumber: 'DRF-ORDO-00001', status: 'draft' })
    const mail = (items: any[], over: Record<string, any> = {}) => w.mail(items, { kind: 'order', ...over })

    const preview = await previewDocEmail({ orgId: w.orgId, user: w.user, kind: 'order', ids: [order.id, draft.id, 'not-an-id'] })
    expect(preview.status).toBe(200)
    expect((preview.body as any).documents).toEqual([
      {
        id: order.id, groupId: order.g1, number: 'ORDO-00007', docType: 'order', date: '2026-11-16T00:00:00.000Z', status: 'sent',
        partner: { id: String(order.alfa._id), name: 'Alfa Supply', email: 'sales@alfa.test' },
      },
      // A supplier with no address on its card: the dialog's line starts empty.
      {
        id: order.id, groupId: order.g2, number: 'ORDO-00007', docType: 'order', date: '2026-11-16T00:00:00.000Z', status: 'sent',
        partner: { id: String(order.beta._id), name: 'Beta Supply' },
      },
      expect.objectContaining({ id: draft.id, groupId: draft.g1, number: 'DRF-ORDO-00001', blocked: 'draft' }),
      expect.objectContaining({ id: draft.id, groupId: draft.g2, blocked: 'draft' }),
      { id: 'not-an-id', number: '', docType: '', blocked: 'not_found' },
    ])

    const reply = await mail([
      { id: order.id, groupId: order.g1 }, { id: order.id, groupId: order.g2 },
      { id: draft.id, groupId: draft.g1 }, { id: order.id }, { id: order.id, groupId: draft.g1 },
    ])

    expect(reply.status).toBe(200)
    expect((reply.body as any).results).toEqual([
      { id: order.id, groupId: order.g1, number: 'ORDO-00007', status: 'sent' },
      { id: order.id, groupId: order.g2, number: 'ORDO-00007', status: 'sent' },
      { id: draft.id, groupId: draft.g1, number: 'DRF-ORDO-00001', status: 'skipped', reason: 'draft' },
      // No group named, and a group of another order: no such sheet.
      { id: order.id, number: '', status: 'skipped', reason: 'not_found' },
      { id: order.id, groupId: draft.g1, number: '', status: 'skipped', reason: 'not_found' },
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('2 documents — Example Ltd')
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual(['ORDO-00007-1.pdf', 'ORDO-00007-2.pdf'])
    expect(sent[0].attachments.map(bytesOf)).toEqual(['%PDF ORDO-00007 Alfa Supply supplier', '%PDF ORDO-00007 Beta Supply supplier'])
    // Printed from the builder the Export button uses: the group's own lines, the supplier variant. Two sheets are
    // printed at a time, so which of them reaches the printer first is not this test's to say.
    const sheetOf = (groupId: string) => printed.find(p => String(p.ctx.group._id) === groupId)
    expect(printed).toHaveLength(2)
    expect([order.g1, order.g2].map(g => [sheetOf(g)?.variant, sheetOf(g)?.ctx.org.name])).toEqual([
      ['supplier', 'Example Ltd'], ['supplier', 'Example Ltd'],
    ])
    expect(sheetOf(order.g1).ctx.group.lines[0].expectedUnitPrice).toBe(7.5)
    expect(sheetOf(order.g1).ctx.reservations).toEqual({})
    // Logged against the ORDER, each row naming its sheet.
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).sort({ attachmentNames: 1 }).lean()
    expect(logs.map(l => [l.entityType, String(l.entityId), l.attachmentNames, l.status])).toEqual([
      ['order', order.id, ['ORDO-00007-1.pdf'], 'sent'], ['order', order.id, ['ORDO-00007-2.pdf'], 'sent'],
    ])
    const audit = await auditOf(w.orgId, 2)
    expect(audit.every(a => a.entityType === 'order' && String(a.entityId) === order.id && a.entityName === 'ORDO-00007')).toBe(true)

    // The double click is per SHEET: the other sheet of the same order to the same address still goes.
    await EmailLog.deleteOne({ attachmentNames: 'ORDO-00007-2.pdf' })
    const again = await mail([{ id: order.id, groupId: order.g1 }, { id: order.id, groupId: order.g2 }])
    expect((again.body as any).results).toEqual([
      { id: order.id, groupId: order.g1, number: 'ORDO-00007', status: 'skipped', reason: 'just_sent' },
      { id: order.id, groupId: order.g2, number: 'ORDO-00007', status: 'sent' },
    ])
    await auditOf(w.orgId, 3)
  })

  it('one sheet alone is named as one, and an order of one group needs no suffix', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const order = await anOrder(w)
    await Order.updateOne({ _id: order.id }, { $pull: { supplierGroups: { _id: order.g2 } } })

    const reply = await w.mail([{ id: order.id, groupId: order.g1 }], { kind: 'order', to: 'sales@alfa.test', locale: 'bg' })

    expect((reply.body as any).results).toEqual([{ id: order.id, groupId: order.g1, number: 'ORDO-00007', status: 'sent' }])
    expect(sent[0].subject).toBe('Поръчка за доставка ORDO-00007 — Example Ltd')
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual(['ORDO-00007.pdf'])
    expect(sent[0].content[0].value).toContain('Прикачено ще намерите <strong>Поръчка за доставка ORDO-00007</strong>.')
    await auditOf(w.orgId, 1)
  })

  it('a role without the cost figures mails a sheet with no expected price, and one that only reads orders mails none', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const order = await anOrder(w)
    const items = [{ id: order.id, groupId: order.g1 }]
    const buyer = { id: w.user.id, role: 'member', permissions: [], access: caps('orders.view', 'orders.edit', 'sales-docs.export') }

    const reply = await w.mail(items, { kind: 'order', user: buyer })

    expect((reply.body as any).results).toEqual([{ id: order.id, groupId: order.g1, number: 'ORDO-00007', status: 'sent' }])
    expect(printed).toHaveLength(1)
    expect(printed[0].ctx.group.lines[0].quantity).toBe(10)
    expect('expectedUnitPrice' in printed[0].ctx.group.lines[0]).toBe(false)
    expect(printed[0].ctx.order.supplierGroups.flatMap((g: any) => g.lines).some((l: any) => 'expectedUnitPrice' in l)).toBe(false)

    // What the sheet's export would answer 403, and a role that only reads orders: refused outright, both routes.
    for (const access of [caps('orders.view', 'orders.edit'), caps('orders.view', 'sales-docs.export'), caps('sales-docs.view', 'sales-docs.edit')]) {
      const who = { id: w.user.id, role: 'member', permissions: [], access }
      expect((await w.mail(items, { kind: 'order', user: who, to: 'x@example.test' })).status).toBe(403)
      expect((await previewDocEmail({ orgId: w.orgId, user: who, kind: 'order', ids: [order.id] })).status).toBe(403)
    }
    expect(printed).toHaveLength(1)
    await auditOf(w.orgId, 1)
  })
})

describe('the preview', () => {
  it('names each document and its partner, says why one will not go, and writes nothing', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const issued = await w.doc({ issueDate: new Date('2026-11-10T00:00:00Z') })
    const draft = await w.doc({ status: 'draft', invoiceNumber: 'DRF-INV-00001' })
    const quiet = await createTestContact(w.org._id, { companyName: '', firstName: 'Ana', lastName: 'Buyer', email: '  ' } as any)
    const offer = await w.doc({ type: 'offer', contactId: quiet._id })
    const bill = await w.doc({ direction: 'incoming', status: 'received' })
    const till = await w.doc({ type: 'cash_sale', status: 'paid' })
    await Invoice.collection.updateOne({ _id: new Types.ObjectId(till.id) }, { $unset: { contactId: 1 } })
    const foreign = await other.doc()

    const reply = await previewDocEmail({
      orgId: w.orgId, user: w.user, kind: 'invoice',
      ids: [issued.id, draft.id, offer.id, bill.id, till.id, foreign.id, issued.id, 'nope'],
    })

    expect(reply.status).toBe(200)
    const buyer = { id: String(w.contact._id), name: 'Buyer One', email: 'accounts@buyer.test' }
    expect((reply.body as any).documents).toEqual([
      { id: issued.id, number: issued.number, docType: 'invoice', date: '2026-11-10T00:00:00.000Z', status: 'sent', partner: buyer },
      expect.objectContaining({ id: draft.id, number: 'DRF-INV-00001', docType: 'invoice', status: 'draft', partner: buyer, blocked: 'draft' }),
      // A partner with no address on its card: named, and the dialog's line starts empty.
      expect.objectContaining({ id: offer.id, docType: 'offer', partner: { id: String(quiet._id), name: 'Ana Buyer' } }),
      expect.objectContaining({ id: bill.id, docType: 'bill', status: 'received', partner: buyer }),
      expect.objectContaining({ id: till.id, docType: 'cash_sale', status: 'paid' }),
      { id: foreign.id, number: '', docType: '', blocked: 'not_found' },
      { id: 'nope', number: '', docType: '', blocked: 'not_found' },
    ])
    expect('partner' in (reply.body as any).documents[4]).toBe(false)
    expect(await EmailLog.countDocuments({})).toBe(0)
    expect(await Outbox.countDocuments({})).toBe(0)
    expect(printed).toEqual([])
    await new Promise(r => setTimeout(r, 100))
    expect(await AuditLog.countDocuments({ action: 'email' })).toBe(0)
  })

  it('takes a hundred ticked documents and no more', async () => {
    const w = await world()
    const ids = Array.from({ length: MAX_SELECTION + 1 }, () => String(new Types.ObjectId()))
    const over = await previewDocEmail({ orgId: w.orgId, user: w.user, kind: 'invoice', ids })
    expect(over.status).toBe(422)
    expect(over.body).toMatchObject({ code: 'selection_too_large', max: 100 })
    expect((await previewDocEmail({ orgId: w.orgId, user: w.user, kind: 'invoice', ids: ids.slice(1) })).status).toBe(200)
    expect((await previewDocEmail({ orgId: w.orgId, user: w.user, kind: 'invoice', ids: [] })).status).toBe(400)
  })
})

describe('the two routes', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  const app = new Elysia().onError(spaErrorHandler({}) as any).use(docEmailController)

  async function session(w: World, role: 'admin' | 'member') {
    const person = role === 'admin' ? { _id: w.user.id } : await createTestUser(w.org._id, { role } as any)
    const token = await (signer as any).decorator.jwt.sign({
      id: String(person._id), orgId: w.orgId, role, email: `${role}@test.com`, username: role,
      firstName: 'Test', lastName: 'User', permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
    })
    return async (path: string, body: unknown, opts: { anonymous?: boolean; orgId?: string } = {}) => {
      const res = await app.handle(new Request(`http://localhost/org/${opts.orgId ?? w.orgId}/invoicing/export/email${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.anonymous ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
      }))
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
  }

  it('preview, then mail: the answers the dialog reads', async () => {
    const sent = fakeSendGrid()
    fakePrinting()
    const w = await world()
    const post = await session(w, 'admin')
    const docs = [await w.doc(), await w.doc({ status: 'draft', invoiceNumber: 'DRF-INV-00001' })]

    const preview = await post('/preview', { kind: 'invoice', ids: docs.map(d => d.id) })
    expect(preview.status).toBe(200)
    expect(preview.json.documents.map((d: any) => [d.id, d.blocked])).toEqual([[docs[0]!.id, undefined], [docs[1]!.id, 'draft']])

    const mail = await post('', { kind: 'invoice', to: TO, items: docs.map(d => ({ id: d.id })), locale: 'en', columns: ['description', 'quantity'] })
    expect(mail.status).toBe(200)
    expect(mail.json).toEqual({
      to: TO, mails: 1, queued: false,
      results: [
        { id: docs[0]!.id, number: docs[0]!.number, status: 'sent' },
        { id: docs[1]!.id, number: 'DRF-INV-00001', status: 'skipped', reason: 'draft' },
      ],
    })
    expect(sent).toHaveLength(1)
    await auditOf(w.orgId, 1)
  })

  it('refuse the request only for what is true of all of it, each with what the dialog shows', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const post = await session(w, 'admin')
    const d = await w.doc()
    const body = { kind: 'invoice', to: TO, items: [{ id: d.id }] }

    expect((await post('', body, { anonymous: true })).status).toBe(401)
    expect((await post('/preview', { kind: 'invoice', ids: [d.id] }, { anonymous: true })).status).toBe(401)
    expect((await post('', { ...body, to: 'nobody' })).status).toBe(400)
    expect((await post('', { ...body, items: [] })).status).toBe(400)
    const unknownColumn = await post('', { ...body, columns: ['no-such-column'] })
    expect(unknownColumn.status).toBe(400)
    expect(unknownColumn.json.message).toContain('no-such-column')
    // A kind that prints no columns ignores them.
    expect((await post('', { kind: 'order', to: TO, items: [{ id: d.id }], columns: ['no-such-column'] })).status).toBe(200)

    const eleven = await post('', { ...body, items: Array.from({ length: 11 }, () => ({ id: String(new Types.ObjectId()) })) })
    expect(eleven.status).toBe(422)
    expect(eleven.json).toMatchObject({ code: 'selection_too_large', max: 10 })
    const many = await post('/preview', { kind: 'invoice', ids: Array.from({ length: 101 }, () => String(new Types.ObjectId())) })
    expect(many.status).toBe(422)
    expect(many.json).toMatchObject({ code: 'selection_too_large', max: 100 })

    ;(config.email as any).sendgridApiKey = ''
    const unconfigured = await post('', body)
    expect(unconfigured.status).toBe(503)
    expect(unconfigured.json).toEqual({ code: 'not_configured', message: 'Email is not configured on this server' })
    expect(printed).toEqual([])
    expect(await EmailLog.countDocuments({})).toBe(0)
  })

  it('a read-only role is refused before its body is read: 403, never the body\'s shape', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const post = await session(w, 'member')
    const d = await w.doc()

    for (const path of ['', '/preview']) {
      const garbage = await post(path, { nothing: 'the schema asks for' })
      expect(garbage.status).toBe(403)
      expect(garbage.json.code).toBe('permission_required')
    }
    expect((await post('', { kind: 'invoice', to: TO, items: [{ id: d.id }] })).status).toBe(403)
    expect((await post('/preview', { kind: 'invoice', ids: [d.id] })).status).toBe(403)
    expect(printed).toEqual([])
    // The same body from a role that mails is the body's own fault.
    expect((await (await session(w, 'admin'))('', { nothing: 'the schema asks for' })).status).toBe(422)
  })

  it('another organization\'s session is refused by the tenant guard, as on every route', async () => {
    fakeSendGrid()
    fakePrinting()
    const w = await world()
    const other = await world()
    const d = await w.doc()
    const post = await session(other, 'admin')
    expect((await post('/preview', { kind: 'invoice', ids: [d.id] }, { orgId: w.orgId })).status).toBe(403)
    expect((await post('', { kind: 'invoice', to: TO, items: [{ id: d.id }] }, { orgId: w.orgId })).status).toBe(403)
    // In its own organization the same id names nothing.
    const own = await post('/preview', { kind: 'invoice', ids: [d.id] })
    expect(own.json.documents).toEqual([{ id: d.id, number: '', docType: '', blocked: 'not_found' }])
    expect(printed).toEqual([])
  })
})
