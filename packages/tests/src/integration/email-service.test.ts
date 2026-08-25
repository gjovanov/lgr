import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { sendEmail, MAX_ATTACHMENT_BYTES } from 'services/biz/email.service'
import { EmailLog } from 'db/models'
import { config } from 'config'

/**
 * FR-10.1/10.2/10.3 (#19) — the email service's contract.
 *
 * Before this change `sendEmail` returned `void` and swallowed both failure modes, so a
 * caller could not tell a delivered invoice from one that vanished. These tests pin the
 * distinguishable outcomes, the SendGrid attachment payload shape, and that FAILURES are
 * logged too (previously only successes were).
 *
 * `fetch` is stubbed; nothing leaves the machine. It needs a DB only because the log rows
 * are part of the contract.
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })

const realFetch = globalThis.fetch
const realKey = config.email.sendgridApiKey

let lastRequest: { url: string; body: any } | null = null

function stubFetch(response: { ok: boolean; status?: number; text?: string }) {
  globalThis.fetch = (async (url: any, init: any) => {
    lastRequest = { url: String(url), body: JSON.parse(init.body) }
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 202 : 400),
      text: async () => response.text ?? '',
    } as any
  }) as any
}

beforeEach(async () => {
  lastRequest = null
  ;(config.email as any).sendgridApiKey = 'SG.test-key'
  await clearCollections()
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(config.email as any).sendgridApiKey = realKey
})

describe('sendEmail — outcomes', () => {
  it('reports not_configured instead of pretending to send', async () => {
    ;(config.email as any).sendgridApiKey = ''
    let called = false
    globalThis.fetch = (async () => { called = true; return {} as any }) as any

    const res = await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>' })

    expect(res).toEqual({ ok: false, reason: 'not_configured' })
    expect(called).toBe(false)
  })

  it('reports provider_error on a non-2xx, with the detail', async () => {
    stubFetch({ ok: false, status: 403, text: 'The from address does not match a verified Sender Identity' })

    const res = await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('provider_error')
    expect(res.detail).toContain('403')
    expect(res.detail).toContain('verified Sender Identity')
  })

  it('reports provider_error when the network throws', async () => {
    globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as any

    const res = await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('provider_error')
    expect(res.detail).toContain('ENOTFOUND')
  })

  it('reports ok on a 2xx', async () => {
    stubFetch({ ok: true, status: 202 })
    expect(await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>' })).toEqual({ ok: true })
  })
})

describe('sendEmail — SendGrid payload', () => {
  it('maps attachments into the v3 shape, base64-encoded', async () => {
    stubFetch({ ok: true })
    await sendEmail({
      to: 'a@b.co',
      subject: 'Invoice INV-1',
      html: '<p>hi</p>',
      attachments: [{ filename: 'INV-1.pdf', content: Buffer.from('%PDF-1.4 fake'), type: 'application/pdf' }],
    })

    expect(lastRequest!.url).toBe('https://api.sendgrid.com/v3/mail/send')
    const att = lastRequest!.body.attachments
    expect(att).toHaveLength(1)
    expect(att[0].filename).toBe('INV-1.pdf')
    expect(att[0].type).toBe('application/pdf')
    expect(att[0].disposition).toBe('attachment')
    expect(Buffer.from(att[0].content, 'base64').toString()).toBe('%PDF-1.4 fake')
  })

  it('omits the attachments key entirely when there are none', async () => {
    stubFetch({ ok: true })
    await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>' })
    expect('attachments' in lastRequest!.body).toBe(false)
  })

  it('passes an already-base64 string through unchanged', async () => {
    stubFetch({ ok: true })
    const b64 = Buffer.from('hello').toString('base64')
    await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>', attachments: [{ filename: 'a.txt', content: b64 }] })
    expect(lastRequest!.body.attachments[0].content).toBe(b64)
    // Default MIME type when the caller does not say.
    expect(lastRequest!.body.attachments[0].type).toBe('application/octet-stream')
  })

  it('never puts attachment CONTENT in the log — only its name', async () => {
    stubFetch({ ok: true })
    await sendEmail({
      to: 'a@b.co', subject: 'S', html: '<p>x</p>',
      attachments: [{ filename: 'INV-1.pdf', content: Buffer.from('SECRET-BYTES'), type: 'application/pdf' }],
    })
    const log = await EmailLog.findOne({ to: 'a@b.co' }).lean() as any
    expect(log.attachmentNames).toEqual(['INV-1.pdf'])
    expect(JSON.stringify(log)).not.toContain('SECRET-BYTES')
  })

  it('refuses an oversized attachment before contacting the provider', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return { ok: true, status: 202, text: async () => '' } as any }) as any

    const huge = 'A'.repeat(MAX_ATTACHMENT_BYTES + 10)
    const res = await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>', attachments: [{ filename: 'big.pdf', content: huge }] })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.detail).toMatch(/exceed/i)
    expect(called).toBe(false)
  })
})

describe('sendEmail — logging (FR-10.3)', () => {
  it('logs a delivered mail as sent, linked to its entity', async () => {
    stubFetch({ ok: true })
    await sendEmail({
      to: 'a@b.co', subject: 'Invoice INV-1', html: '<p>hi</p>',
      entityType: 'invoice', entityId: '6a8d8485b02febe19109bbcd',
    })

    const log = await EmailLog.findOne({ to: 'a@b.co' }).lean() as any
    expect(log.status).toBe('sent')
    expect(log.error).toBeUndefined()
    expect(log.entityType).toBe('invoice')
    expect(String(log.entityId)).toBe('6a8d8485b02febe19109bbcd')
  })

  it('logs a provider failure too, with the error — the interesting half', async () => {
    stubFetch({ ok: false, status: 403, text: 'Sender identity not verified' })
    await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>', entityType: 'invoice', entityId: '6a8d8485b02febe19109bbcd' })

    const log = await EmailLog.findOne({ to: 'a@b.co' }).lean() as any
    expect(log.status).toBe('failed')
    expect(log.error).toContain('403')
  })

  it('writes no log at all when the provider is not configured', async () => {
    ;(config.email as any).sendgridApiKey = ''
    await sendEmail({ to: 'a@b.co', subject: 'S', html: '<p>x</p>' })
    expect(await EmailLog.countDocuments({ to: 'a@b.co' })).toBe(0)
  })
})
