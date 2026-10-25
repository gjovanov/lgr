import { config } from 'config'
import { Org, RelayReceipt } from 'db/models'
import { logger } from '../../logger/logger.js'
import { sendEmail } from '../email.service.js'

/**
 * FR-20.59 (plan step P2-6) — global sends a master's mail on its behalf, so a master never holds
 * the cloud's mail key (D-12). Global only.
 *
 * What keeps a stolen or broken master from mailing the world through lgrai.app:
 * - **the org's admin turned it on**, for this server, on lgrai.app's Servers page: each org
 *   consents for its own mail. Unset follows the link level: on at Full, off at Control (FR-20.54).
 *   A master cannot turn it on for itself;
 * - **the server must be one of the org's**, and not under a clone alarm;
 * - **one recipient**, a subject, an HTML body under 1 MB, attachments under 8 MB;
 * - **a fixed sender**: global's own address, with the org's address as the reply-to;
 * - **per-server rate limits** (`config.relay`), counted from the receipts;
 * - **a 7-day dedupe** by the master's outbox id: a retry of an item whose answer never arrived
 *   answers with what happened, and sends nothing.
 */

export interface RelayMailBody {
  outboxId: string
  orgId: string
  to: string
  subject: string
  html: string
  attachments?: Array<{ filename: string; type?: string; content: string }>
}

export type RelayAnswer =
  | { status: 200; body: { state: 'sent'; deduped?: boolean; uncertain?: boolean } }
  | { status: 403 | 409 | 413 | 422 | 429 | 502 | 503; body: { code: string; message: string; retryAfterSecs?: number } }

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
/** A receipt still `sending` after this is a send whose outcome nobody knows. */
const STALE_SENDING_MS = 10 * 60_000

/** Whether global relays `kind` for this org on this node: its admin's choice, else the link level's default. */
export function relayEnabled(node: { relays?: Array<{ orgId: unknown; mail?: boolean }>; linkLevel?: string }, orgId: string, kind: 'mail'): boolean {
  const set = node.relays?.find(r => String(r.orgId) === orgId)?.[kind]
  return typeof set === 'boolean' ? set : node.linkLevel === 'full'
}

function refuse(status: 403 | 409 | 413 | 422 | 429 | 502 | 503, code: string, message: string, extra: Record<string, unknown> = {}): RelayAnswer {
  return { status, body: { code, message, ...extra } } as RelayAnswer
}

export async function relayMail(node: any, body: RelayMailBody, now = new Date()): Promise<RelayAnswer> {
  const nodeId = String(node._id)
  if (node.cloneAlarm?.at) return refuse(409, 'clone_alarm', 'Another machine is connected as this server: nothing is relayed until an administrator registers the real one again.')
  if (!(node.orgIds ?? []).some((id: any) => String(id) === body.orgId)) return refuse(403, 'org_not_on_node', 'This server does not serve that organization.')
  if (!relayEnabled(node, body.orgId, 'mail')) return refuse(403, 'relay_disabled', "Mail through lgrai.app is off for this server. An admin of the organization turns it on, on lgrai.app's Servers page.")

  const receiptId = `${nodeId}:${body.outboxId}`
  const had: any = await RelayReceipt.findById(receiptId).lean()
  if (had) {
    if (had.state === 'sent') return { status: 200, body: { state: 'sent', deduped: true } }
    if (now.getTime() - new Date(had.at).getTime() > STALE_SENDING_MS) return { status: 200, body: { state: 'sent', deduped: true, uncertain: true } }
    return refuse(409, 'in_progress', 'This mail is being sent now.')
  }

  const to = String(body.to ?? '').trim()
  if (!EMAIL.test(to) || to.length > 254) return refuse(422, 'bad_recipient', 'A relayed mail goes to one valid address.')
  if (!String(body.subject ?? '').trim() || body.subject.length > 300) return refuse(422, 'bad_subject', 'A relayed mail has a subject of at most 300 characters.')
  if (Buffer.byteLength(String(body.html ?? ''), 'utf8') > config.relay.maxHtmlBytes) return refuse(413, 'too_large', 'A relayed mail body is at most 1 MB.')
  const attachments = body.attachments ?? []
  const bytes = attachments.reduce((n, a) => n + Buffer.from(String(a.content ?? ''), 'base64').length, 0)
  if (attachments.length > 10 || bytes > config.relay.maxAttachmentBytes) {
    return refuse(413, 'too_large', `A relayed mail carries at most 10 attachments and ${Math.round(config.relay.maxAttachmentBytes / 1024 / 1024)} MB.`)
  }

  const [lastHour, lastDay] = await Promise.all([
    RelayReceipt.countDocuments({ nodeId, at: { $gte: new Date(now.getTime() - 3600_000) } }),
    RelayReceipt.countDocuments({ nodeId, at: { $gte: new Date(now.getTime() - 86_400_000) } }),
  ])
  if (lastHour >= config.relay.mailPerHour || lastDay >= config.relay.mailPerDay) {
    const retryAfterSecs = lastHour >= config.relay.mailPerHour ? 3600 : 6 * 3600
    logger.warn({ nodeId, lastHour, lastDay }, 'A server reached its relayed-mail limit')
    return refuse(429, 'rate_limited', `This server has sent ${lastHour} mails in the last hour and ${lastDay} today through lgrai.app, its limit.`, { retryAfterSecs })
  }

  // The claim: written before the send, so a concurrent retry of the same item sends nothing.
  try {
    await RelayReceipt.create({ _id: receiptId, nodeId, orgId: body.orgId, kind: 'mail', state: 'sending', at: now })
  } catch (e: any) {
    if (e?.code === 11000) return refuse(409, 'in_progress', 'This mail is being sent now.')
    throw e
  }
  const org: any = await Org.findById(body.orgId).select('email name').lean()
  const replyTo = typeof org?.email === 'string' && EMAIL.test(org.email) ? org.email : undefined
  const result = await sendEmail({
    to,
    subject: body.subject,
    html: body.html,
    attachments: attachments.map(a => ({ filename: String(a.filename).slice(0, 200), type: a.type ? String(a.type).slice(0, 100) : undefined, content: String(a.content) })),
    replyTo,
    // The master logs the mail; global keeps the receipt. (An EmailLog here would be global's copy of
    // the org's data.)
    log: false,
  })
  if (!result.ok) {
    // Not sent: the claim goes, so the master's retry is sent.
    await RelayReceipt.deleteOne({ _id: receiptId, state: 'sending' })
    if (result.reason === 'not_configured') return refuse(503, 'not_configured', 'Mail is not configured on lgrai.app.')
    return refuse(502, 'provider_error', `The mail provider refused the message: ${String(result.detail ?? '').slice(0, 300)}`)
  }
  await RelayReceipt.updateOne({ _id: receiptId }, { $set: { state: 'sent' } })
  logger.info({ nodeId, orgId: body.orgId, outboxId: body.outboxId }, 'Relayed a mail for a server')
  return { status: 200, body: { state: 'sent' } }
}
