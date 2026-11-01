/**
 * The POS app's old addresses, after it moved into Invoicing.
 *
 * A desktop opens the path its assignment stores (`Desktop.startPath`, `/pos/` on the tills in the
 * field), and that path is the server's to answer: the shell only re-validates it and navigates. So
 * the old URLs need an answer from the SERVER, on every node, for as long as a till, a bookmark or a
 * printed link still names one. An on-prem master runs this same file.
 *
 * ⚠ 302, never 301 (`spa-fallback.ts`, which answers with this). A browser keeps a permanent redirect
 * for good, so after a rollback a till would go on asking for a page the old release does not serve.
 *
 * ⚠ The answer is a path, never an absolute URL. It has to survive the desktop's loopback proxy
 * (`proxy.rs#rewrite_location` leaves a relative `Location` alone) and an org's own address, where
 * this node does not know the name the browser used.
 *
 * ⚠ Exactly `/pos` or `/pos/…`. `/posters` is not the POS (`startsWith('/pos')` would say so), and
 * the API's `/api/…/trade/pos/*` never reaches here at all.
 *
 * Pure, so `unit/pos-redirect.test.ts` holds the map.
 */

const TERMINAL = '/invoicing/cash-sales/new'
const JOURNAL = '/invoicing/cash-sales'
const SESSIONS = '/invoicing/cash-register/sessions'
const DEVICES = '/invoicing/configuration/devices'
const PIN = '/invoicing/pin'

/** A document's or a device's id in a path. Anything else is not an address the app ever made. */
const ID = /^[\w-]+$/

/** A file, not a page: a stale `/pos/assets/*` is the 404 any missing file gets. */
const FILE = /\.\w{2,}$/

/** `to` was relative to the old app's base: followed from the new one it would lead nowhere. */
function withoutTo(search: string): string {
  const query = new URLSearchParams(search)
  query.delete('to')
  const kept = query.toString()
  return kept ? `?${kept}` : ''
}

/** Where a GET of this path goes now, the query kept; null when it is not an old POS address. */
export function posRedirect(pathname: string, search = ''): string | null {
  if (pathname !== '/pos' && !pathname.startsWith('/pos/')) return null
  if (FILE.test(pathname)) return null

  const [section, id, ...rest] = pathname.split('/').filter(Boolean).slice(1)
  if (section === 'pin' && id === undefined) return PIN + withoutTo(search)

  const target = (() => {
    if (rest.length) return TERMINAL
    if (section === 'orders') {
      if (id === undefined) return JOURNAL
      return ID.test(id) ? `${JOURNAL}/${id}/view` : TERMINAL
    }
    if (section === 'sessions' && id === undefined) return SESSIONS
    if (section === 'devices') {
      if (id === undefined) return DEVICES
      return ID.test(id) ? `${DEVICES}/${id}` : TERMINAL
    }
    return TERMINAL
  })()
  return target + search
}
