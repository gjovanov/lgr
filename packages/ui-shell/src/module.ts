import type { RouteRecordRaw } from 'vue-router'
import type { PageViewer } from 'ui-shared/nav/page-registry'

/**
 * FR-24.3: what a UI module is, as data. Each package exports one (`src/manifest.ts`), and the one
 * SPA's router is composed from them (`packages/web/src/routes.ts`).
 *
 * ⚠ Paths in `routes`, `menu`, breadcrumbs and back-to values are relative to the MODULE
 * ("/orders"), never to a router's base. Where the module sits in a router is the path of its
 * shell record (`packages/web/src/router.ts`), and `inModule` (ui-shared/nav/open-page) adds it.
 */
export interface ModuleMenuItem {
  /** i18n key of the label. Empty on a divider, which shows none. */
  labelKey: string
  /** i18n key of a second line that settles what the label alone leaves open (FR-22 D-1). */
  subtitleKey?: string
  icon?: string
  /** Module-relative path. */
  to?: string
  children?: ModuleMenuItem[]
  /** A line between two entries of a group, and nothing else. */
  divider?: boolean
  /**
   * Shown only while this answers true: for this person (a till-only session sees the till), or at
   * this place (the till's "switch operator" where a PIN is offered).
   */
  when?: (who: PageViewer | null) => boolean
}

export interface ModuleManifest {
  /** The app's id: `APP_NAV_META` / `APP_REGISTRY` / `OrgApp.appId`. */
  id: string
  /** The module's base URL ("/invoicing"). */
  base: string
  /** i18n key of the tab title (FR-24.19). */
  titleKey: string
  /** Routes inside the module's shell, relative to the module ("orders/:id"). */
  routes: RouteRecordRaw[]
  /** Routes outside the shell (a PIN pad has no session yet), relative to the module ("pin"). */
  outside?: RouteRecordRaw[]
  /** The top menu; null for a card-hub module (Reports, Files), whose hub IS the navigation. */
  menu: ModuleMenuItem[] | null
  /** Whether the module's shell carries the Pending-changes panel. */
  pendingChanges: boolean
}

/** A divider separates two entries: none is left at either end of a group, or doubled. */
function tidyDividers(items: ModuleMenuItem[]): ModuleMenuItem[] {
  return items.filter((item, i) => {
    if (!item.divider) return true
    const next = items[i + 1]
    return items.slice(0, i).some(before => !before.divider) && !!next && !next.divider
  })
}

/**
 * The menu as this person sees it: what `when` hides goes, and so does what that leaves with no
 * purpose, a group with no entries and a divider with nothing to divide. Pure, so
 * `unit/module-manifests.test.ts` holds it against the real manifests.
 */
export function visibleMenu(menu: ModuleMenuItem[], who: PageViewer | null): ModuleMenuItem[] {
  const shown = (items: ModuleMenuItem[]) => items.filter(i => !i.when || i.when(who))
  return shown(menu).flatMap((item) => {
    if (!item.children) return [item]
    const children = tidyDividers(shown(item.children))
    return children.length ? [{ ...item, children }] : []
  })
}
