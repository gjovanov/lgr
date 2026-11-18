import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IncompleteListError, readWholeList } from '../../../../scripts/lib/whole-list'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'

/**
 * A script that needs every row of a list reads it in pages (a list answer carries at most 1 000 rows, FR-30.8).
 * `readWholeList` reads by the id, the one order with no ties, and refuses a read it cannot vouch for.
 *
 * Why it matters: the contacts import creates what it does not find on file. Read by `createdAt`, which every contact
 * of a seeded batch shares, a real list of 2 861 contacts came back with 150 of them twice and 150 missing, with the
 * right number of rows. Each missing one would have been created a second time.
 */

type Row = { _id: string; createdAt: string; name?: string }

/** Ids as the database makes them: 24 hex characters, ascending in the order made. */
const oid = (n: number) => n.toString(16).padStart(24, '0')
const rowsOf = (count: number, createdAt: (n: number) => string = () => '2026-07-21T10:00:00.000Z'): Row[] =>
  Array.from({ length: count }, (_, i) => ({ _id: oid(i + 1), createdAt: createdAt(i + 1), name: `row ${i + 1}` }))

/**
 * A stand-in for a list route. It sorts by the id when asked to. Any other sort is answered the way a database answers
 * a sort with ties and no index: the tied rows in an order that depends on the skip (`tiedOrder`), so two pages overlap.
 */
function fakeList(all: Row[], opts: { key?: string; ignoresId?: boolean; withoutTotal?: boolean; removeAfterPage?: number } = {}) {
  const calls: string[] = []
  let rows = [...all]
  const tiedOrder = (list: Row[], skip: number) => {
    // Same sort key for all: the order among them is whatever the scan gives, here rotated by the skip.
    const shift = skip ? 3 : 0
    return [...list.slice(shift), ...list.slice(0, shift)]
  }
  const get = async (path: string) => {
    calls.push(path)
    const q = new URL('http://x' + path).searchParams
    const page = Number(q.get('page') ?? 0), size = Number(q.get('size') ?? 10)
    const byId = q.get('sortBy') === '_id' && !opts.ignoresId
    const ordered = byId ? [...rows].sort((a, b) => (a._id < b._id ? -1 : 1)) : tiedOrder(rows, page * size)
    const answer = { [opts.key ?? 'contacts']: ordered.slice(page * size, (page + 1) * size), ...(opts.withoutTotal ? {} : { total: rows.length }) }
    if (opts.removeAfterPage === page) rows = rows.slice(1) // somebody removed the first row while the list was read
    return answer
  }
  return { get, calls }
}

describe('a whole list is read by the id, every row once', () => {
  it('reads every row once, over the pages it takes, and asks for the id ascending', async () => {
    const api = fakeList(rowsOf(23))
    const rows = await readWholeList<Row>(api.get, '/invoicing/contact', 'contacts', { size: 10 })
    expect(rows.map((r) => r._id)).toEqual(rowsOf(23).map((r) => r._id))
    expect(api.calls).toEqual([
      '/invoicing/contact?page=0&size=10&sortBy=_id&sortOrder=asc',
      '/invoicing/contact?page=1&size=10&sortBy=_id&sortOrder=asc',
      '/invoicing/contact?page=2&size=10&sortBy=_id&sortOrder=asc',
    ])
  })

  it('ends on an empty page when the list is a whole number of pages', async () => {
    const api = fakeList(rowsOf(20))
    const rows = await readWholeList<Row>(api.get, '/invoicing/contact', 'contacts', { size: 10 })
    expect(rows).toHaveLength(20)
    expect(api.calls).toHaveLength(3)
  })

  it('reads an empty list as empty', async () => {
    expect(await readWholeList(fakeList([]).get, '/invoicing/contact', 'contacts')).toEqual([])
  })

  it('keeps a query the path already has, and reads an answer that names its rows `items`', async () => {
    const api = fakeList(rowsOf(3), { key: 'items' })
    const rows = await readWholeList<Row>(api.get, '/invoicing/contact?type=supplier', 'contacts', { size: 10 })
    expect(rows).toHaveLength(3)
    expect(api.calls[0]).toBe('/invoicing/contact?type=supplier&page=0&size=10&sortBy=_id&sortOrder=asc')
  })

  it('pages of 500 by default, inside the ceiling of a list answer', async () => {
    const api = fakeList(rowsOf(2))
    await readWholeList(api.get, '/invoicing/contact', 'contacts')
    expect(api.calls[0]).toContain('size=500')
  })
})

describe('a read it cannot vouch for is refused, not returned', () => {
  it('the same list read by a tied key repeats rows and leaves others out, with the right number of rows', async () => {
    // What the contacts import did before: pages by `createdAt`, appended, until `total` rows arrived.
    const api = fakeList(rowsOf(23))
    const read: string[] = []
    for (let page = 0; ; page++) {
      const d = await api.get(`/invoicing/contact?size=10&page=${page}&sortBy=createdAt&sortOrder=asc`)
      read.push(...d.contacts.map((c: Row) => c._id))
      if (d.contacts.length < 10 || read.length >= d.total) break
    }
    expect(read).toHaveLength(23) // it looks complete
    expect(new Set(read).size).toBeLessThan(23) // and is not: rows twice, as many missing
  })

  it('refuses a server that does not sort by the id', async () => {
    const api = fakeList(rowsOf(23), { ignoresId: true })
    const err = await captureRejection(readWholeList(api.get, '/invoicing/contact', 'contacts', { size: 10 }))
    expectRejection(err, IncompleteListError)
    expect(String(err.message)).toContain("not in the id's order")
  })

  it('refuses when a row left the list while it was read, though the rows that arrive add up', async () => {
    // The first row goes after page 0: every later row moves one place up, so page 1 starts one row late. 22 rows
    // arrive for a list that now counts 22, in the id's order, and one of them was never read.
    const api = fakeList(rowsOf(23), { removeAfterPage: 0 })
    const err = await captureRejection(readWholeList(api.get, '/invoicing/contact', 'contacts', { size: 10 }))
    expectRejection(err, IncompleteListError)
    expect(String(err.message)).toContain('the list changed while it was read (it counted 23, then 22 on page 1)')
  })

  it('refuses rows that do not add up to the list\'s count', async () => {
    const get = async (path: string) => {
      const page = Number(new URL('http://x' + path).searchParams.get('page'))
      return { contacts: page === 0 ? rowsOf(2) : [], total: 5 }
    }
    expectRejection(await captureRejection(readWholeList(get, '/x', 'contacts', { size: 2 })), 'read 2 row(s), the list counts 5')
  })

  it('refuses a row without an id', async () => {
    const get = async () => ({ contacts: [{ companyName: 'no id' }], total: 1 })
    expectRejection(await captureRejection(readWholeList(get, '/invoicing/contact', 'contacts')), 'a row without an id')
  })

  it('refuses a list with no last page inside its bound', async () => {
    let n = 0
    const get = async () => ({ contacts: Array.from({ length: 2 }, () => ({ _id: oid(++n) })) })
    expectRejection(await captureRejection(readWholeList(get, '/x', 'contacts', { size: 2, maxPages: 3 })), 'no last page within 3 pages')
  })

  it('reads an answer that carries no total, still held to the order', async () => {
    const rows = await readWholeList<Row>(fakeList(rowsOf(7), { withoutTotal: true }).get, '/x', 'contacts', { size: 5 })
    expect(rows).toHaveLength(7)
    const err = await captureRejection(readWholeList(fakeList(rowsOf(7), { withoutTotal: true, ignoresId: true }).get, '/x', 'contacts', { size: 5 }))
    expectRejection(err, IncompleteListError)
  })
})

describe('the contacts import reads its contacts that way', () => {
  const source = readFileSync(join(import.meta.dir, '../../../../scripts/import-contacts-api.ts'), 'utf8')

  it('through readWholeList, and by no page loop of its own', () => {
    expect(source).toContain("readWholeList(s.get, '/invoicing/contact', 'contacts')")
    // A page loop over the contact list in this file is the bug coming back: it has no way to know a row was left out.
    expect(source).not.toMatch(/invoicing\/contact\?[^`'"]*page=/)
    expect(source).not.toMatch(/sortBy=createdAt/)
  })

  it('and gives the plan the oldest contact first, as it always did', () => {
    // The read is in the id's order; the plan was always given creation order (`sortBy=createdAt&sortOrder=asc`).
    expect(source).toMatch(/createdAt[\s\S]{0,400}\.sort\(/)
  })
})
