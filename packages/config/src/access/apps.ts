import { APP_IDS, APP_REGISTRY, type AppId } from '../constants'
import type { Grant } from './grant'
import { PAGE_ACCESS, canOpen } from './pages'

/**
 * FR-27.5 (#529) — the apps a role opens: those in which it opens a page, by `PAGE_ACCESS`, the rule the menus, ★
 * and „+ Нов" decide by. The App Hub's tiles in an org on `roles`, from the live grant: a role edit reaches them
 * with no sign-out, and a role that opens an app's pages without holding all of a legacy permission (which its
 * projection then leaves out) still gets the tile.
 *
 * The legacy model keeps its own answer (`APP_REGISTRY`'s permissions, `app-hub.service`), exactly as before.
 *
 * Import-pure.
 */
export function appsOpenedBy(grant: Grant | null | undefined): AppId[] {
  if (!grant) return []
  if (grant.all) return [...APP_IDS]
  const pages = Object.keys(PAGE_ACCESS)
  return APP_IDS.filter(app => {
    const base = APP_REGISTRY[app].path
    return pages.some(id => id.startsWith(base) && canOpen(id, grant))
  })
}
