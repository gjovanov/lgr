import { mongoose } from '../connection.js'
import { GUARD_INDEXES, sameKey } from './guard-indexes.js'

/**
 * FR-29.24: the indexes every model declares, verified after connect.
 *
 * `autoIndex` builds each schema's indexes in the background once a model meets its connection, and nothing awaited
 * those builds or read their errors. A unique index that cannot build over rows that clash is simply absent. Here every
 * model's build (`Model.init()`) is awaited, and each declared index is looked for in the collection: one that is not
 * there is a failure, with the model, the index and the build's reason. Guard indexes (`./guard-indexes.ts`) are
 * flagged apart (FR-29.25, D-7). The server starts regardless; health says what is missing.
 */
export interface IndexFailure {
  model: string
  index: string
  reason: string
  /** What the index guards, when it is a guard index (FR-29.25). */
  guards?: string
}

export interface IndexReport {
  checkedAt: Date
  models: number
  failures: IndexFailure[]
}

let last: IndexReport | null = null

/** The last verification's report, or null before the first. */
export function lastIndexReport(): IndexReport | null {
  return last
}

const nameOf = (key: Record<string, unknown>) => Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_')

/** Await every model's index build and report what is missing. Never throws. */
export async function verifyIndexes(opts: { models?: string[] } = {}): Promise<IndexReport> {
  const names = opts.models ?? mongoose.modelNames()
  const failures: IndexFailure[] = []
  for (const name of names) {
    const model = mongoose.model(name)
    let reason = ''
    try {
      await model.init()
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e)
    }
    let existing: Array<{ key: Record<string, unknown> }> = []
    try {
      existing = (await model.collection.indexes()) as Array<{ key: Record<string, unknown> }>
    } catch (e) {
      // A collection that does not exist yet has no indexes to read; its build made none either.
      const code = (e as { codeName?: string })?.codeName
      if (code !== 'NamespaceNotFound') reason ||= e instanceof Error ? e.message : String(e)
    }
    for (const [fields, options] of model.schema.indexes()) {
      const key = fields as Record<string, unknown>
      if (Object.values(key).some(v => v === 'text')) continue
      if (existing.some(ix => sameKey(ix.key, key))) continue
      // No collection yet: nothing clashes, the index is made with the first write.
      if (!existing.length && !reason) continue
      const index = (options as { name?: string })?.name ?? nameOf(key)
      const guard = GUARD_INDEXES.find(g => g.model === name && sameKey(g.key, key))
      failures.push({ model: name, index, reason: reason || 'not built', ...(guard ? { guards: guard.guards } : {}) })
    }
  }
  last = { checkedAt: new Date(), models: names.length, failures }
  return last
}
