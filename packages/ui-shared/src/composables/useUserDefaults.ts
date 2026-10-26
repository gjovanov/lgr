import { jwtUserId, orgIdFromStorage } from './useStorageIdentity'

/**
 * What a user's documents start with, per user and org (FR-22 §5.9): the `lgr:<feature>:<user>:<org>`
 * keys every preference uses, identified through this tab's session (`useStorageIdentity`), never
 * by reading the session keys directly. Storage may be unavailable (private browsing): every read
 * falls back to "nothing remembered" and every write is best-effort.
 */

function key(feature: string, userId = jwtUserId(), orgId = orgIdFromStorage()): string {
  return `lgr:${feature}:${userId}:${orgId}`
}

/**
 * The warehouse the user pinned on a document form (the invoicing forms' pin button, stored under
 * `lgr:default-wh:<user>:<org>`). A pin saved before the user was known sits under `anon` and is
 * honoured until the user pins again — as the invoicing forms read it.
 */
export function pinnedWarehouseId(): string {
  try {
    return localStorage.getItem(key('default-wh')) || localStorage.getItem(key('default-wh', 'anon')) || ''
  } catch {
    return ''
  }
}

/** A remembered on/off choice: `null` when the user never made it. */
export function rememberedFlag(feature: string): { read(): boolean | null; write(on: boolean): void } {
  return {
    read() {
      try {
        const v = localStorage.getItem(key(feature))
        return v === null ? null : v === '1'
      } catch {
        return null
      }
    },
    write(on: boolean) {
      try {
        localStorage.setItem(key(feature), on ? '1' : '0')
      } catch { /* private browsing — nothing remembered */ }
    },
  }
}
