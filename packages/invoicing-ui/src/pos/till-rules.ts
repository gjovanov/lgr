import { ref } from 'vue'
import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router'
import type { ModuleMenuItem } from 'ui-shell/module'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { APP_NAV_META, canOpenPage, isTillOnly, matchPage, pageById, type PageViewer } from 'ui-shared/nav/page-registry'
import { hasOrgSession } from 'ui-shared/session/session'
import { pinOffered } from './composables/useTillPin'

/**
 * Who reaches what of the till, which lives in the invoicing module. `canOpenPage` decides; what is
 * here is how the menu, which offers a page, and the guard, which holds a link to it, ask it.
 */

/**
 * An entry shows when the person may open its page, so an accountant is not offered a terminal whose
 * every call would be refused, and a till-only session sees the till alone. One the page registry
 * does not know (the PIN pad's „Switch operator") answers to its own `when`.
 */
function offered(to: string, who: PageViewer | null): boolean {
  const page = pageById(APP_NAV_META.invoicing.base + to)
  return !page || canOpenPage(page, who)
}

/** The menu with that rule on every entry, on top of any `when` the entry brought of its own. */
export function withTillRules(menu: ModuleMenuItem[]): ModuleMenuItem[] {
  return menu.map((item) => {
    const own = item.when
    return {
      ...item,
      ...(item.to ? { when: (who: PageViewer | null) => offered(item.to!, who) && (!own || own(who)) } : {}),
      ...(item.children ? { children: withTillRules(item.children) } : {}),
    }
  })
}

/** Whether the server offers a PIN here. A ref, so the menu shows the entry once the answer is in. */
export const pinAtTill = ref(false)
let asked = false

/** FR-20.40: the next operator signs in with a PIN, where the server offers one. Asked once. */
export function pinShown(): boolean {
  if (!asked) {
    asked = true
    pinOffered().then(v => { pinAtTill.value = v })
  }
  return pinAtTill.value
}

/**
 * Where the till starts for this person: the terminal, or the journal for someone who may only read
 * it. Nowhere for someone who may do neither: the server's refusals answer them, as on any app they
 * hold nothing of.
 */
export function tillLanding(who: PageViewer | null): RouteLocationRaw | null {
  if (canOpenPage(pageById('/invoicing/cash-sales/new')!, who)) return { name: 'invoicing.cash-sales.new' }
  return canOpenPage(pageById('/invoicing/cash-sales')!, who) ? { name: 'invoicing.cash-sales' } : null
}

/**
 * Where a row of the cash-register journal opens. A till sale opens on the journal's own page, for
 * everyone: its tender, its stock and its storno chain are there, and the back-office form shows none
 * of them. So does a storno, and every row for a till-only session, which reads no documents. A
 * sale of the back office or of an import has its document page (print, email).
 */
export function journalRoute(row: { id: string; store?: string; kind?: string; origin?: string }, tillOnly: boolean): RouteLocationRaw {
  return !tillOnly && row.store === 'invoice' && row.kind === 'sale' && row.origin !== 'pos'
    ? { name: 'invoicing.cash-sales.edit', params: { id: row.id } }
    : { name: 'invoicing.cash-sales.view', params: { id: row.id } }
}

/** What the guard asks of this tab: its session, and whether the server offers a PIN here. */
export interface TillSession {
  hasOrg: boolean
  who: PageViewer | null
  pinOffered: () => Promise<boolean>
}

/**
 * Where the till's rules send a move to a module's page, or null when they have nothing to say and
 * the router's own rules go on. `web/src/router.ts` asks this before its sign-in rule:
 *  - a Pending-changes draft of a new cash sale: the back-office form it was left on, whose address
 *    is the terminal's now (`?restore=` names the entry). Before anything else, because it is not a
 *    till page: the person who wrote it may hold no `pos.*`;
 *  - with no org session, on one of the till's pages, where the server offers a PIN: the PIN pad.
 *    Every other page keeps the portal's sign-in;
 *  - someone on a page of this module they cannot use: where the till starts for them. A till page
 *    asks `canOpenPage`. Any other page is refused to a till-only session and to nobody else: an
 *    invoicing page this person lacks a right on is the server's to answer, as it always was. A
 *    page the person may use stays, and so does anyone the till has no landing for.
 */
export async function tillRedirect(
  to: Pick<RouteLocationNormalized, 'name' | 'path' | 'query' | 'fullPath' | 'matched' | 'meta'>,
  tab: TillSession = { hasOrg: hasOrgSession(), who: sessionViewer(), pinOffered },
): Promise<RouteLocationRaw | null> {
  if (to.name === 'invoicing.cash-sales.new' && to.query.restore) return { name: 'invoicing.cash-sales.draft', query: to.query }
  if (!tab.hasOrg) return to.meta.till && (await tab.pinOffered()) ? { name: 'pos.pin', query: { to: to.fullPath } } : null
  if (!to.matched.some(r => r.meta.module === 'invoicing')) return null
  const page = to.meta.till ? matchPage(to.path) : null
  const usable = to.meta.till ? !page || canOpenPage(page, tab.who) : !isTillOnly(tab.who)
  return usable ? null : tillLanding(tab.who)
}
