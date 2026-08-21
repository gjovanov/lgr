/**
 * Client for the `lgr-ocr` sidecar (packages/ocr-server, ClusterIP `lgr-ocr:8100`).
 *
 * Every call is time-boxed. The sidecar shells out to poppler/tesseract and then to Claude,
 * which can take ~30s per document; a hung call used to block a request indefinitely
 * because none of the original fetches passed a signal.
 */
import { config } from 'config'
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

export class OcrError extends Error {
  constructor(message: string, readonly stage: 'extract' | 'draft') {
    super(message)
    this.name = 'OcrError'
  }
}

/** PDF bytes → text. `forceOcr` skips the native text layer (junk layers defeat the heuristic). */
export async function ocrExtract(
  pdf: Buffer,
  filename: string,
  opts: { forceOcr?: boolean } = {},
): Promise<ExtractResult> {
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
export async function ocrDraft(text: string, profile?: string): Promise<DraftResult> {
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
