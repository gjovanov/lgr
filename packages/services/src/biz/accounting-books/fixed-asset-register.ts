/**
 * FR-25a §4.2: the company's fixed-asset register, from the `ДА` analytics the books import has just stored. One
 * `FixedAsset` per analytic, by `fixed-asset-params.ts#mapFixedAssetParams`, found again by its `importKey` and linked both
 * ways (the asset's `analyticId`, the analytic's `fixedAssetId`).
 *
 * `importAnalytics` runs it in the org that holds the register (the home of a split, or a books org of its own), when
 * the file carries the assets' properties. A store of a split keeps the analytics and makes no asset.
 *
 * What it never does:
 * - write an asset it did not make: every write's filter names the marker (`sourceModule` + `importKey`), and an asset kept
 *   in LGR that already stands for an analytic (the one it points at, or one of its name, as the name link always found
 *   them) is linked as before and left exactly as it is;
 * - delete: an asset whose analytic the file no longer lists stays, and the answer names it (`vanished`);
 * - fail the import over one asset: a value it cannot read, a code the chart does not hold, a code another asset holds, a
 *   race with another import, are each a problem in the answer, and the asset is made from the rest or not at all.
 *
 * A dry run answers the same counts and writes nothing.
 */
import { mongoose } from 'db/connection'
import { Account, AccountingAnalytic, BOOKS_IMPORT, FixedAsset } from 'db/models'
import { canMakeAsset, mapFixedAssetParams, type FixedAssetField, type FixedAssetFields, type FixedAssetProblem } from './fixed-asset-params.js'
import { nameOfPath } from './registry.js'
import type { FixedAssetRegisterCounts, FixedAssetRegisterProblem } from './import.types.js'

type Id = mongoose.Types.ObjectId
type Params = { key: string; value: string }[]

const KEY_PREFIX = 'analytic|'

/** What an imported asset is found by again: the analytic's path, as booked. */
export const fixedAssetImportKey = (path: string) => `${KEY_PREFIX}${path}`

/** An imported asset's code: its analytic's path, which no other analytic of the org has. */
export const fixedAssetCode = (path: string) => path

/** An asset the books import made. Any other is kept in LGR, and the import never writes it. */
export const isImportedAsset = (a: { sourceModule?: unknown; importKey?: unknown }) => a.sourceModule === BOOKS_IMPORT && typeof a.importKey === 'string'

export interface RegisterItem {
  path: string
  /** What the analytic holds after this import: the file's properties, or the stored ones where the file lists none. */
  params: Params
  /** The analytic, when it exists: a dry run has none for a path it would create. */
  analyticId?: Id
  /** What the analytic points at now. */
  fixedAssetId?: string
}

export interface RegisterAnswer extends FixedAssetRegisterCounts {
  linked: number
  unlinked: number
}

/** What the import writes on an asset of its own, and compares to call it unchanged. */
const MANAGED: readonly FixedAssetField[] = [
  'accountId', 'depreciationAccountId', 'accumulatedDepAccountId', 'category', 'depreciationMethod', 'purchaseDate', 'purchasePrice',
  'currency', 'usefulLifeMonths', 'currentValue', 'status', 'disposalDate', 'taxCategory', 'inServiceDate', 'taxDepreciationRate',
  'taxValue', 'taxUsefulLifeMonths', 'params',
]

/** Required by the model: a value the books do not state now is kept, never unset. */
const KEPT = new Set<FixedAssetField>([
  'accountId', 'depreciationAccountId', 'accumulatedDepAccountId', 'category', 'depreciationMethod', 'purchaseDate', 'purchasePrice',
  'currency', 'usefulLifeMonths', 'currentValue', 'status',
])

const PROJECTION = Object.fromEntries(['code', 'name', 'sourceModule', 'importKey', 'analyticId', ...MANAGED].map(f => [f, 1]))

/** A stored value against the one the books state: dates by instant, ids by value, properties pair by pair. */
function same(held: unknown, want: unknown): boolean {
  if (want instanceof Date) return held instanceof Date && held.getTime() === want.getTime()
  // An id by its hex, whichever copy of bson made it: a lean read's and a model's need not be one class.
  if (typeof (want as { toHexString?: unknown })?.toHexString === 'function') return held != null && String(held) === String(want)
  if (Array.isArray(want)) {
    const pairs = (list: unknown) => JSON.stringify((Array.isArray(list) ? list : []).map((p: any) => [p?.key, p?.value ?? '']))
    return pairs(held) === pairs(want)
  }
  return held === want
}

/**
 * The update that makes an asset of the import's say what the books say, or null. A field the books state is set; one
 * they no longer state is unset, unless it is required or a problem left it unknown: those keep what they hold.
 */
function updateOf(stored: Record<string, any>, fields: Partial<FixedAssetFields<Id>>, problems: FixedAssetProblem[], analyticId?: Id) {
  const unknown = new Set(problems.flatMap(p => p.fields))
  const $set: Record<string, unknown> = {}
  const $unset: Record<string, 1> = {}
  for (const field of MANAGED) {
    const want = fields[field]
    if (want !== undefined) {
      if (!same(stored[field], want)) $set[field] = want
    } else if (!KEPT.has(field) && !unknown.has(field) && stored[field] != null) {
      $unset[field] = 1
    }
  }
  if (analyticId && String(stored.analyticId ?? '') !== String(analyticId)) $set.analyticId = analyticId
  if (!Object.keys($set).length && !Object.keys($unset).length) return null
  return { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }
}

/** A new asset of the import's. Its value starts at its price where the books' opening could not be read, as LGR's own do. */
function newAsset(orgId: Id, item: RegisterItem, fields: Partial<FixedAssetFields<Id>>) {
  return {
    _id: new mongoose.Types.ObjectId(),
    orgId,
    code: fixedAssetCode(item.path),
    name: nameOfPath(item.path),
    ...fields,
    currentValue: fields.currentValue ?? fields.purchasePrice,
    status: fields.status ?? 'active',
    sourceModule: BOOKS_IMPORT,
    importKey: fixedAssetImportKey(item.path),
    ...(item.analyticId ? { analyticId: item.analyticId } : {}),
  }
}

/** Each `ДА` analytic of the file, as an asset of the register. See the header for what it never does. */
export async function syncFixedAssetRegister(orgId: string, given: readonly RegisterItem[], dryRun: boolean): Promise<RegisterAnswer> {
  const org = new mongoose.Types.ObjectId(orgId)
  const answer: RegisterAnswer = { linked: 0, unlinked: 0, created: 0, updated: 0, unchanged: 0, problems: [] }
  // One per path, the last as the analytics import keeps it.
  const items = [...new Map(given.map(i => [i.path, i])).values()]

  const assets: any[] = await FixedAsset.find({ orgId }, PROJECTION).lean()
  const own = new Map<string, any>()
  const kept = new Map<string, any>()
  // The last of a name, as the name link has always taken it.
  const keptByName = new Map<string, any>()
  const codes = new Set<string>()
  for (const a of assets) {
    codes.add(a.code)
    if (isImportedAsset(a)) own.set(a.importKey, a)
    else {
      kept.set(String(a._id), a)
      keptByName.set(a.name, a)
    }
  }
  const chart = new Map<string, Id>((await Account.find({ orgId }, { code: 1 }).lean()).map((a: any) => [a.code as string, a._id]))

  const report = (path: string, p: { key?: string; reason: string; code?: string }) => {
    answer.problems.push({ path, ...(p.key ? { key: p.key } : {}), reason: p.reason, ...(p.code ? { code: p.code } : {}) })
  }
  const inserts: { doc: ReturnType<typeof newAsset>; path: string }[] = []
  const updates: any[] = []
  const links = new Map<string, { analyticId: Id; assetId: Id }>()
  const link = (item: RegisterItem, assetId: Id) => {
    if (!item.analyticId || String(item.fixedAssetId ?? '') === String(assetId)) return false
    links.set(item.path, { analyticId: item.analyticId, assetId })
    return true
  }

  for (const item of items) {
    const importKey = fixedAssetImportKey(item.path)
    const { fields, problems } = mapFixedAssetParams<Id>(item.params, chart)
    const name = nameOfPath(item.path)

    const mine = own.get(importKey)
    if (mine) {
      for (const p of problems) report(item.path, p)
      const update = updateOf(mine, fields, problems, item.analyticId)
      if (update) updates.push({ updateOne: { filter: { _id: mine._id, orgId: org, sourceModule: BOOKS_IMPORT, importKey }, update } })
      const relinked = link(item, mine._id)
      answer[update || relinked ? 'updated' : 'unchanged']++
      if (keptByName.has(name)) report(item.path, { reason: 'native_namesake' })
      continue
    }

    // An asset kept in LGR already stands for the analytic: the books link it as before, and never write it.
    const native = (item.fixedAssetId ? kept.get(item.fixedAssetId) : undefined) ?? keptByName.get(name)
    if (native) {
      answer.linked++
      link(item, native._id)
      report(item.path, { reason: 'native_asset' })
      continue
    }

    for (const p of problems) report(item.path, p)
    if (!canMakeAsset(fields)) {
      answer.unlinked++
      continue
    }
    const doc = newAsset(org, item, fields)
    if (codes.has(doc.code)) {
      answer.unlinked++
      report(item.path, { reason: 'code_taken' })
      continue
    }
    const invalid = new FixedAsset(doc).validateSync()
    if (invalid) {
      answer.unlinked++
      report(item.path, { key: Object.keys(invalid.errors)[0], reason: 'invalid' })
      continue
    }
    codes.add(doc.code)
    answer.created++
    inserts.push({ doc, path: item.path })
    link(item, doc._id)
  }

  // An asset the import made whose analytic the file no longer lists: left as it is, and named.
  const listed = new Set(items.map(i => fixedAssetImportKey(i.path)))
  for (const key of [...own.keys()].filter(k => !listed.has(k)).sort()) answer.problems.push({ path: key.slice(KEY_PREFIX.length), reason: 'vanished' })

  if (dryRun) return answer

  for (const { doc, path } of inserts) {
    try {
      await FixedAsset.create(doc)
    } catch (e: any) {
      if (e?.code !== 11000) throw e
      // Another import made it, or took its code, since this one read: the next run finds it.
      answer.created--
      answer.unlinked++
      links.delete(path)
      report(path, { reason: 'conflict' })
    }
  }
  if (updates.length) await FixedAsset.bulkWrite(updates)
  if (links.size) {
    await AccountingAnalytic.bulkWrite([...links.values()].map(l => ({
      updateOne: { filter: { _id: l.analyticId, orgId: org }, update: { $set: { fixedAssetId: l.assetId } } },
    })))
  }
  return answer
}
