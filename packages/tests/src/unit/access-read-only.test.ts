import { describe, it, expect, afterAll } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { setSession } from 'ui-shared/session/session'
import { setLiveAccess } from 'ui-shared/access/live-grant'
import { capShows, vCap } from 'ui-shared/access/v-cap'
import { opensTarget } from 'ui-shared/access/page-access'
import { CAPABILITIES } from 'config/access'

/**
 * FR-27.7 (#529) — generic read-only. A role that reads a feature and does not work on it sees its pages without New,
 * Save or Delete: `v-cap` on a control, `cap` on a form's action (`EntityFormShell`), and `CreateButton`, which shows
 * itself only for a form the role opens.
 *
 * The ratchet: a view that shows a write control or sends a write, and consults the session's access nowhere, is
 * listed in `NOT_YET`. The list only shrinks: a new view must consult access, and one fixed must leave the list.
 */

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
}
const g = globalThis as any
const real = { window: g.window, document: g.document }
if (typeof g.window === 'undefined') {
  g.window = { sessionStorage: new MemoryStorage(), localStorage: new MemoryStorage(), addEventListener() {}, location: { pathname: '/' } }
  g.document ??= { addEventListener() {}, visibilityState: 'visible' }
}
afterAll(() => {
  setLiveAccess(null)
  setSession('', null)
  g.window = real.window
  g.document = real.document
})

const token = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
const org = { id: 'o1', slug: 'o1', name: 'O1' } as any
// Reads invoicing, works on nothing: the legacy `member` reading the invoices.
const reader = { id: 'u1', orgId: 'o1', role: 'member', permissions: ['invoicing.read'], exp: 4102444800 }
const clerk = { ...reader, id: 'u2', permissions: ['invoicing.read', 'invoicing.write'] }

describe('capShows: the rule of v-cap and a form action\'s cap', () => {
  it('any one of the capabilities; none named shows; an id the catalogue does not know hides', () => {
    const grant = { caps: new Set(['contacts.view', 'contacts.edit']) } as any
    expect(capShows('contacts.edit', grant)).toBe(true)
    expect(capShows('contacts.delete', grant)).toBe(false)
    expect(capShows(['contacts.delete', 'contacts.edit'], grant)).toBe(true)
    expect(capShows(undefined, grant)).toBe(true)
    expect(capShows([], grant)).toBe(true)
    expect(capShows('contacts.edti', grant)).toBe(false)
    expect(capShows('contacts.delete', { all: true })).toBe(true)
  })

  it('the session decides: a reader is shown no write, a clerk is', () => {
    setSession(token(reader), org)
    expect(capShows('contacts.view')).toBe(true)
    expect(capShows(['contacts.create', 'contacts.edit'])).toBe(false)
    setSession(token(clerk), org)
    expect(capShows(['contacts.create', 'contacts.edit'])).toBe(true)
  })

  it('the directive hides the element, marks it, and follows the live grant', async () => {
    setSession(token(clerk), org)
    setLiveAccess(null)
    const el: any = { dataset: {}, style: {} }
    vCap.mounted!(el, { value: 'contacts.delete' } as any, null as any, null as any)
    expect(el.dataset.cap).toBe('contacts.delete')
    expect(el.style.display).toBe('')
    expect('capHidden' in el.dataset).toBe(false)
    // The role is edited: the control goes, with no reload.
    setLiveAccess({ all: false, caps: ['contacts.view'], role: { id: 'r', name: 'R', version: 'r:2' } })
    // Vue runs the effect before the next render: a tick.
    await new Promise(r => setTimeout(r, 0))
    expect(el.style.display).toBe('none')
    expect('capHidden' in el.dataset).toBe(true)
    vCap.unmounted!(el, { value: 'contacts.delete' } as any, null as any, null as any)
    setLiveAccess(null)
  })
})

describe('opensTarget: CreateButton shows only for a form the role opens', () => {
  it("a reader is offered no invoice form; a clerk is; a page the registry does not know is the server's", () => {
    setSession(token(reader), org)
    setLiveAccess(null)
    expect(opensTarget('/invoicing/invoices/new')).toBe(false)
    expect(opensTarget('/invoicing/invoices/new', { type: 'credit_note' })).toBe(false)
    setSession(token(clerk), org)
    expect(opensTarget('/invoicing/invoices/new')).toBe(true)
    expect(opensTarget('/invoicing/invoices/new', { type: 'credit_note' })).toBe(true)
    expect(opensTarget('/invoicing/nowhere/new')).toBe(true)
  })
})

// ── The views ──

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}
const VIEWS = readdirSync(join(ROOT, 'packages'))
  .filter(p => p.endsWith('-ui'))
  .flatMap(p => {
    try { return walk(join(ROOT, 'packages', p, 'src', 'views')) } catch { return [] }
  })
  .map(p => ({ file: relative(join(ROOT, 'packages'), p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

/** A view writes: it sends a write, or shows Save / Delete / an edit pencil. (`CreateButton` gates itself.) */
const WRITES = [/httpClient\.(post|put|patch|delete)\s*[<(]/, /\$t\(\s*'common\.(save|delete)'\s*\)/, /\bt\(\s*'common\.(save|delete)'\s*\)/, /mdi-delete\b/, /mdi-pencil\b/]
/** It consults the session's access: the grant, a gated control, or one of the page rules. */
const CONSULTS = [/\buseAccess\b/, /\bv-cap\b/, /\bcap:\s*(isEdit|'|\[)/, /\bcanOpenPage\b/, /\bwritesInventory\b/, /\bisTransferOnly\b/, /\brunsDevices\b/, /\bisTillOnly\b/, /\breadsDocuments\b/, /\bholdsArea\b/]

/** The person's own: their account, their password, their sign-in. No role gates these. */
const PERSONAL = new Set([
  'portal-ui/src/views/account/AccountView.vue',
  'portal-ui/src/views/account/OnpremCredentialsCard.vue',
  'portal-ui/src/views/account/TillPinCard.vue',
  'portal-ui/src/views/auth/ForgotPasswordView.vue',
  'portal-ui/src/views/auth/ResetPasswordView.vue',
  'portal-ui/src/views/idp/IdpAuthorizeView.vue',
])

/**
 * ⚠ Only shrinks. Views that write and do not consult access yet: the server refuses what the role lacks, and the
 * page still offers it. Fix one with `v-cap` / a form action's `cap`, then take it off this list.
 */
const NOT_YET = new Set([
  'files-ui/src/views/ArchivesView.vue',
  'files-ui/src/views/DocumentsView.vue',
  'files-ui/src/views/FileUploadView.vue',
  'portal-ui/src/views/admin/LicencesView.vue',
  'portal-ui/src/views/admin/NodesView.vue',
  'portal-ui/src/views/settings/BillingView.vue',
  'portal-ui/src/views/settings/DesktopsView.vue',
  'portal-ui/src/views/settings/LastNumbersCard.vue',
  'portal-ui/src/views/settings/OrganizationView.vue',
  'portal-ui/src/views/settings/PermissionSetsView.vue',
  'portal-ui/src/views/settings/RoleEditorView.vue',
  'portal-ui/src/views/settings/RolesView.vue',
  'portal-ui/src/views/settings/ServerStatusView.vue',
  'portal-ui/src/views/settings/ServersView.vue',
  'portal-ui/src/views/settings/UsersView.vue',
])

const offends = (text: string) => WRITES.some(r => r.test(text)) && !CONSULTS.some(r => r.test(text))

describe('FR-27.7: every view that writes consults access (the ratchet)', () => {
  it('finds the views', () => {
    expect(VIEWS.length).toBeGreaterThan(100)
  })

  it('a view that writes and consults nothing is on the list', () => {
    const missing = VIEWS.filter(v => offends(v.text) && !PERSONAL.has(v.file) && !NOT_YET.has(v.file)).map(v => v.file)
    expect(missing).toEqual([])
  })

  it('and leaves it once it does (or is gone)', () => {
    const byFile = new Map(VIEWS.map(v => [v.file, v.text]))
    const stale = [...NOT_YET, ...PERSONAL].filter(f => !byFile.has(f) || !offends(byFile.get(f)!))
    expect(stale).toEqual([])
  })

  it('every capability a view names is one the catalogue knows', () => {
    const named: string[] = []
    for (const v of VIEWS) {
      for (const m of v.text.matchAll(/v-cap="([^"]+)"/g)) named.push(...[...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]))
      for (const m of v.text.matchAll(/\bcap:\s*([^,}\n]+(?:\[[^\]]*\])?[^,}\n]*)/g)) named.push(...[...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]))
      // `<CreateButton cap="…">`: a plain attribute, the id itself.
      for (const m of v.text.matchAll(/(?<![-:\w])cap="([^"]+)"/g)) named.push(m[1])
    }
    expect(named.length).toBeGreaterThan(10)
    expect(named.filter(c => !CAPABILITIES.has(c))).toEqual([])
  })
})
