import { config, nodeRole } from 'config'
import { MAX_DOCS_PER_MAIL, type DocEmailFailure } from 'config/doc-email'
import { MAX_ATTACHMENT_BYTES, sendEmail, type SendEmailOptions, type SendEmailResult } from '../email.service.js'
import { packAttachments, type MailLimits } from './pack.js'

/**
 * Several documents to one address, each as its printed PDF (2026-11-16).
 *
 * The engine knows no kind of document. Its caller has already decided which documents go (it loaded them, held
 * them to the session's access, left out the drafts and the ones just mailed) and hands each over with a `render`
 * that prints it. The invoicing API mails invoices and supplier orders through it; another kind (a stock movement's
 * document) brings its own loading, rules and `render`, and is mailed the same way.
 *
 * What it does with them:
 *   1. renders, two at a time: a render is a fresh Chrome and about a second, and under load the renderer fails
 *      rather than slows. A render that fails drops that document only;
 *   2. packs the files into mails that fit this node's path (`mailLimits`): at most ten attachments, and the relay's
 *      bytes on a master, the provider's anywhere else. A file no mail can carry is `too_large`;
 *   3. sends each mail with `entities`, so every document has its own `EmailLog` row and, on a master, its place in
 *      the outbox payload;
 *   4. answers per document: `sent`, `queued` (a master: the mail waits for lgrai.app, and is never said to be
 *      sent), or `failed` with why.
 *
 * ⚠ It writes nothing about the documents themselves. A sent invoice's `emailedTo` and the audit entries are its
 * caller's, which knows what the document is; a QUEUED invoice's are the outbox worker's, when the mail has gone.
 */

export type RenderedDocument =
  | { ok: true; buffer: Buffer | Uint8Array; filename: string }
  | { ok: false; message: string }

export interface EmailableDocument {
  /** What the `EmailLog` row and the outbox payload name: `invoice`, `order`, `stock_movement`… */
  entityType: string
  entityId: string
  /** The document's own number, for whoever reads the answer. */
  number: string
  render: () => Promise<RenderedDocument>
}

export interface EmailDocumentsInput<D extends EmailableDocument> {
  orgId: string
  /** Who mails them: the `EmailLog` rows' `creatorId`. */
  userId?: string
  to: string
  /** Where a reply goes. A master's mail gets the org's address from the relay instead (FR-20.59). */
  replyTo?: string
  documents: readonly D[]
  /** One mail's subject and note, from the documents that mail carries (a request may split into several). */
  subject: (documents: D[]) => string
  html: (documents: D[]) => string
  /** Defaults to this node's (`mailLimits()`). */
  limits?: MailLimits
  /** Renders in flight at once. Two, unless a test says otherwise. */
  concurrency?: number
  /** The mail service, for a test that counts calls. */
  send?: (opts: SendEmailOptions) => Promise<SendEmailResult>
}

export interface DocumentOutcome<D extends EmailableDocument> {
  document: D
  status: 'sent' | 'queued' | 'failed'
  reason?: DocEmailFailure
  /** The renderer's or the provider's own words. */
  message?: string
  /** The file's name in the mail it went in. */
  filename?: string
}

export interface EmailDocumentsOutcome<D extends EmailableDocument> {
  /** Mails that left, or were queued. */
  mails: number
  /** They were queued for lgrai.app (a master), not sent. */
  queued: boolean
  /** The mail service is not configured on this node: nothing more was tried. */
  notConfigured: boolean
  /** One per document, in the order given. */
  results: DocumentOutcome<D>[]
}

/**
 * What one mail may carry on this node, in `pack.ts`'s weight: the relay's cap on a master, whose outbox item and
 * global's relay both refuse more, and the provider's cap anywhere else. Ten attachments either way.
 */
export function mailLimits(): MailLimits {
  return {
    maxAttachments: MAX_DOCS_PER_MAIL,
    maxBytes: nodeRole() === 'master' ? config.relay.maxAttachmentBytes : Math.floor((MAX_ATTACHMENT_BYTES * 3) / 4),
  }
}

async function renderOne(document: EmailableDocument): Promise<RenderedDocument> {
  try {
    const rendered = await document.render()
    if (!rendered.ok) return rendered
    if (!rendered.buffer?.length) return { ok: false, message: 'The document rendered empty' }
    return rendered
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e).slice(0, 300) }
  }
}

/** Each document rendered, `concurrency` at a time, in the order given. */
async function renderAll(documents: readonly EmailableDocument[], concurrency: number): Promise<RenderedDocument[]> {
  const out: RenderedDocument[] = new Array(documents.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < documents.length; i = next++) out[i] = await renderOne(documents[i]!)
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, documents.length)) }, worker))
  return out
}

/** Two files of one mail never share a name: a mail client shows the second as a copy, or hides it. */
function distinctNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    if (!n) return name
    const dot = name.lastIndexOf('.')
    return dot > 0 ? `${name.slice(0, dot)} (${n + 1})${name.slice(dot)}` : `${name} (${n + 1})`
  })
}

export async function emailDocuments<D extends EmailableDocument>(input: EmailDocumentsInput<D>): Promise<EmailDocumentsOutcome<D>> {
  const send = input.send ?? sendEmail
  const limits = input.limits ?? mailLimits()
  const documents = [...input.documents]
  const results: DocumentOutcome<D>[] = documents.map(document => ({ document, status: 'failed' }))
  const outcome: EmailDocumentsOutcome<D> = { mails: 0, queued: false, notConfigured: false, results }
  if (!documents.length) return outcome

  const rendered = await renderAll(documents, input.concurrency ?? 2)
  const ready: number[] = []
  rendered.forEach((r, i) => {
    if (r.ok) ready.push(i)
    else results[i] = { document: documents[i]!, status: 'failed', reason: 'render_failed', message: r.message }
  })

  const size = (i: number) => (rendered[i] as { buffer: Buffer | Uint8Array }).buffer.length
  const packing = packAttachments(ready.map(size), limits)
  for (const at of packing.tooLarge) {
    const i = ready[at]!
    results[i] = {
      document: documents[i]!,
      status: 'failed',
      reason: 'too_large',
      message: `The file is ${Math.ceil(size(i) / 1024 / 1024)} MB, more than one mail carries`,
    }
  }

  for (const mail of packing.mails) {
    const indices = mail.map(at => ready[at]!)
    const docs = indices.map(i => documents[i]!)
    if (outcome.notConfigured) {
      for (const i of indices) results[i] = { document: documents[i]!, status: 'failed', reason: 'not_configured' }
      continue
    }
    const files = indices.map(i => rendered[i] as { buffer: Buffer | Uint8Array; filename: string })
    const names = distinctNames(files.map(f => f.filename))
    const sent = await send({
      to: input.to,
      subject: input.subject(docs),
      html: input.html(docs),
      attachments: files.map((f, n) => ({ filename: names[n]!, content: f.buffer, type: 'application/pdf' })),
      creatorId: input.userId,
      orgId: input.orgId,
      replyTo: input.replyTo,
      entities: docs.map((d, n) => ({ entityType: d.entityType, entityId: d.entityId, attachmentName: names[n]! })),
    })
    if (sent.ok) {
      outcome.mails++
      if (sent.queued) outcome.queued = true
      indices.forEach((i, n) => { results[i] = { document: documents[i]!, status: sent.queued ? 'queued' : 'sent', filename: names[n]! } })
      continue
    }
    if (sent.reason === 'not_configured') outcome.notConfigured = true
    for (const i of indices) {
      results[i] = {
        document: documents[i]!,
        status: 'failed',
        reason: sent.reason === 'not_configured' ? 'not_configured' : 'provider_error',
        message: sent.detail?.slice(0, 300),
      }
    }
  }
  return outcome
}
