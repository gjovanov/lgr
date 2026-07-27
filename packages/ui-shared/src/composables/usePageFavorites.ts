import { ref } from 'vue'
import { jwtUserId, orgIdFromStorage } from './useStorageIdentity'

/**
 * Per-user favorites + most-used tracking for individual PAGES/functions (Sales Invoices,
 * Products, Journal Entries…), surfaced in the global top-bar ★ menu across all apps.
 *
 * - Favorites are explicitly pinned by the user (star) and shown first, in pin order.
 * - "Frequent" is auto-derived from how often each page is opened (a localStorage counter
 *   bumped by recordOpen from a shared router.afterEach), capped at FREQUENT_LIMIT.
 *
 * Page ids are the full app-prefixed path (e.g. "/invoicing/invoices"), globally unique
 * across apps — so favorites/usage span every app. State is a module-level singleton so all
 * consumers within one SPA share reactive state. Persistence: `lgr:page-favorites:<userId>:<orgId>`
 * (string[]) and `lgr:page-usage:<userId>:<orgId>` (Record<id, count>), keyed like the other prefs.
 */

const FREQUENT_LIMIT = 6

const favorites = ref<string[]>([])
const usage = ref<Record<string, number>>({})
let currentKey = ''

function favKey() {
  return `lgr:page-favorites:${jwtUserId()}:${orgIdFromStorage()}`
}
function usageKey() {
  return `lgr:page-usage:${jwtUserId()}:${orgIdFromStorage()}`
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** Re-read from storage only when the user/org discriminator changes (e.g. org switch). */
function syncFromStorage() {
  const key = `${jwtUserId()}:${orgIdFromStorage()}`
  if (key === currentKey) return
  currentKey = key
  const favs = readJson<any>(favKey(), [])
  favorites.value = Array.isArray(favs) ? favs.filter((x) => typeof x === 'string') : []
  const use = readJson<any>(usageKey(), {})
  usage.value = use && typeof use === 'object' && !Array.isArray(use) ? use : {}
}

export interface HasId {
  id: string
}

export function usePageFavorites() {
  syncFromStorage()

  function persistFavorites() {
    try {
      if (!favorites.value.length) localStorage.removeItem(favKey())
      else localStorage.setItem(favKey(), JSON.stringify(favorites.value))
    } catch {
      /* quota / private browsing */
    }
  }
  function persistUsage() {
    try {
      localStorage.setItem(usageKey(), JSON.stringify(usage.value))
    } catch {
      /* quota / private browsing */
    }
  }

  function isFavorite(id: string): boolean {
    return favorites.value.includes(id)
  }

  function toggleFavorite(id: string) {
    if (!id) return
    favorites.value = favorites.value.includes(id)
      ? favorites.value.filter((x) => x !== id)
      : [...favorites.value, id]
    persistFavorites()
  }

  function recordOpen(id: string) {
    if (!id) return
    syncFromStorage()
    usage.value = { ...usage.value, [id]: (usage.value[id] || 0) + 1 }
    persistUsage()
  }

  /**
   * Split items into favorites (pinned, in pin order), frequent (most-opened, not pinned,
   * count > 0, capped) and the rest (original order). Never drops or duplicates an item.
   */
  function groupItems<T extends HasId>(items: T[]): { favorites: T[]; frequent: T[]; rest: T[] } {
    const favSet = new Set(favorites.value)
    const favItems = favorites.value
      .map((id) => items.find((a) => a.id === id))
      .filter((a): a is T => !!a)
    const remaining = items.filter((a) => !favSet.has(a.id))
    const frequent = remaining
      .filter((a) => (usage.value[a.id] || 0) > 0)
      .sort((a, b) => (usage.value[b.id] || 0) - (usage.value[a.id] || 0))
      .slice(0, FREQUENT_LIMIT)
    const freqSet = new Set(frequent.map((a) => a.id))
    const rest = remaining.filter((a) => !freqSet.has(a.id))
    return { favorites: favItems, frequent, rest }
  }

  return { favorites, usage, isFavorite, toggleFavorite, recordOpen, groupItems }
}
