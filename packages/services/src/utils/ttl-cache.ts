/**
 * FR-30.15 / .16: a value kept for a while per key, in this process.
 *
 * What is kept is the promise, so callers that ask at the same moment share one read. A read that fails is not kept:
 * the next caller reads again. Each pod keeps its own; a value is at most `ttlMs` old.
 */
export interface TtlCache<V> {
  get(key: string, load: () => Promise<V>): Promise<V>
  /** Forget one key, or every key. */
  forget(key?: string): void
}

export function ttlCache<V>(ttlMs: number, now: () => number = Date.now): TtlCache<V> {
  const kept = new Map<string, { at: number; value: Promise<V> }>()
  return {
    get(key, load) {
      const hit = kept.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value
      const value = load()
      kept.set(key, { at: now(), value })
      value.catch(() => { if (kept.get(key)?.value === value) kept.delete(key) })
      return value
    },
    forget(key) {
      if (key === undefined) kept.clear()
      else kept.delete(key)
    },
  }
}
