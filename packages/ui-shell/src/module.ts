import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'

/**
 * FR-24.3: what a UI module is, as data. Each package exports one (`src/manifest.ts`), and a router
 * is composed from manifests: today each SPA's own (POS inside invoicing's), from Phase 2 the one
 * SPA's.
 *
 * ⚠ Paths in `routes`, `menu`, breadcrumbs and back-to values are relative to the MODULE
 * ("/orders"), never to a router's base. Where the module sits in a router is the path of its
 * shell record (`moduleRoutes`), and `inModule` (ui-shared/nav/open-page) adds it.
 */
export interface ModuleMenuItem {
  /** i18n key of the label. */
  labelKey: string
  /** i18n key of a second line that settles what the label alone leaves open (FR-22 D-1). */
  subtitleKey?: string
  icon?: string
  /** Module-relative path. */
  to?: string
  children?: ModuleMenuItem[]
  /** Shown only while this answers true (the till's "switch operator" where a PIN is offered). */
  when?: () => boolean
}

export interface ModuleManifest {
  /** The app's id: `APP_NAV_META` / `APP_REGISTRY` / `OrgApp.appId`. */
  id: string
  /** The module's base URL ("/invoicing", "/invoicing/pos"). */
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

/**
 * The route records a module contributes to a router whose history base is `routerBase`: its
 * outside routes and one shell record, `{ path: <prefix>, meta: { module } }`, holding its routes.
 * The prefix is the module's base minus the router's ("" for its own SPA, "/pos" inside invoicing).
 */
export function moduleRoutes(manifest: ModuleManifest, layout: Component | (() => Promise<unknown>), routerBase: string): RouteRecordRaw[] {
  const base = routerBase.replace(/\/+$/, '')
  if (manifest.base !== base && !manifest.base.startsWith(`${base}/`)) {
    throw new Error(`Module ${manifest.id} (${manifest.base}) is not under this router's base ${routerBase}`)
  }
  const prefix = manifest.base.slice(base.length)
  const outside = (manifest.outside ?? []).map(r => ({ ...r, path: `${prefix}/${r.path}` }) as RouteRecordRaw)
  return [
    ...outside,
    { path: prefix || '/', component: layout as any, meta: { module: manifest.id }, children: manifest.routes } as RouteRecordRaw,
  ]
}
