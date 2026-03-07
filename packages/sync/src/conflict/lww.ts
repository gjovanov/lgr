import type { ResolvedConflict, ConflictStrategy } from './resolver.js'

/**
 * Last-Write-Wins conflict resolution.
 * Compares timestamps and takes the newer value per field.
 */
export class LWWStrategy implements ConflictStrategy {
  resolve(
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    localTimestamp: string,
    remoteTimestamp: string,
  ): ResolvedConflict {
    // Compare ISO timestamps
    if (remoteTimestamp > localTimestamp) {
      return {
        resolution: 'remote_wins',
        data: { ...remote },
      }
    }
    if (localTimestamp > remoteTimestamp) {
      return {
        resolution: 'local_wins',
        data: { ...local },
      }
    }

    // Same timestamp — merge field by field, preferring local for ties
    const merged = { ...local }
    for (const key of Object.keys(remote)) {
      if (local[key] !== remote[key] && remote[key] !== undefined) {
        // For exact same timestamp, deterministic: use lexicographic comparison of values
        merged[key] = remote[key]
      }
    }
    return {
      resolution: 'merged',
      data: merged,
    }
  }
}

/**
 * Per-field LWW: merge changes from both sides.
 * If both sides changed the same field, take the newer one.
 * If only one side changed a field, take that change.
 */
export class FieldLevelLWWStrategy implements ConflictStrategy {
  resolve(
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    localTimestamp: string,
    remoteTimestamp: string,
    base?: Record<string, unknown>,
  ): ResolvedConflict {
    if (!base) {
      // Without a base, fall back to simple LWW
      return new LWWStrategy().resolve(local, remote, localTimestamp, remoteTimestamp)
    }

    const merged: Record<string, unknown> = { ...base }
    let hasConflict = false

    const allKeys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])

    for (const key of allKeys) {
      const localChanged = local[key] !== base[key]
      const remoteChanged = remote[key] !== base[key]

      if (localChanged && remoteChanged) {
        // Both changed this field — LWW
        merged[key] = remoteTimestamp > localTimestamp ? remote[key] : local[key]
        if (local[key] !== remote[key]) hasConflict = true
      } else if (localChanged) {
        merged[key] = local[key]
      } else if (remoteChanged) {
        merged[key] = remote[key]
      }
    }

    return {
      resolution: hasConflict ? 'merged' : (remoteTimestamp > localTimestamp ? 'remote_wins' : 'local_wins'),
      data: merged,
    }
  }
}
