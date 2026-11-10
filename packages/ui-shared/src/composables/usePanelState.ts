import { jwtUserId, orgIdFromStorage } from './useStorageIdentity'
import { panelStorageKey, readPanel, writePanel, type PanelStore } from './panel-state'

/**
 * FR-28.43 — the open/closed state of one screen's collapsible panels, kept in `localStorage`
 * under `lgr:ui:panels:<userId>:<orgId>:<screen>` (see `panel-state.ts`).
 *
 * userId and orgId come from this tab's session (`useStorageIdentity`), never from the keys the
 * session module owns: a tab reading `lgr_org` itself would act in whichever org another tab
 * switched to last.
 */

function browserStore(): PanelStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function usePanelState(screen: string) {
  const key = () => panelStorageKey(jwtUserId(), orgIdFromStorage(), screen)

  return {
    /** Saved state of `panelId`, else `fallback` (a panel nobody has touched keeps its default). */
    isOpen(panelId: string, fallback = true): boolean {
      return readPanel(browserStore(), key(), panelId, fallback)
    },
    setOpen(panelId: string, open: boolean): void {
      writePanel(browserStore(), key(), panelId, open)
    },
  }
}
