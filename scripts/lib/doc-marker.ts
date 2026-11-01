/**
 * Reading a PlusMinus document's idempotency marker back out of a stock movement.
 *
 * A booked document leaves `<family>:<number>` in the movement's notes (and, from the Files app,
 * `<family>_<number>[.pdf]` in its reference). The SAME document has been written two ways:
 *   - the PDF-era flow used the number as PRINTED, zero-padded to ten digits: `sklrazp:0000012705`
 *   - the direct-API flow uses `header.docNumber`, unpadded:                    `sklrazp:12705`
 * A plain `notes.includes('sklrazp:12705')` therefore misses every transfer or write-off booked the
 * old way, and a re-run books all of them a second time. On regal-pz (2026-11-01) a dry-run of
 * `transfer-stock-api.ts` over October reported "56 to book, 3 skipped" for a month in which all but
 * three transfers were already in — executing it would have dispatched ~50 transfers twice.
 *
 * So compare NUMERICALLY: strip the padding and any suffix (`<number>rcl`, `…-fix`) and look at the
 * digits only. A different number that merely CONTAINS these digits (127055 vs 12705) never matches,
 * because the digit run is read whole.
 */

/** Every document number `family` markers in these texts point at. */
export function docMarkerNumbers(family: string, ...texts: Array<string | null | undefined>): number[] {
  const re = new RegExp(`${family}[:_]0*(\\d+)`, 'gi')
  const out: number[] = []
  for (const t of texts) for (const m of String(t ?? '').matchAll(re)) out.push(Number(m[1]))
  return out
}

/** True when a movement's notes/reference carry a `family` marker for this document number. */
export function hasDocMarker(family: string, number: string | number, ...texts: Array<string | null | undefined>): boolean {
  const n = Number(String(number).trim())
  return Number.isFinite(n) && docMarkerNumbers(family, ...texts).includes(n)
}

/**
 * Every document number already booked for `family`, across all movements of `type` (movement
 * number of the first match kept, for the "already booked: SM-…" message). One paged read of the
 * type, instead of a substring search per document that cannot see the other padding.
 */
export async function loadBookedDocNumbers(
  getPage: (page: number, size: number) => Promise<{ movements: any[]; total?: number }>,
  family: string,
  size = 500,
): Promise<Map<number, string>> {
  const booked = new Map<number, string>()
  for (let page = 0; page < 400; page++) {
    const { movements, total } = await getPage(page, size)
    for (const m of movements) {
      for (const n of docMarkerNumbers(family, m.notes, m.reference)) {
        if (!booked.has(n)) booked.set(n, String(m.movementNumber || m.number || m._id || m.id || '?'))
      }
    }
    if (movements.length < size || (total != null && (page + 1) * size >= total)) break
  }
  return booked
}
