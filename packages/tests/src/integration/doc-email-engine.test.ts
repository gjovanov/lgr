import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { EmailLog, Invoice, Outbox } from 'db/models'
import { MAX_ATTACHMENT_BYTES, mailConfigured, sendEmail } from 'services/biz/email.service'
import { emailDocuments, mailLimits, type EmailableDocument } from 'services/biz/doc-email/engine'
import { drainOne } from 'services/biz/relay/outbox-worker'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg } from '../helpers/factories'

/**
 * One mail that carries several documents (2026-11-16): `sendEmail`'s `entities`, the outbox item of such a mail,
 * and the engine that packs any kind of document into mails (`services/biz/doc-email`).
 *
 * What a mail WITHOUT `entities` does is `email-service.test.ts`'s and `mail-relay.flow.test.ts`'s, unchanged.
 *
 * NOTE: no `.rejects` / `.resolves` (they deadlock the Windows runner).
 */

const TO = 'customer@buyer.test'
const realFetch = globalThis.fetch
const saved = { key: config.email.sendgridApiKey, role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile }
let tmp = ''

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

afterEach(async () => {
  globalThis.fetch = realFetch
  ;(config.email as any).sendgridApiKey = saved.key
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  forgetAllHomes()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
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

/** The supervisor's node token, as the outbox worker reads it. */
function aNodeToken() {
  const file = join(tmp, 'node-token.json')
  writeFileSync(file, JSON.stringify({ server: 'https://lgrai.test', token: 'node-token', expiresAt: Math.floor(Date.now() / 1000) + 600 }))
  ;(config.outbox as any).tokenFile = file
}

function asMaster() {
  tmp = mkdtempSync(join(tmpdir(), 'lgr-doc-email-'))
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = 'master-docemailengine'.padEnd(23, 'a')
  ;(config.email as any).sendgridApiKey = ''
}

/** An org with two issued invoices, and the mail that carries both. */
async function twoInvoices() {
  const org = await createTestOrg()
  // On an organization's own server its home is recorded before anything else is written for it.
  await homeNewOrg(org._id)
  const contact = await createTestContact(org._id)
  const a: any = await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'INV-00001', status: 'sent' } as any)
  const b: any = await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'INV-00002', status: 'sent' } as any)
  const ids = [String(a._id), String(b._id)]
  const mail = {
    to: TO, subject: '2 documents', html: '<p>Hello</p>', orgId: String(org._id),
    attachments: [
      { filename: 'INV-00001.pdf', content: Buffer.from('%PDF 1'), type: 'application/pdf' },
      { filename: 'INV-00002.pdf', content: Buffer.from('%PDF 2'), type: 'application/pdf' },
    ],
    entities: [
      { entityType: 'invoice', entityId: ids[0]!, attachmentName: 'INV-00001.pdf' },
      { entityType: 'invoice', entityId: ids[1]!, attachmentName: 'INV-00002.pdf' },
    ],
  }
  return { orgId: String(org._id), ids, mail }
}

describe('a mail that names the documents it carries', () => {
  it('is ONE provider call, and a log row per document: its own id and its own file', async () => {
    const sent = fakeSendGrid()
    const w = await twoInvoices()

    expect(await sendEmail(w.mail)).toEqual({ ok: true })

    expect(sent).toHaveLength(1)
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual(['INV-00001.pdf', 'INV-00002.pdf'])
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).sort({ attachmentNames: 1 }).lean()
    expect(logs.map(l => [l.entityType, String(l.entityId), l.attachmentNames, l.status, l.to, l.subject])).toEqual([
      ['invoice', w.ids[0], ['INV-00001.pdf'], 'sent', TO, '2 documents'],
      ['invoice', w.ids[1], ['INV-00002.pdf'], 'sent', TO, '2 documents'],
    ])
    // The 60-second resend guard reads one document's rows: each has exactly one.
    expect(await EmailLog.countDocuments({ entityType: 'invoice', entityId: w.ids[1], to: TO, status: 'sent' })).toBe(1)
  })

  it('a failure is logged the same way, per document', async () => {
    fakeSendGrid(500)
    const w = await twoInvoices()

    const result = await sendEmail(w.mail)

    expect(result.ok).toBe(false)
    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).sort({ attachmentNames: 1 }).lean()
    expect(logs.map(l => [String(l.entityId), l.attachmentNames, l.status])).toEqual([
      [w.ids[0], ['INV-00001.pdf'], 'failed'], [w.ids[1], ['INV-00002.pdf'], 'failed'],
    ])
    expect(logs.every(l => String(l.error).includes('SendGrid 500'))).toBe(true)
  })

  it('an entity that names no file logs none, and a mail told not to log logs nothing at all', async () => {
    fakeSendGrid()
    const w = await twoInvoices()
    await sendEmail({ ...w.mail, entities: [{ entityType: 'invoice', entityId: w.ids[0]! }] })
    expect(((await EmailLog.findOne({ orgId: w.orgId }).lean()) as any).attachmentNames).toEqual([])
    await sendEmail({ ...w.mail, to: 'other@buyer.test', log: false })
    expect(await EmailLog.countDocuments({ to: 'other@buyer.test' })).toBe(0)
  })

  it('on an organization\'s own server it is queued with its documents, and the worker settles every invoice when it has gone', async () => {
    asMaster()
    expect(mailConfigured()).toBe(true)
    const w = await twoInvoices()

    expect(await sendEmail(w.mail)).toEqual({ ok: true, queued: true })

    const item: any = await Outbox.findOne({ orgId: w.orgId }).lean()
    expect(item.payload.entities).toEqual(w.mail.entities)
    expect(item.payload.entityId).toBeUndefined()
    const queued: any[] = await EmailLog.find({ outboxId: item._id }).lean()
    expect(queued.map(l => l.status)).toEqual(['queued', 'queued'])
    // Queued is not sent: neither invoice says it was mailed yet.
    for (const id of w.ids) expect(((await Invoice.findById(id).lean()) as any).emailedTo ?? []).toEqual([])

    aNodeToken()
    const global = (async () => Response.json({ state: 'sent' }, { status: 200 })) as any
    expect(await drainOne(new Date(), global)).toBe('sent')

    expect((await EmailLog.find({ outboxId: item._id }).lean()).map((l: any) => l.status)).toEqual(['sent', 'sent'])
    for (const id of w.ids) {
      const invoice: any = await Invoice.findById(id).lean()
      expect(invoice.emailedTo).toEqual([TO])
      expect(invoice.lastEmailedAt).toBeInstanceOf(Date)
    }
    // The bytes go once it is done; which documents the mail carried stays.
    const done: any = await Outbox.findById(item._id).lean()
    expect(done.payload).toMatchObject({ to: TO, subject: '2 documents', entities: w.mail.entities })
    expect(done.payload.attachments).toBeUndefined()
    expect(done.payload.html).toBeUndefined()
  })

  it('a queued mail that lgrai.app refuses for good fails every document, and no invoice says it was mailed', async () => {
    asMaster()
    const w = await twoInvoices()
    await sendEmail(w.mail)
    aNodeToken()
    const refused = (async () => Response.json({ code: 'too_large', message: 'too big' }, { status: 413 })) as any

    expect(await drainOne(new Date(), refused)).toBe('failed')

    const logs: any[] = await EmailLog.find({ orgId: w.orgId }).lean()
    expect(logs.map(l => l.status)).toEqual(['failed', 'failed'])
    for (const id of w.ids) expect(((await Invoice.findById(id).lean()) as any).emailedTo ?? []).toEqual([])
  })

  it('a server with neither a key nor a relay cannot mail, and says so before any work', () => {
    ;(config.email as any).sendgridApiKey = ''
    expect(mailConfigured()).toBe(false)
    ;(config.email as any).sendgridApiKey = 'SG.test-key'
    expect(mailConfigured()).toBe(true)
  })
})

describe('the engine, for any kind of document', () => {
  const file = (name: string, size = 100): EmailableDocument => ({
    entityType: 'stock_movement', entityId: name, number: name,
    render: async () => ({ ok: true, buffer: Buffer.alloc(size, 1), filename: `${name}.pdf` }),
  })
  const input = (documents: EmailableDocument[], over: Record<string, any> = {}) => ({
    orgId: '0123456789abcdef01234567', userId: 'abcdef0123456789abcdef01', to: TO, documents,
    subject: (docs: EmailableDocument[]) => `${docs.length} files`,
    html: (docs: EmailableDocument[]) => docs.map(d => d.number).join(','),
    ...over,
  })

  it('twelve documents are two mails, each naming the documents it carries', async () => {
    const mails: any[] = []
    const outcome = await emailDocuments(input(Array.from({ length: 12 }, (_, i) => file(`M-${i + 1}`)), {
      send: async (opts: any) => { mails.push(opts); return { ok: true } },
    }))
    expect(outcome).toMatchObject({ mails: 2, queued: false, notConfigured: false })
    expect(outcome.results.map(r => r.status)).toEqual(Array(12).fill('sent'))
    expect(mails.map(m => [m.subject, m.attachments.length, m.entities.length])).toEqual([['10 files', 10, 10], ['2 files', 2, 2]])
    expect(mails[1].entities).toEqual([
      { entityType: 'stock_movement', entityId: 'M-11', attachmentName: 'M-11.pdf' },
      { entityType: 'stock_movement', entityId: 'M-12', attachmentName: 'M-12.pdf' },
    ])
    expect(mails[0]).toMatchObject({ to: TO, orgId: '0123456789abcdef01234567', creatorId: 'abcdef0123456789abcdef01' })
  })

  it('packs by bytes too, leaves out a file no mail carries, and prints two at a time', async () => {
    let inFlight = 0
    let most = 0
    const slow = (name: string, size: number): EmailableDocument => ({
      ...file(name, size),
      render: async () => {
        most = Math.max(most, ++inFlight)
        await new Promise(r => setTimeout(r, 15))
        inFlight--
        return { ok: true, buffer: Buffer.alloc(size, 1), filename: `${name}.pdf` }
      },
    })
    const mails: any[] = []
    const outcome = await emailDocuments(input([slow('a', 600), slow('b', 600), slow('c', 3000), slow('d', 300), slow('e', 300)], {
      limits: { maxAttachments: 10, maxBytes: 1000 },
      send: async (opts: any) => { mails.push(opts); return { ok: true, queued: true } },
    }))
    expect(most).toBe(2)
    expect(mails.map(m => m.attachments.map((a: any) => a.filename))).toEqual([['a.pdf'], ['b.pdf', 'd.pdf'], ['e.pdf']])
    expect(outcome).toMatchObject({ mails: 3, queued: true })
    expect(outcome.results.map(r => [r.document.number, r.status, r.reason])).toEqual([
      ['a', 'queued', undefined], ['b', 'queued', undefined], ['c', 'failed', 'too_large'], ['d', 'queued', undefined], ['e', 'queued', undefined],
    ])
  })

  it('a render that fails, throws or comes back empty drops that document only', async () => {
    const mails: any[] = []
    const outcome = await emailDocuments(input([
      file('ok-1'),
      { ...file('refused'), render: async () => ({ ok: false as const, message: 'No such document' }) },
      { ...file('thrown'), render: async () => { throw new Error('Chrome went away') } },
      { ...file('empty'), render: async () => ({ ok: true as const, buffer: Buffer.alloc(0), filename: 'empty.pdf' }) },
      file('ok-2'),
    ], { send: async (opts: any) => { mails.push(opts); return { ok: true } } }))
    expect(outcome.results.map(r => [r.document.number, r.status, r.reason, r.message])).toEqual([
      ['ok-1', 'sent', undefined, undefined],
      ['refused', 'failed', 'render_failed', 'No such document'],
      ['thrown', 'failed', 'render_failed', 'Chrome went away'],
      ['empty', 'failed', 'render_failed', 'The document rendered empty'],
      ['ok-2', 'sent', undefined, undefined],
    ])
    expect(mails).toHaveLength(1)
    expect(mails[0].attachments.map((a: any) => a.filename)).toEqual(['ok-1.pdf', 'ok-2.pdf'])
  })

  it('two files of one mail never share a name', async () => {
    const mails: any[] = []
    const twin = (id: string): EmailableDocument => ({ ...file(id), render: async () => ({ ok: true, buffer: Buffer.alloc(10, 1), filename: 'sheet.pdf' }) })
    await emailDocuments(input([twin('1'), twin('2'), twin('3')], { send: async (opts: any) => { mails.push(opts); return { ok: true } } }))
    expect(mails[0].attachments.map((a: any) => a.filename)).toEqual(['sheet.pdf', 'sheet (2).pdf', 'sheet (3).pdf'])
    expect(mails[0].entities.map((e: any) => e.attachmentName)).toEqual(['sheet.pdf', 'sheet (2).pdf', 'sheet (3).pdf'])
  })

  it('a mail service that is not configured is asked once, and the rest is not tried', async () => {
    let asked = 0
    const outcome = await emailDocuments(input(Array.from({ length: 12 }, (_, i) => file(`M-${i + 1}`)), {
      send: async () => { asked++; return { ok: false, reason: 'not_configured' } },
    }))
    expect(asked).toBe(1)
    expect(outcome).toMatchObject({ mails: 0, notConfigured: true })
    expect(outcome.results.every(r => r.status === 'failed' && r.reason === 'not_configured')).toBe(true)
  })

  it('no documents: no mail', async () => {
    let asked = 0
    const outcome = await emailDocuments(input([], { send: async () => { asked++; return { ok: true } } }))
    expect(outcome).toEqual({ mails: 0, queued: false, notConfigured: false, results: [] })
    expect(asked).toBe(0)
  })

  it('a mail fits the path this server mails by: the relay\'s bytes on an organization\'s own server', () => {
    expect(mailLimits()).toEqual({ maxAttachments: 10, maxBytes: Math.floor((MAX_ATTACHMENT_BYTES * 3) / 4) })
    ;(config.node as any).role = 'master'
    expect(mailLimits()).toEqual({ maxAttachments: 10, maxBytes: config.relay.maxAttachmentBytes })
  })
})
