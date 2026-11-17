/**
 * A whole list of the API, read in pages, for a script that needs every row.
 *
 * A list answer carries at most 1 000 rows (FR-30.8), so "all of them" is read in pages. Pages need an order with no
 * ties: rows whose sort keys are equal come in whatever order the database finds them, which may differ from one skip
 * to the next, so a page repeats a row and leaves another out, and the answers look complete (`total` rows arrive).
 * Only the id has no ties. A list's default sort has them: a creation moment is shared by every row of a seeded
 * batch (one read of 2 861 contacts by `createdAt` returned 150 of them twice and 150 not at all).
 *
 * So this reads by the id, keeps each row once, and holds what it read to the order it asked for and to the list's own
 * count. It throws instead of returning a list it cannot vouch for. A caller that plans from "what is not on file"
 * (the contacts import creates what it does not find) would otherwise make a second copy of every row a short read
 * left out.
 */

/** An org-relative GET that returns the parsed answer (`LgrSession.get`). */
export type ListGet = (path: string) => Promise<any>

export interface WholeListOptions {
  /** Rows to a page. Within the ceiling of a list answer (`LIST_CEILING`, 1 000). */
  size?: number
  /** A bound on the pages read: a list that never ends is an answer this cannot read. */
  maxPages?: number
}

/** The read did not give every row once, in the id's order. Nothing may be planned or written on it. */
export class IncompleteListError extends Error {}

const idOf = (row: any): string => String(row?._id ?? row?.id ?? '')

/**
 * Every row of `path`'s list, once, in the id's order. `key` is the answer's own name for its rows (`contacts`);
 * `items` is read when the answer has no such key.
 */
export async function readWholeList<T = any>(get: ListGet, path: string, key: string, opts: WholeListOptions = {}): Promise<T[]> {
  const size = opts.size ?? 500
  const maxPages = opts.maxPages ?? 2000
  const sep = path.includes('?') ? '&' : '?'
  const rows: T[] = []
  let total: number | undefined
  let last = ''
  let ended = false
  for (let page = 0; page < maxPages; page++) {
    const answer = await get(`${path}${sep}page=${page}&size=${size}&sortBy=_id&sortOrder=asc`)
    const items: any[] = answer?.[key] ?? answer?.items ?? []
    if (typeof answer?.total === 'number') {
      // Pages are cut by a skip. A row that leaves the list while it is read moves every later row one place up, so
      // the next page starts one row late, and the row counts still add up. The list's own count is what shows it.
      if (total !== undefined && answer.total !== total) {
        throw new IncompleteListError(`${path}: the list changed while it was read (it counted ${total}, then ${answer.total} on page ${page}). Read it again`)
      }
      total = answer.total
    }
    for (const item of items) {
      const id = idOf(item)
      if (!id) throw new IncompleteListError(`${path}: a row without an id on page ${page}`)
      // In the id's order every id is above the one before it. One that is not means the server sorted by something
      // else (a list that does not take `sortBy=_id` answers in its default sort), and its pages cannot be trusted.
      if (last && id <= last) {
        throw new IncompleteListError(`${path}: page ${page} is not in the id's order (${id} after ${last}): the server did not sort by the id, so a page may repeat a row and leave another out`)
      }
      last = id
      rows.push(item as T)
    }
    if (items.length < size) { ended = true; break }
  }
  if (!ended) throw new IncompleteListError(`${path}: no last page within ${maxPages} pages of ${size}`)
  if (total !== undefined && rows.length !== total) {
    throw new IncompleteListError(`${path}: read ${rows.length} row(s), the list counts ${total}. Read it again`)
  }
  return rows
}
