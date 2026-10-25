/**
 * Client for the `lgr-ocr` sidecar (packages/ocr-server, ClusterIP `lgr-ocr:8100`).
 *
 * Every call is time-boxed. The sidecar shells out to poppler/tesseract and then to Claude,
 * which can take ~30s per document; a hung call used to block a request indefinitely
 * because none of the original fetches passed a signal.
 *
 * **On a master** (FR-20.59, plan step P2-6b) the package carries no sidecar and none of the model
 * credentials. With no `OCR_SERVER_URL` of its own, every step goes to lgrai.app instead, which runs
 * it on ITS sidecar (`relay/documents-relay.service.ts`): posted as a job with the supervisor's node
 * token, then polled, because a draft outlasts any request the ingress keeps open. It needs the org
 * (its admin turns the relay on, per server) and lgrai.app; without either it fails with a message
 * that says so, and the import shows it per document.
 */
import { randomUUID } from 'node:crypto'
import { config, nodeRole } from 'config'
import { fetchWithTimeout } from '../outbound-fetch.js'
import { readNodeToken } from '../relay/outbox-worker.js'
import type { DraftResult } from './types.js'

export interface ExtractResult {
  text: string
  method: 'native' | 'tesseract'
  pages: number
}

/** Extraction is poppler/tesseract only — fast, but a 300-dpi rasterise of a long scan isn't. */
const EXTRACT_TIMEOUT_MS = Number(process.env.OCR_EXTRACT_TIMEOUT_MS) || 180_000
/** Drafting runs a model, optionally escalating to a second one. */
const DRAFT_TIMEOUT_MS = Number(process.env.OCR_DRAFT_TIMEOUT_MS) || 300_000
/** How often a master asks lgrai.app whether its job is done (read per call: tests shorten it). */
const relayPollMs = () => Number(process.env.OCR_RELAY_POLL_MS) || 2_000

export class OcrError extends Error {
  constructor(message: string, readonly stage: 'extract' | 'draft') {
    super(message)
    this.name = 'OcrError'
  }
}

/**
 * Whether this process reads documents through lgrai.app: a master with no sidecar of its own.
 * `direct` on a call overrides it: lgrai.app reading FOR a master always uses its own sidecar.
 */
export function readsThroughLgrai(): boolean {
  return nodeRole() === 'master' && !config.ocr.configured
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The message for a refusal from lgrai.app's relay, said for the person whose import it is. */
function refusalMessage(status: number, body: any): string {
  if (body?.code === 'relay_disabled' || body?.code === 'too_many' || body?.code === 'too_large' || body?.code === 'clone_alarm') return String(body.message)
  if (status === 401 || status === 403) return `lgrai.app refused to read documents for this server (${body?.code ?? status}).`
  return `lgrai.app could not take the document (${body?.code ?? status}).`
}

/**
 * Master: one step through lgrai.app. Posted with a request id of its own, then polled; a job global
 * lost (its process restarted) is posted again under the same id, which is the same job.
 */
async function throughLgrai<T>(op: 'extract' | 'draft' | 'match-lines', orgId: string | undefined, input: unknown, timeoutMs: number, stage: 'extract' | 'draft'): Promise<T> {
  if (!orgId) throw new OcrError('This server reads documents through lgrai.app, and that needs the organization they belong to.', stage)
  const requestId = randomUUID()
  const deadline = Date.now() + timeoutMs
  let posted = false
  let failures = 0
  while (Date.now() < deadline) {
    // Read every time: the supervisor replaces the token every ten minutes, and a draft can outlast one.
    const token = readNodeToken(config.outbox.tokenFile)
    if (!token) throw new OcrError('This server cannot reach lgrai.app right now, so it cannot read documents. Try again when it is online.', stage)
    const headers = { authorization: `Bearer ${token.token}` }
    try {
      if (!posted) {
        const res = await fetchWithTimeout(`${token.server}/api/node/v1/relay/documents`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, orgId, op, input }),
        }, { timeoutMs: 60_000 })
        const body: any = await res.json().catch(() => ({}))
        if (res.status !== 202) throw new OcrError(refusalMessage(res.status, body), stage)
        posted = true
        if (body?.state === 'done' || body?.state === 'failed') continue // already answered: read it now
      }
      await sleep(relayPollMs())
      const res = await fetchWithTimeout(`${token.server}/api/node/v1/relay/documents/${requestId}`, { headers }, { timeoutMs: 30_000 })
      const body: any = await res.json().catch(() => ({}))
      if (res.status === 404 || body?.state === 'lost') {
        posted = false
        continue
      }
      if (!res.ok) throw new Error(`lgrai.app answered ${res.status}`)
      failures = 0
      if (body?.state === 'done') return body.result as T
      if (body?.state === 'failed') throw new OcrError(String(body.error ?? 'lgrai.app could not read it.'), stage)
    } catch (e: any) {
      if (e instanceof OcrError) throw e
      // The line dropped for a moment: keep asking until the deadline, but not forever.
      if (++failures >= 5) throw new OcrError(`lgrai.app could not be reached (${e?.message ?? e}).`, stage)
      await sleep(relayPollMs())
    }
  }
  throw new OcrError(`lgrai.app did not finish reading it within ${Math.round(timeoutMs / 1000)} s.`, stage)
}

/** PDF bytes → text. `forceOcr` skips the native text layer (junk layers defeat the heuristic). */
export async function ocrExtract(
  pdf: Buffer,
  filename: string,
  opts: { forceOcr?: boolean; orgId?: string; direct?: boolean } = {},
): Promise<ExtractResult> {
  if (!opts.direct && readsThroughLgrai()) {
    return throughLgrai<ExtractResult>('extract', opts.orgId, { filename, pdfBase64: pdf.toString('base64'), ...(opts.forceOcr ? { forceOcr: true } : {}) }, EXTRACT_TIMEOUT_MS, 'extract')
  }
  const fd = new FormData()
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), filename)
  if (opts.forceOcr) fd.append('forceOcr', 'true')
  let res: Response
  try {
    res = await fetch(`${config.ocr.serverUrl}/extract`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    })
  } catch (e: any) {
    throw new OcrError(e?.name === 'TimeoutError' ? `ocr /extract timed out after ${EXTRACT_TIMEOUT_MS}ms` : String(e?.message || e), 'extract')
  }
  if (!res.ok) throw new OcrError(`ocr /extract → ${res.status}`, 'extract')
  return res.json() as any
}

/**
 * Text → structured extraction. `profile` selects the sidecar's instruction set
 * (invoice / goods_receipt / stock_note); omitted, the sidecar auto-detects from the text.
 */
export async function ocrDraft(text: string, profile?: string, opts: { orgId?: string; direct?: boolean } = {}): Promise<DraftResult> {
  if (!opts.direct && readsThroughLgrai()) {
    return throughLgrai<DraftResult>('draft', opts.orgId, profile ? { text, profile } : { text }, DRAFT_TIMEOUT_MS, 'draft')
  }
  let res: Response
  try {
    res = await fetch(`${config.ocr.serverUrl}/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profile ? { text, profile } : { text }),
      signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
    })
  } catch (e: any) {
    throw new OcrError(e?.name === 'TimeoutError' ? `ocr /draft timed out after ${DRAFT_TIMEOUT_MS}ms` : String(e?.message || e), 'draft')
  }
  if (!res.ok) throw new OcrError(`ocr /draft → ${res.status}`, 'draft')
  return res.json() as any
}

/**
 * Lines → candidate ids (or null each), by the sidecar's model. Throws; `aiMatchLines` is the
 * failure-tolerant caller the import uses.
 */
export async function ocrMatchLines(
  lines: string[],
  candidates: Array<{ id: string; name: string; sku?: string }>,
  opts: { timeoutMs?: number; orgId?: string; direct?: boolean } = {},
): Promise<unknown[]> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  if (!opts.direct && readsThroughLgrai()) {
    const answer = await throughLgrai<{ matches?: unknown[] }>('match-lines', opts.orgId, { lines, candidates }, timeoutMs, 'draft')
    return Array.isArray(answer?.matches) ? answer.matches : []
  }
  const res = await fetch(`${config.ocr.serverUrl}/match-lines`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lines, candidates }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new OcrError(`ocr /match-lines → ${res.status}`, 'draft')
  const data: any = await res.json()
  return Array.isArray(data?.matches) ? data.matches : []
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * The sidecar is a single replica that spawns a model per document, so the useful ceiling
 * is small; the point is to stop a 40-file batch opening 40 sockets at once, not to
 * parallelise the model.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}
