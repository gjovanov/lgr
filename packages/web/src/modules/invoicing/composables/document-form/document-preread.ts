/**
 * FR-30.10: a document is read once as it opens.
 *
 * The sales and purchase forms read a stored document to choose which form mounts (its type, its direction), and the
 * form then read it again to fill itself: two reads of a document of 30 lines. The view hands what it read to the form
 * here. A hand-over is taken once and only for a few seconds, so a later load (after a save, a Back to the same
 * document) reads the document as stored then.
 */

const HANDOVER_MS = 10_000

const handed = new Map<string, { at: number; data: unknown }>()

/** What the view read of document `id`, for the form it is about to mount. */
export function handOverDocument(id: string, data: unknown): void {
  handed.set(id, { at: Date.now(), data })
}

/** The answer the view read for `id`, once, if it is fresh; otherwise null and the form reads the document. */
export function takeHandedDocument<T = any>(id: string): T | null {
  const h = handed.get(id)
  handed.delete(id)
  return h && Date.now() - h.at <= HANDOVER_MS ? (h.data as T) : null
}
