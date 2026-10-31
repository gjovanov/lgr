import type { BaseEntity, Filter, IBatchRepository, PageResult } from 'dal'

/**
 * One page of a repository's rows, ordered by a value a plain find cannot sort by: a price inside
 * an array, the name of the warehouse or contact a row points at.
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

  const ids = ordered.map((d) => String(d._id))
  const found = ids.length ? await repo.findMany({ id: { $in: ids } } as Filter<T>) : []
  const byId = new Map(found.map((row: any) => [String(row.id ?? row._id), row]))
  const items = ids.map((id) => byId.get(id)).filter(Boolean) as T[]

  if (!paged) return { items, total: items.length, page: 0, size: items.length, totalPages: 1 }
  return { items, total, page, size, totalPages: Math.ceil(total / size) }
}
