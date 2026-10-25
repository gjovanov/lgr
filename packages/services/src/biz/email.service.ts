import { randomUUID } from 'node:crypto'
import { config, nodeRole } from 'config'
import { EmailLog, Outbox } from 'db/models'
import { fetchWithTimeout } from './outbound-fetch.js'

/** FR-20.53: SendGrid gets 60 s — an email may carry up to 20 MB of attachments. */
const sendgridFetch = (url: string, init: RequestInit) => fetchWithTimeout(url, init, { timeoutMs: 60_000 })

export interface EmailAttachment {
  filename: string
  /**
   * Raw bytes, or an already-base64 string.
   *
   * `Uint8Array` is listed explicitly because that is what actually arrives: `mdToPdf`
   * returns puppeteer's `page.pdf()` output, which is a Uint8Array under Bun — NOT a Buffer,
   * whatever its type declaration says. See `toBase64`.
   */
  content: Buffer | Uint8Array | string
  /** MIME type; defaults to application/octet-stream. */
  type?: string
}

export interface SendEmailOptions {
  to: string
  subject: string
  html: string
  creatorId?: string
  orgId?: string
  /** FR-10.1 — mapped to SendGrid v3 `attachments`. */
  attachments?: EmailAttachment[]
  /** Ties the log row back to the document that triggered the send. */
  entityType?: string
  entityId?: string
  /** Where a reply goes (SendGrid `reply_to`). Global sets it to the org's address for a relayed mail. */
  replyTo?: string
  /**
   * FR-20.86: on a master, the outbox id of this mail. Deterministic where the work has one
   * (`digest:<orgId>:<date>:<userId>`), so queueing the same work twice keeps one mail.
   */
  outboxId?: string
  /** False: no EmailLog row. Global relaying a master's mail keeps a receipt instead. */
  log?: boolean
}

/**
 * FR-10.2 — the outcome, spelled out.
 *
 * This function used to return `void` and swallow BOTH failure modes: a missing API key
 * logged a warning and returned, and a non-2xx from SendGrid did the same. A caller could
 * not tell "sent" from "silently dropped", which is fine for a fire-and-forget activation
 * mail and completely wrong for "did my invoice reach the customer?".
 *
 * The two existing auth callers ignore the result and keep working unchanged.
 */
export type SendEmailResult =
  | { ok: true; queued?: true }
  | { ok: false; reason: 'not_configured' | 'provider_error'; detail?: string }

/** SendGrid rejects messages over 30 MB encoded; stay well under it. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Bytes → base64, for ANY binary shape the renderers hand over.
 *
 * ⚠ The obvious `content.toString('base64')` is a trap. It is correct for a Buffer and
 * silently wrong for a plain `Uint8Array`, which does not override `toString` — the argument
 * is ignored and you get `Array.prototype.toString`, i.e. the bytes as a comma-separated list
 * of decimals ("37,80,68,70,…"). SendGrid answers
 *   400 "The attachment content must be base64 encoded."
 * and the invoice never arrives.
 *
 * This bites here and not in Print because the export endpoints stream the same bytes
 * straight into the HTTP response and never encode them. `mdToPdf` is typed as returning a
 * Buffer but returns puppeteer's Uint8Array under Bun.
 */
function toBase64(content: Buffer | Uint8Array | string): string {
  if (typeof content === 'string') return content
  if (Buffer.isBuffer(content)) return content.toString('base64')
  // Uint8Array and any other ArrayBuffer view — copy through Buffer, which does honour the
  // encoding argument. `byteOffset`/`byteLength` matter for a view into a larger buffer.
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('base64')
}

async function logEmail(
  opts: SendEmailOptions,
  status: 'queued' | 'sent' | 'failed',
  error?: string,
  outboxId?: string,
): Promise<void> {
  if (opts.log === false) return
  try {
    await EmailLog.create({
      creatorId: opts.creatorId || undefined,
      orgId: opts.orgId || undefined,
      from: config.email.fromEmail,
      to: opts.to,
      subject: opts.subject,
      // Attachment CONTENT is never logged — only its name.
      body: opts.html,
      status,
      error,
      entityType: opts.entityType,
      entityId: opts.entityId,
      attachmentNames: opts.attachments?.map(a => a.filename),
      outboxId,
    } as any)
  } catch (e) {
    // A logging failure must not turn a delivered mail into a reported failure.
    console.warn('EmailLog write failed', e)
  }
}

/**
 * FR-20.59, FR-20.86 (plan step P2-6) — a master holds no mail key: its mail is queued in the
 * outbox, and global sends it on the master's behalf (`relay/outbox-worker.ts`). The answer says
 * `queued`, never sent: the EmailLog row stays `queued` until global has sent it.
 */
async function queueMail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (!opts.orgId) return { ok: false, reason: 'not_configured', detail: "A server sends mail for one of its organizations, and none was named" }
  const attachments = (opts.attachments || []).map(a => ({ filename: a.filename, type: a.type || 'application/octet-stream', content: toBase64(a.content) }))
  const bytes = attachments.reduce((n, a) => n + Math.floor((a.content.length * 3) / 4), 0)
  if (Buffer.byteLength(opts.html ?? '', 'utf8') > config.relay.maxHtmlBytes) {
    const detail = "The message body is over 1 MB, the most a server's mail carries"
    await logEmail(opts, 'failed', detail)
    return { ok: false, reason: 'provider_error', detail }
  }
  if (bytes > config.relay.maxAttachmentBytes) {
    const detail = `Attachments exceed ${Math.round(config.relay.maxAttachmentBytes / 1024 / 1024)} MB, the most a server's mail carries`
    await logEmail(opts, 'failed', detail)
    return { ok: false, reason: 'provider_error', detail }
  }
  const id = opts.outboxId ?? `mail:${opts.orgId}:${randomUUID()}`
  try {
    await Outbox.create({
      _id: id,
      orgId: opts.orgId,
      kind: 'mail',
      payload: { to: opts.to, subject: opts.subject, html: opts.html, attachments, entityType: opts.entityType, entityId: opts.entityId },
      state: 'queued',
      nextAt: new Date(),
    })
  } catch (e: any) {
    // The same work queued already (a deterministic id): one mail, not two.
    if (e?.code === 11000) return { ok: true, queued: true }
    throw e
  }
  await logEmail(opts, 'queued', undefined, id)
  return { ok: true, queued: true }
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (nodeRole() === 'master') return queueMail(opts)
  const apiKey = config.email.sendgridApiKey
  if (!apiKey) {
    console.warn('SENDGRID_API_KEY not configured — skipping email send')
    return { ok: false, reason: 'not_configured' }
  }

  const attachments = (opts.attachments || []).map(a => ({
    content: toBase64(a.content),
    filename: a.filename,
    type: a.type || 'application/octet-stream',
    disposition: 'attachment',
  }))

  const oversized = attachments.reduce((n, a) => n + a.content.length, 0)
  if (oversized > MAX_ATTACHMENT_BYTES) {
    const detail = `Attachments exceed ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`
    await logEmail(opts, 'failed', detail)
    return { ok: false, reason: 'provider_error', detail }
  }

  let response: Response
  try {
    response = await sendgridFetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: config.email.fromEmail },
        ...(opts.replyTo ? { reply_to: { email: opts.replyTo } } : {}),
        subject: opts.subject,
        content: [{ type: 'text/html', value: opts.html }],
        ...(attachments.length ? { attachments } : {}),
      }),
    })
  } catch (e: any) {
    // Network-level failure — DNS, TLS, timeout.
    const detail = e?.message || 'Network error contacting the mail provider'
    await logEmail(opts, 'failed', detail)
    return { ok: false, reason: 'provider_error', detail }
  }

  if (!response.ok) {
    const body = await response.text()
    const detail = `SendGrid ${response.status}: ${body.slice(0, 500)}`
    console.warn(detail)
    await logEmail(opts, 'failed', detail)
    return { ok: false, reason: 'provider_error', detail }
  }

  await logEmail(opts, 'sent')
  return { ok: true }
}
