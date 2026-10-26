import { Invoice } from 'db/models'
import { mongoose } from 'db/connection'
import { getRepos } from '../context.js'

const { Types } = mongoose

/**
 * FR-22.25: a document's partner picker shows the right side first, by recent use — the customers
 * of the latest sales documents on an outgoing document, the suppliers of the latest bills on an
 * incoming one. The list used to open on the newest contacts in the org, suppliers mixed in, so the
 * customer at the counter was typed every time.
 *
 * Order: the contacts of this side's most recent documents (the latest first), then the rest of the
 * side by name, then everyone else by name. `filter` is the list's own (search, tags, an explicit
 * type): the order applies within what it matches. "Recent" is the org's documents, not the user's:
 * the staff at one counter serve the same customers.
 */
export type PickerSide = 'customer' | 'supplier'

/** How far back "recently used" looks, and how many recently used contacts lead the list at most. */
const RECENT_DAYS = 365
const RECENT_LIMIT = 50

const BY_NAME = { companyNameLower: 1, lastNameLower: 1, firstNameLower: 1 } as const

/** The contacts this side's documents were made for, the most recently used first. */
export async function recentContactIds(orgId: string, side: PickerSide, limit = RECENT_LIMIT): Promise<string[]> {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000)
  const rows = await Invoice.aggregate([
    // {orgId, direction, issueDate} is indexed.
    {
      $match: {
        orgId: new Types.ObjectId(orgId),
        direction: side === 'customer' ? 'outgoing' : 'incoming',
        issueDate: { $gte: since },
        contactId: { $ne: null },
      },
    },
    { $group: { _id: '$contactId', last: { $max: '$issueDate' }, entered: { $max: '$createdAt' } } },
    { $sort: { last: -1, entered: -1 } },
    { $limit: limit },
  ]).exec()
  return rows.map((row: any) => String(row._id))
}

export interface PickerPage {
  items: any[]
  total: number
  page: number
  size: number
  totalPages: number
}

/** One page of `filter`'s contacts in the picker's order (see above). */
export async function pickerContacts(orgId: string, filter: Record<string, any>, side: PickerSide, page: number, size: number): Promise<PickerPage> {
  const r = getRepos()
  const want = (page + 1) * size
  const recent = await recentContactIds(orgId, side)
  const rank = new Map(recent.map((id, i) => [id, i]))

  const used = recent.length ? await r.contacts.findMany({ ...filter, id: { $in: recent } } as any) : []
  used.sort((a: any, b: any) => (rank.get(String(a.id)) ?? 0) - (rank.get(String(b.id)) ?? 0))
  const out: any[] = used.slice(0, want)
  const exclude = used.map((c: any) => c.id)

  // An explicit type in the filter is the caller's own choice of side: nothing else is listed.
  const groups = filter.type
    ? [filter]
    : [{ ...filter, type: { $in: [side, 'both'] } }, { ...filter, type: { $nin: [side, 'both'] } }]
  for (const group of groups) {
    if (out.length >= want) break
    const rest = await r.contacts.findAll({ ...group, ...(exclude.length ? { id: { $nin: exclude } } : {}) } as any, {
      page: 0,
      size: want - out.length,
      sort: BY_NAME as any,
    })
    out.push(...rest.items)
  }

  const total = (await r.contacts.findAll(filter as any, { page: 0, size: 1 })).total
  return { items: out.slice(page * size, want), total, page, size, totalPages: Math.ceil(total / size) }
}
