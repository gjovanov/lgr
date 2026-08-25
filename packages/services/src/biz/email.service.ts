import { config } from 'config'
import { EmailLog } from 'db/models'

export interface EmailAttachment {
  filename: string
  /** Raw bytes, or an already-base64 string. */
  content: Buffer | string
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
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'provider_error'; detail?: string }

/** SendGrid rejects messages over 30 MB encoded; stay well under it. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

function toBase64(content: Buffer | string): string {
  return typeof content === 'string' ? content : content.toString('base64')
}

async function logEmail(
  opts: SendEmailOptions,
  status: 'sent' | 'failed',
  error?: string,
): Promise<void> {
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
    } as any)
  } catch (e) {
    // A logging failure must not turn a delivered mail into a reported failure.
    console.warn('EmailLog write failed', e)
  }
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
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
    response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: config.email.fromEmail },
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
