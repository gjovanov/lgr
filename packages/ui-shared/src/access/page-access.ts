import { computed, watch, type ComputedRef } from 'vue'
import { useRoute } from 'vue-router'
import { sessionViewer } from '../composables/useStorageIdentity'
import { goTo } from '../nav/navigate'
import { canOpenPage, pageAt, startPage, type PageDef } from '../nav/page-registry'
import { claims } from '../session/session'
import { accessSettled, settleAccess } from './live-grant'

/**
 * FR-27.7 (#529) — "Not available for your role". A layout asks this about the route it shows: `open`, `blocked`
 * (the page is not one the role opens: the layout shows `NotAvailable` instead of the view, which never mounts, so
 * none of its requests is made), or `waiting` (an org on `roles` whose live grant `/auth/me` has not answered yet,
 * and the token's claims, the role's projection, would not open it: asked now, nothing shown meanwhile).
 *
 * The same rule as the menus, ★ and „+ Нов" (`canOpenPage`), so a page that is offered always opens. Presentation:
 * the server answers every request on its own.
 */
export type PageAccessState = 'open' | 'waiting' | 'blocked'

export function searchOf(query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    for (const one of Array.isArray(v) ? v : [v]) if (one != null) params.append(k, String(one))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** The rule itself, for a path, a query string and a session: what `usePageAccess` answers. */
export function pageAccessState(path: string, search: string): { page: PageDef | null; state: PageAccessState } {
  const page = pageAt(path, search)
  if (!page) return { page, state: 'open' }
  const who = sessionViewer()
  if (!who || canOpenPage(page, who)) return { page, state: 'open' }
  return { page, state: accessSettled() ? 'blocked' : 'waiting' }
}

export function usePageAccess(): { page: ComputedRef<PageDef | null>; state: ComputedRef<PageAccessState> } {
  const route = useRoute()
  const answer = computed(() => pageAccessState(route.path, searchOf(route.query as Record<string, unknown>)))
  watch(() => answer.value.state, s => { if (s === 'waiting') settleAccess() }, { immediate: true })
  return { page: computed(() => answer.value.page), state: computed(() => answer.value.state) }
}

const LANDED = 'lgr_landed'

function membership(): string | null {
  const c = claims()
  return c?.id && c?.orgId ? `${c.id}@${c.orgId}` : null
}

/**
 * FR-27.4: the first time a membership reaches the Dashboard in a tab (after signing in, or entering the org), a
 * role with a landing page starts there instead. Once per membership and tab, so the Dashboard stays one click away.
 * An org not on `roles` has no landing, and nothing is asked.
 */
export function useRoleLanding(): void {
  const route = useRoute()
  watch(
    () => [route.path, accessSettled(), sessionViewer()?.landing] as const,
    ([path, settled]) => {
      if (path.replace(/\/+$/, '') !== '/dashboard') return
      const who = membership()
      if (!who || !claims()?.rid) return
      let landed: string | null = null
      try { landed = sessionStorage.getItem(LANDED) } catch { /* storage blocked: land every time */ }
      if (landed === who) return
      if (!settled) return settleAccess()
      try { sessionStorage.setItem(LANDED, who) } catch { /* as above */ }
      const target = startPage(sessionViewer())
      if (target !== '/dashboard') goTo(target, { replace: true })
    },
    { immediate: true },
  )
}
