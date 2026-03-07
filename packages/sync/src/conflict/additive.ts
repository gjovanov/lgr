import type { ResolvedConflict, ConflictStrategy } from './resolver.js'

/**
 * Additive merge for numeric fields (stock quantities, balances).
 * Instead of picking one value, compute: base + localDelta + remoteDelta.
 * Non-additive fields use LWW.
 */
export class AdditiveStrategy implements ConflictStrategy {
  constructor(private additiveFields: string[]) {}

  resolve(
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    localTimestamp: string,
    remoteTimestamp: string,
    base?: Record<string, unknown>,
  ): ResolvedConflict {
    if (!base) {
      // Without a base, fall back to LWW — can't compute deltas
      const winner = remoteTimestamp > localTimestamp ? remote : local
      return {
        resolution: remoteTimestamp > localTimestamp ? 'remote_wins' : 'local_wins',
        data: { ...winner },
      }
    }

    const merged: Record<string, unknown> = { ...base }

    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      if (this.additiveFields.includes(key)) {
        // Additive merge: base + localDelta + remoteDelta
        const baseVal = (base[key] as number) ?? 0
        const localVal = (local[key] as number) ?? 0
        const remoteVal = (remote[key] as number) ?? 0
        const localDelta = localVal - baseVal
        const remoteDelta = remoteVal - baseVal
        merged[key] = baseVal + localDelta + remoteDelta
      } else {
        // Non-additive: LWW
        const localChanged = local[key] !== base[key]
        const remoteChanged = remote[key] !== base[key]

        if (localChanged && remoteChanged) {
          merged[key] = remoteTimestamp > localTimestamp ? remote[key] : local[key]
        } else if (localChanged) {
          merged[key] = local[key]
        } else if (remoteChanged) {
          merged[key] = remote[key]
        }
      }
    }

    return {
      resolution: 'merged',
      data: merged,
    }
  }
}
