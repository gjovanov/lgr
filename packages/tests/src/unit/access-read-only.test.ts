import { describe, it, expect, afterAll } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { setSession } from 'ui-shared/session/session'
import { setLiveAccess } from 'ui-shared/access/live-grant'
import { capShows, vCap } from 'ui-shared/access/v-cap'
import { opensTarget } from 'ui-shared/access/page-access'
import { CAPABILITIES, type CapabilityId } from 'config/access'

/**
 * FR-27.7 (#529) — generic read-only. A role that reads a feature and does not work on it sees its pages without New,
 * Save or Delete: `v-cap` on a control, `cap` on a form's action (`EntityFormShell`), and `CreateButton`, which shows
 * itself only for a form the role opens.
 *
 * The ratchet: a view that shows a write control or sends a write, and consults the session's access nowhere, is
 * listed in `NOT_YET`. The list only shrinks: a new view must consult access, and one fixed must leave the list.
 *
 * FR-32.24: a view that sends its write through a function of a typed API module (`src/api/`) writes too. The write
 * functions are read from the modules themselves (one that calls `httpClient.post|put|patch|delete`), so a new module
 * is covered without a list.
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
// Reads invoicing, works on nothing (what the legacy `invoicing.read` gave), and a clerk who also works on it
// (`invoicing.write`'s). FR-27 P3-6: the roles' capabilities, written out.
const READS: CapabilityId[] = [
  'sales-docs.view', 'sales-docs.totals', 'bills.totals', 'proforma.view', 'bills.view', 'orders.view', 'payments.view', 'contacts.view',
  'cash-sales.view', 'dashboard.view', 'pricing.read', 'doc-import.read', 'org-settings.view', 'users.view', 'sales-docs.export',
  'stock-availability.check', 'org.switch',
]
const WORK: CapabilityId[] = (['sales-docs', 'proforma', 'bills', 'orders', 'payments', 'contacts'] as const)
  .flatMap(f => (['create', 'edit', 'delete'] as const).map(a => `${f}.${a}` as CapabilityId))
const reader = { id: 'u1', orgId: 'o1', exp: 4102444800, caps: READS }
const clerk = { ...reader, id: 'u2', caps: [...READS, ...WORK, 'sales-docs.import', 'stock-availability.transfer', 'doc-import.extract', 'tags.edit'] as CapabilityId[] }
/** FR-27 P3-5: a session's grant is its role's, as the sign-in and `/auth/me` say it. */
const roleOf = (who: typeof reader) => ({ all: false, caps: [...who.caps], role: { id: 'r', name: 'R', version: 'r:1' } })
const signIn = (who: typeof reader) => { setSession(token({ id: who.id, orgId: who.orgId, exp: who.exp }), org); setLiveAccess(roleOf(who)) }

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
    signIn(reader)
    expect(capShows('contacts.view')).toBe(true)
    expect(capShows(['contacts.create', 'contacts.edit'])).toBe(false)
    signIn(clerk)
    expect(capShows(['contacts.create', 'contacts.edit'])).toBe(true)
  })

  it('the directive hides the element, marks it, and follows the live grant', async () => {
    signIn(clerk)
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
    signIn(reader)
    expect(opensTarget('/invoicing/invoices/new')).toBe(false)
    expect(opensTarget('/invoicing/invoices/new', { type: 'credit_note' })).toBe(false)
    signIn(clerk)
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
/** Each UI module's own folder: the web app's modules, and the desktop shell's pages. */
const MODULE_DIRS = [
  ...readdirSync(join(ROOT, 'packages', 'web', 'src', 'modules')).map(id => join(ROOT, 'packages', 'web', 'src', 'modules', id)),
  ...readdirSync(join(ROOT, 'packages')).filter(p => p.endsWith('-ui')).map(p => join(ROOT, 'packages', p, 'src')),
]
const VIEWS = MODULE_DIRS
  .flatMap(dir => {
    try { return walk(join(dir, 'views')) } catch { return [] }
  })
  .map(p => ({ file: relative(join(ROOT, 'packages'), p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

/** A view writes: it sends a write, or shows Save / Delete / an edit pencil. (`CreateButton` gates itself.) */
const WRITES = [/httpClient\.(post|put|patch|delete)\s*[<(]/, /\$t\(\s*'common\.(save|delete)'\s*\)/, /\bt\(\s*'common\.(save|delete)'\s*\)/, /mdi-delete\b/, /mdi-pencil\b/]
/** It consults the session's access: the grant, a gated control, or one of the page rules. */
const CONSULTS = [/\buseAccess\b/, /\bgrantOfViewer\b/, /\bv-cap\b/, /\bcap:\s*(isEdit|'|\[)/, /\bcanOpenPage\b/, /\bwritesInventory\b/, /\bisTransferOnly\b/, /\brunsDevices\b/, /\bisTillOnly\b/, /\breadsDocuments\b/, /\bholdsArea\b/]

/** The person's own: their account, their password, their sign-in. No role gates these. */
const PERSONAL = new Set([
  'web/src/modules/portal/views/account/AccountView.vue',
  'web/src/modules/portal/views/account/OnpremCredentialsCard.vue',
  'web/src/modules/portal/views/account/TillPinCard.vue',
  'web/src/modules/portal/views/auth/ForgotPasswordView.vue',
  'web/src/modules/portal/views/auth/ResetPasswordView.vue',
  'web/src/modules/portal/views/idp/IdpAuthorizeView.vue',
])

/**
 * A page that opens only for the capability every one of its writes needs, or a platform operator's page no org role
 * reaches: the page rule is the gate, and nothing on it is offered to someone the server would refuse.
 */
const PAGE_GATED = new Set([
  // `/settings/billing` opens with `billing.manage`, which every Stripe call needs.
  'web/src/modules/portal/views/settings/BillingView.vue',
  // `/admin/nodes`, `/admin/licences`: lgrai.app's operators (the sys-admin list), not an org's roles.
  'web/src/modules/portal/views/admin/NodesView.vue',
  'web/src/modules/portal/views/admin/LicencesView.vue',
])

/**
 * ⚠ Only shrinks. Views that write and do not consult access yet: the server refuses what the role lacks, and the
 * page still offers it. Fix one with `v-cap` / a form action's `cap`, then take it off this list.
 */
const NOT_YET = new Set([
  // `/settings/roles` opens with `roles.edit`; the role tools (#644) change these two views, so they wait for it.
  'web/src/modules/portal/views/settings/RoleEditorView.vue',
  'web/src/modules/portal/views/settings/RolesView.vue',
])

/**
 * FR-32.24: the write functions of every UI package's API modules, by module (`web/src/modules/inventory/api/warehouses`). A
 * module's exported function writes when its own body sends a write: `httpClient.post|put|patch|delete`.
 */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkTs(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}
const SENDS_WRITE = WRITES[0]
function writeFunctionsOf(source: string): string[] {
  const starts = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/g)]
  return starts
    .filter((m, i) => SENDS_WRITE.test(source.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : source.length)))
    .map(m => m[1] ?? m[2])
}
const API_WRITES = new Map<string, Set<string>>(
  MODULE_DIRS
    .flatMap(dir => {
      try { return walkTs(join(dir, 'api')) } catch { return [] }
    })
    .map(p => [relative(join(ROOT, 'packages'), p).split('\\').join('/').replace(/\.ts$/, ''), new Set(writeFunctionsOf(readFileSync(p, 'utf8')))]),
)

/** The module an import names, by its path from `packages/` without the extension; null when it is not an API module. */
function apiModuleOf(file: string, spec: string, modules: Map<string, Set<string>>): string | null {
  const pkg = file.split('/')[0]
  const path = spec.startsWith('@/') ? `${pkg}/src/${spec.slice(2)}` : spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)) : null
  if (!path) return null
  const bare = path.replace(/\.ts$/, '')
  return modules.has(bare) ? bare : modules.has(`${bare}/index`) ? `${bare}/index` : null
}

/** FR-32.24: the view calls a write function it imports from an API module (under the name it imports it as). */
function writesThroughModule(file: string, text: string, modules = API_WRITES): boolean {
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const mod = apiModuleOf(file, m[2], modules)
    if (!mod) continue
    const names = modules.get(mod)!
    for (const part of m[1].split(',')) {
      const [name, local] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map(s => s.trim())
      if (!name || !names.has(name)) continue
      if (new RegExp(`\\b${local ?? name}\\s*\\(`).test(text.slice(0, m.index) + text.slice(m.index! + m[0].length))) return true
    }
  }
  return false
}

const writes = (v: { file: string; text: string }) => WRITES.some(r => r.test(v.text)) || writesThroughModule(v.file, v.text)
const offends = (v: { file: string; text: string }) => writes(v) && !CONSULTS.some(r => r.test(v.text))

describe('FR-27.7: every view that writes consults access (the ratchet)', () => {
  it('finds the views', () => {
    expect(VIEWS.length).toBeGreaterThan(100)
  })

  it('a view that writes and consults nothing is on the list', () => {
    const missing = VIEWS.filter(v => offends(v) && !PERSONAL.has(v.file) && !PAGE_GATED.has(v.file) && !NOT_YET.has(v.file)).map(v => v.file)
    expect(missing).toEqual([])
  })

  it('and leaves it once it does (or is gone)', () => {
    const byFile = new Map(VIEWS.map(v => [v.file, v.text]))
    const stale = [...NOT_YET, ...PERSONAL, ...PAGE_GATED].filter(f => !byFile.has(f) || !offends({ file: f, text: byFile.get(f)! }))
    expect(stale).toEqual([])
  })

  it('a view that writes through an API module writes (FR-32.24)', () => {
    // The write functions are read from the modules: a write is one, a read is not.
    const warehouses = API_WRITES.get('web/src/modules/inventory/api/warehouses')
    expect(warehouses?.has('deleteWarehouse')).toBe(true)
    expect(warehouses?.has('listWarehouses')).toBe(false)
    const planted = ['export async function a() { return httpClient.get(u) }', 'export const b = async (x: X) => httpClient.put(u, x)'].join('\n')
    expect(writeFunctionsOf(planted)).toEqual(['b'])
    // The two inventory screens whose only write goes through a module are seen writing, and pass by their `v-cap`.
    for (const file of ['web/src/modules/inventory/views/BulkPriceAdjustmentView.vue', 'web/src/modules/inventory/views/OpeningStockImportView.vue']) {
      const view = VIEWS.find(v => v.file === file)!
      expect({ file, writes: writes(view), offends: offends(view) }).toEqual({ file, writes: true, offends: false })
    }
  })

  it('a planted view that writes through a module and consults nothing offends (a positive control)', () => {
    const file = 'web/src/modules/inventory/views/PlantedView.vue'
    const planted = `<template><v-btn @click="go">Go</v-btn></template>
<script setup lang="ts">
import { listWarehouses, deleteWarehouse as drop } from '../api/warehouses'
async function go() { await listWarehouses(); await drop('x') }
</script>`
    expect(offends({ file, text: planted })).toBe(true)
    // The same view with the control gated passes; one that only reads does not write.
    expect(offends({ file, text: planted.replace('<v-btn ', `<v-btn v-cap="'warehouses.delete'" `) })).toBe(false)
    expect(writes({ file, text: planted.replace("await drop('x')", '') })).toBe(false)
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
