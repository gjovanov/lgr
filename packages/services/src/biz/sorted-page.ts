import type { BaseEntity, Filter, IBatchRepository, PageResult } from 'dal'

/**
 * One page of a repository's rows, ordered by a value a plain find cannot sort by: a price inside
 * an array, the name of the warehouse or contact a row points at, a product's stock.
 *
 * `keyStages` are aggregation stages that set `sortKey` on each row. A row without one (null,
 * missing, or an empty string) goes last in either direction; ties fall to `tieBreak`, then `_id`.
 * An aggregation orders the ids and cuts the page; the rows themselves come from the repository's
 * usual read, so a sorted page carries exactly what an unsorted one does.
 */
export async function findPageSortedBy<T extends BaseEntity>(
  repo: IBatchRepository<T>,
  filter: Filter<T>,
  keyStages: Record<string, unknown>[],
  order: 1 | -1,
  page: number,
  size: number,
  tieBreak: Record<string, 1 | -1> = {},
): Promise<PageResult<T>> {
  const paged = size > 0
  const [ordered, total] = await Promise.all([
    repo.aggregate<{ _id: unknown }>([
      { $match: filter },
      ...keyStages,
      // Only what the order needs goes through the sort.
      { $project: { sortKey: 1, ...Object.fromEntries(Object.keys(tieBreak).map((k) => [k, 1])) } },
      { $addFields: { noKey: { $cond: [{ $in: [{ $ifNull: ['$sortKey', null] }, [null, '']] }, 1, 0] } } },
      { $sort: { noKey: 1, sortKey: order, ...tieBreak, _id: 1 } },
      ...(paged ? [{ $skip: page * size }, { $limit: size }] : []),
      { $project: { _id: 1 } },
    ] as any),
    paged ? repo.count(filter) : Promise.resolve(-1),
  ])

  const items = await loadInOrder(repo, ordered.map((d) => String(d._id)))

  if (!paged) return { items, total: items.length, page: 0, size: items.length, totalPages: 1 }
  return { items, total, page, size, totalPages: Math.ceil(total / size) }
}

/**
 * `findPageSortedBy` for a key computed outside the database: `keys` maps a row's id to its value,
 * for a figure a service already computes, which an aggregation could only copy. Every row the
 * filter matches is ranked before the page is cut, by the same rules: a row the map does not name
 * goes last in either direction, and ties fall to `tieBreak` (ascending), then the id.
 */
export async function findPageSortedByKeys<T extends BaseEntity>(
  repo: IBatchRepository<T>,
  filter: Filter<T>,
  keys: ReadonlyMap<string, number>,
  order: 1 | -1,
  page: number,
  size: number,
  tieBreak: string,
): Promise<PageResult<T>> {
  const rows = await repo.aggregate<{ _id: unknown; tie?: unknown }>([
    { $match: filter },
    { $project: { tie: `$${tieBreak}` } },
  ] as any)
  const ranked = rows.map((r) => {
    const id = String(r._id)
    return { id, key: keys.get(id), tie: r.tie == null ? '' : String(r.tie) }
  })
  ranked.sort((a, b) =>
    Number(a.key === undefined) - Number(b.key === undefined)
    || (a.key !== undefined && b.key !== undefined ? (a.key - b.key) * order : 0)
    || compare(a.tie, b.tie)
    || compare(a.id, b.id))

  const paged = size > 0
  const items = await loadInOrder(repo, (paged ? ranked.slice(page * size, (page + 1) * size) : ranked).map((r) => r.id))
  if (!paged) return { items, total: items.length, page: 0, size: items.length, totalPages: 1 }
  return { items, total: ranked.length, page, size, totalPages: Math.ceil(ranked.length / size) }
}

/** Code-unit order, which is how `$sort` orders strings without a collation. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The rows with these ids, from the repository's usual read, in the order given. */
async function loadInOrder<T extends BaseEntity>(repo: IBatchRepository<T>, ids: string[]): Promise<T[]> {
  const found = ids.length ? await repo.findMany({ id: { $in: ids } } as Filter<T>) : []
  const byId = new Map(found.map((row: any) => [String(row.id ?? row._id), row]))
  return ids.map((id) => byId.get(id)).filter(Boolean) as T[]
}
