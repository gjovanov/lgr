import { config } from 'config'
import { RelayJob, type RelayJobOp } from 'db/models'
import { logger } from '../../logger/logger.js'
import { ocrDraft, ocrExtract, ocrMatchLines } from '../doc-import/ocr-client.js'
import { relayEnabled } from './mail-relay.service.js'

/**
 * FR-20.59 (plan step P2-6b) — global reads documents for a master, so a master's package carries
 * no OCR sidecar and none of its model credentials (D-12). Global only.
 *
 * A master's document import (Files, doc-import, bill import) calls the same three steps it would
 * call on its own sidecar: text out of a PDF (`extract`, no model), an AI draft of a document's text
 * (`draft`), and AI line matching (`match-lines`). Global runs them on ITS sidecar.
 *
 * - **A job, not a call:** a draft takes up to 300 s, longer than a request through the ingress may
 *   stay open. The master POSTs and polls (`RelayJob`), and a re-post of the same request id gets the
 *   same job: never a second model run for one document.
 * - **The org's admin turned it on**, for this server (the documents leave the shop: to lgrai.app,
 *   and the drafts to the model it uses). Unset follows the link level: on at Full, off at Control.
 * - **The server must be one of the org's**, and not under a clone alarm.
 * - **Per-server daily caps** per kind (`config.relay.documentsPerDay`): the models run on the
 *   subscription lgrai.app's own imports use. And size limits: a PDF, a document's text.
 * - **Nothing is kept but the answer**, for two days: no PDF, no document text.
 */

export type DocumentRelayAnswer = { status: number; body: Record<string, unknown> }

export interface DocumentRelayBody {
  requestId: string
  orgId: string
  op: RelayJobOp
  input: any
}

const TIMEOUT_MS: Record<RelayJobOp, number> = { extract: 180_000, draft: 300_000, 'match-lines': 120_000 }
const OPS = new Set<RelayJobOp>(['extract', 'draft', 'match-lines'])

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): DocumentRelayAnswer =>
  ({ status, body: { code, message, ...extra } })

/** What the op needs, checked before anything runs. A refusal, or null when the input is usable. */
function inputRefusal(op: RelayJobOp, input: any): DocumentRelayAnswer | null {
  if (!input || typeof input !== 'object') return refuse(422, 'bad_input', 'Nothing to read.')
  if (op === 'extract') {
    if (typeof input.pdfBase64 !== 'string' || !input.pdfBase64) return refuse(422, 'bad_input', 'No PDF.')
    if (Math.floor(input.pdfBase64.length * 3 / 4) > config.relay.maxDocumentBytes) {
      return refuse(413, 'too_large', `A PDF read through lgrai.app is at most ${config.relay.maxDocumentBytes / 1024 / 1024} MB.`)
    }
    if (typeof input.filename !== 'string' || !input.filename || input.filename.length > 300) return refuse(422, 'bad_input', 'No file name.')
    return null
  }
  if (op === 'draft') {
    if (typeof input.text !== 'string') return refuse(422, 'bad_input', 'No text.')
    if (input.text.length > config.relay.maxDocumentText) return refuse(413, 'too_large', 'That document is too long to draft.')
    if (input.profile !== undefined && (typeof input.profile !== 'string' || input.profile.length > 40)) return refuse(422, 'bad_input', 'Bad profile.')
    return null
  }
  const lines = input.lines, candidates = input.candidates
  if (!Array.isArray(lines) || !Array.isArray(candidates) || lines.length > 500 || candidates.length > 500) return refuse(422, 'bad_input', 'Bad lines.')
  if (!lines.every((l: unknown) => typeof l === 'string' && l.length <= 2000)) return refuse(422, 'bad_input', 'Bad lines.')
  if (!candidates.every((c: any) => c && typeof c.id === 'string' && typeof c.name === 'string')) return refuse(422, 'bad_input', 'Bad candidates.')
  return null
}

/** Run it on this server's own sidecar (`direct`: never a relay, whatever this process is). */
async function run(op: RelayJobOp, input: any): Promise<unknown> {
  if (op === 'extract') return ocrExtract(Buffer.from(input.pdfBase64, 'base64'), input.filename, { forceOcr: !!input.forceOcr, direct: true })
  if (op === 'draft') return ocrDraft(input.text, input.profile, { direct: true })
  return { matches: await ocrMatchLines(input.lines, input.candidates, { direct: true }) }
}

/** Global: start (or find) a master's document job. 202 `{state}` when it is running or done. */
export async function startDocumentJob(node: any, body: DocumentRelayBody, now = new Date()): Promise<DocumentRelayAnswer> {
  const nodeId = String(node._id)
  if (node.cloneAlarm?.at) return refuse(409, 'clone_alarm', 'Another machine is connected as this server: nothing is relayed until an administrator registers the real one again.')
  if (!(node.orgIds ?? []).some((id: any) => String(id) === body.orgId)) return refuse(403, 'org_not_on_node', 'This server does not serve that organization.')
  if (!relayEnabled(node, body.orgId, 'documents')) {
    return refuse(403, 'relay_disabled', "Reading documents through lgrai.app is off for this server. An admin of the organization turns it on, on lgrai.app's Servers page.")
  }
  if (!OPS.has(body.op)) return refuse(422, 'bad_op', 'Unknown step.')
  const bad = inputRefusal(body.op, body.input)
  if (bad) return bad

  const _id = `${nodeId}:${body.requestId}`
  const had: any = await RelayJob.findById(_id).lean()
  if (had && (had.state !== 'running' || new Date(had.leaseUntil).getTime() > now.getTime())) {
    return { status: 202, body: { state: had.state } }
  }
  // A new job counts against the cap; one lost with its process (lease passed) is the same job again.
  if (!had) {
    const since = new Date(now.getTime() - 24 * 3600_000)
    const cap = config.relay.documentsPerDay[body.op]
    if ((await RelayJob.countDocuments({ nodeId, op: body.op, createdAt: { $gte: since } })) >= cap) {
      return refuse(429, 'too_many', `This server read ${cap} documents (${body.op}) through lgrai.app in the last day. Try again later.`, { retryAfterSecs: 3600 })
    }
  }
  const leaseUntil = new Date(now.getTime() + TIMEOUT_MS[body.op] + 60_000)
  try {
    if (had) {
      // Taken over only if it is still the lost run: two re-posts must not both run it.
      const r = await RelayJob.updateOne({ _id, state: 'running', leaseUntil: had.leaseUntil }, { $set: { leaseUntil } })
      if (!r.modifiedCount) return { status: 202, body: { state: 'running' } }
    } else {
      await RelayJob.create({ _id, nodeId, orgId: body.orgId, op: body.op, state: 'running', leaseUntil, createdAt: now })
    }
  } catch (e: any) {
    // A concurrent post of the same request created it first: that one runs it.
    if (e?.code === 11000) return { status: 202, body: { state: 'running' } }
    throw e
  }

  void run(body.op, body.input).then(
    result => RelayJob.updateOne({ _id, state: 'running' }, { $set: { state: 'done', result, doneAt: new Date() } }),
    e => {
      logger.warn({ nodeId, op: body.op, err: String(e?.message ?? e) }, 'A document read for a master failed')
      return RelayJob.updateOne({ _id, state: 'running' }, { $set: { state: 'failed', error: String(e?.message ?? e).slice(0, 500), doneAt: new Date() } })
    },
  ).catch(e => logger.error({ err: e, nodeId }, 'Could not record a document job'))
  return { status: 202, body: { state: 'running' } }
}

/** Global: where a master's job is. `lost`: its process went; the master posts it again. */
export async function documentJob(node: any, requestId: string, now = new Date()): Promise<DocumentRelayAnswer> {
  const job: any = await RelayJob.findOne({ _id: `${String(node._id)}:${requestId}`, nodeId: String(node._id) }).lean()
  if (!job) return refuse(404, 'unknown_job', 'No such job.')
  if (job.state === 'running') {
    return { status: 200, body: { state: new Date(job.leaseUntil).getTime() > now.getTime() ? 'running' : 'lost' } }
  }
  return { status: 200, body: job.state === 'done' ? { state: 'done', result: job.result } : { state: 'failed', error: job.error ?? 'It could not be read.' } }
}
