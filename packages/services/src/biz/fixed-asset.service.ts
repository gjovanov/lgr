/**
 * FR-25a §3.4: the fixed-asset grid's list on the server, with its filters: the tax category, and whether the books import
 * made the asset or it is kept in LGR.
 *
 * The rules of an asset's tax side are `config/fixed-asset-tax.ts`, which the asset form shares; what marks an asset of
 * the books is the import's own rule (`accounting-books/fixed-asset-register.ts#isImportedAsset`). This file only asks
 * Mongo.
 */
import { BOOKS_IMPORT, FixedAsset } from 'db/models'
import { taxCategoryCode } from 'config/fixed-asset-tax'
import { isImportedAsset } from './accounting-books/fixed-asset-register.js'
import { buildSearchFilter } from './search.utils'

/**
 * What the grid shows of an asset: everything but the file's properties and the schedule, which only the form reads.
 * An asset of the books carries about 35 properties, and a page of them is what the grid reads every time it moves.
 */
export const FIXED_ASSET_LIST_PROJECTION = { params: 0, depreciationSchedule: 0, __v: 0 } as const

/**
 * What the import marks its own assets with, as a match: the rule of `isImportedAsset`. A new object each time: a query
 * may cast its filter in place.
 */
export const importedAssetMatch = () => ({ sourceModule: BOOKS_IMPORT, importKey: { $type: 'string' } })

/** An asset kept in LGR: the guard every write to one names, so a write never lands on an asset of the books. */
export const nativeAssetMatch = () => ({ $nor: [importedAssetMatch()] })

export interface FixedAssetListQuery {
  search?: unknown
  /** `1`–`7`, or `none`: the assets with no tax category. */
  taxCategory?: unknown
  /** `true`: the assets the books import made; `false`: the ones kept in LGR. */
  imported?: unknown
  page?: unknown
  size?: unknown
  sortBy?: unknown
  sortOrder?: unknown
}

/** The columns the grid sorts by. Anything else sorts as the list always has, the newest first. */
export const FIXED_ASSET_SORTS = [
  'code', 'name', 'category', 'purchaseDate', 'purchasePrice', 'currentValue', 'currency', 'status', 'usefulLifeMonths',
  'taxCategory', 'taxDepreciationRate', 'taxUsefulLifeMonths', 'taxValue', 'inServiceDate', 'createdAt', 'updatedAt',
] as const

const flag = (v: unknown): boolean | undefined => {
  if (v === true || v === 'true' || v === '1') return true
  if (v === false || v === 'false' || v === '0') return false
  return undefined
}

/** The list's filter. A tax category it does not know matches nothing, rather than being dropped and matching every asset. */
export function fixedAssetListFilter(orgId: string, q: FixedAssetListQuery): Record<string, any> {
  const filter: Record<string, any> = { orgId }
  if (typeof q.search === 'string' && q.search.trim()) {
    Object.assign(filter, buildSearchFilter(q.search, ['code', 'name', 'description']))
  }
  if (typeof q.taxCategory === 'string' && q.taxCategory.trim()) {
    const asked = q.taxCategory.trim()
    // `$in: [null, '']`: a missing field, a null and an empty text are each "no category".
    filter.taxCategory = asked === 'none' ? { $in: [null, ''] } : (taxCategoryCode(asked) ?? { $in: [] })
  }
  const imported = flag(q.imported)
  if (imported === true) Object.assign(filter, importedAssetMatch())
  if (imported === false) Object.assign(filter, nativeAssetMatch())
  return filter
}

/** The order of a page. Every sort ends in `_id`, so a page is stable where the column ties. */
export function fixedAssetListSort(q: FixedAssetListQuery): Record<string, 1 | -1> {
  const sortBy = (FIXED_ASSET_SORTS as readonly string[]).includes(String(q.sortBy)) ? String(q.sortBy) : 'createdAt'
  return { [sortBy]: q.sortOrder === 'asc' ? 1 : -1, _id: 1 }
}

/** "All" is a backstop, not a promise. */
const MAX_ROWS = 100_000

/**
 * A stored asset as the grid reads it: its id as `_id` and `id` (as the repositories map one, `dal-mongo#toEntity`), and
 * whether the books import made it (`imported`), which is what the grid locks.
 */
function rowOf(doc: Record<string, any>) {
  return { ...doc, _id: String(doc._id), id: String(doc._id), imported: isImportedAsset(doc) }
}

/** A page of the register, as the grid shows it. The shape of `IRepository#findAll`'s answer; `size` 0 is every row. */
export async function listFixedAssets(orgId: string, q: FixedAssetListQuery) {
  const filter = fixedAssetListFilter(orgId, q)
  const page = Math.max(0, Math.floor(Number(q.page)) || 0)
  const asked = q.size === undefined || q.size === '' ? 10 : Number(q.size)
  const size = Number.isFinite(asked) ? Math.floor(asked) : 10
  const find = () => FixedAsset.find(filter, FIXED_ASSET_LIST_PROJECTION).sort(fixedAssetListSort(q))

  if (size <= 0) {
    const docs = await find().limit(MAX_ROWS).lean()
    return { items: docs.map(rowOf), total: docs.length, page: 0, size: docs.length, totalPages: 1 }
  }
  const [docs, total] = await Promise.all([
    find().skip(page * size).limit(size).lean(),
    FixedAsset.countDocuments(filter),
  ])
  return { items: docs.map(rowOf), total, page, size, totalPages: Math.ceil(total / size) }
}
