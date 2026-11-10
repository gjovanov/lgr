/**
 * FR-28.43 — which collapsible panels of a screen the user has left open or closed.
 *
 * PURE: no Vue, no `window`. The storage is passed in, so the unit test can hand it a Map and the
 * component hands it `localStorage`. Every access is wrapped, because a private window, blocked
 * site data or a full quota makes `localStorage` throw, and a panel that cannot remember its state
 * must still open and close.
 *
 * Storage: `lgr:ui:panels:<userId>:<orgId>:<screen>` → `{ "<panelId>": true | false }`.
 * Per user, screen and organization (not per document): a user who folds the Reservations card away
 * wants it folded on the next order too, and a colleague on the same browser does not inherit it.
 */

export interface PanelStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function panelStorageKey(userId: string, orgId: string, screen: string): string {
  return `lgr:ui:panels:${userId}:${orgId}:${screen}`
}

/** Everything saved for a screen. Anything that is not a boolean is ignored, never thrown on. */
export function readPanels(store: PanelStore | null | undefined, key: string): Record<string, boolean> {
  try {
    const raw = store?.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [id, open] of Object.entries(parsed)) if (typeof open === 'boolean') out[id] = open
    return out
  } catch {
    return {}
  }
}

/** One panel's saved state, or `fallback` when it has none. */
export function readPanel(store: PanelStore | null | undefined, key: string, panelId: string, fallback: boolean): boolean {
  const saved = readPanels(store, key)[panelId]
  return typeof saved === 'boolean' ? saved : fallback
}

/**
 * Save one panel. Reads the screen's map again first, so two panels written in the same tick (or by
 * two tabs) do not overwrite each other's entry. A failed write is dropped: the panel is already
 * open or closed on screen, which is what matters.
 */
export function writePanel(store: PanelStore | null | undefined, key: string, panelId: string, open: boolean): void {
  try {
    if (!store) return
    const map = readPanels(store, key)
    map[panelId] = open
    store.setItem(key, JSON.stringify(map))
  } catch {
    /* quota / private browsing */
  }
}
