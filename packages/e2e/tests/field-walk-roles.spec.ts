import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE_ACCESS, can, canOpen, isCapability, type CapabilityId, type Grant } from '../../config/src/access'
import { loginForApp } from './helpers/login'
import { apiLogin, type ApiSession } from './helpers/api'

/**
 * FR-27 acceptance 4 (#529): for every built-in role and every page it opens, no page loads with a 403, and View
 * without Work shows no New, Save, Delete, Import or Export. The pages it does not open show "Not available for your
 * role" (FR-27.7) or send it to its start page, never a blank page or a crash.
 *
 * Each built-in role of the org is given to a throwaway user, whose live grant (`/auth/me`) decides which pages of
 * the registry (`config/access#PAGE_ACCESS`) it opens. On each page the walk records:
 *   - every API answer 403 while the page loads;
 *   - "Not available" on a page the role opens;
 *   - a control gated by `v-cap` shown though the role lacks it (`data-cap`, FR-27.7);
 *   - a New / Save / Delete / Import / Export button not gated by `v-cap`, in the page's own content, where the
 *     role holds none of the page's feature's work actions (or that export or import);
 *   - an uncaught error in the page.
 *
 * Opt-in, never in CI: the `field-walk` project, skipped unless WALK_ORG is set. The org must be on `roles`.
 *
 *   cd packages/e2e
 *   BASE_URL=<server> WALK_ORG=<org on roles> WALK_ADMIN=<admin> WALK_ADMIN_PASSWORD=... WALK_BUILD=<tag> \
 *     bunx playwright test --project=field-walk field-walk-roles
 *
 * It writes `test-results/walk-roles.md` before asserting, so a failing walk keeps its evidence. ⚠ Only a demo org,
 * never a customer's. The walk's users are deleted at the end.
 */

const ORG = process.env.WALK_ORG ?? ''
const ADMIN = process.env.WALK_ADMIN ?? 'admin'
const ADMIN_PASSWORD = process.env.WALK_ADMIN_PASSWORD ?? ''
const API = process.env.BASE_URL || 'http://localhost:4001'
const STAMP = Date.now().toString(36)
const PASSWORD = `Walk-Roles-${STAMP}!`
/** How many of the pages a role does not open are visited, spread over the registry. */
const REFUSED_SAMPLE = 6

test.describe.configure({ mode: 'serial' })
test.skip(!ORG, 'set WALK_ORG (a demo org on `roles`) to run the roles walk')

interface Walker { key: string; name: string; roleId: string; username: string; id?: string }
interface Finding { role: string; page: string; kind: string; detail: string }

const walkers: Walker[] = []
const findings: Finding[] = []
const summary: Record<string, string>[] = []
let admin: ApiSession

async function api(session: ApiSession, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}/api/org/${session.orgId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

/** The session's grant as the server holds it: its role's, live. */
async function liveGrant(session: ApiSession): Promise<Grant> {
  const me = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${session.token}` } }).then(r => r.json())
  const access = me.access
  if (!access) throw new Error(`${ORG} answered no live grant: is it on \`roles\`?`)
  return access.all ? { all: true } : { caps: new Set((access.caps as string[]).filter(isCapability) as CapabilityId[]) }
}

/** A page's feature: the one its first capability names (`sales-docs.view` → `sales-docs`). */
const featureOf = (pageId: string) => String(PAGE_ACCESS[pageId]?.anyOf[0] ?? '').split('.')[0]
const has = (grant: Grant, cap: string) => isCapability(cap) && can(grant, cap as CapabilityId)

/** The labels of the write controls, in the four locales' words for them. */
const WRITE = /^\s*\+?\s*(new|save|delete|import|export|нов|нова|ново|запази|запиши|изтрий|импорт|експорт|neu|speichern|löschen|importieren|exportieren|нова|зачувај|избриши|увези|извези)\b/i
const ACTION_OF: Array<[RegExp, 'create' | 'edit' | 'delete' | 'import' | 'export']> = [
  [/^\s*\+?\s*(new|нов|нова|ново|neu)/i, 'create'],
  [/^\s*(save|запази|запиши|speichern|зачувај)/i, 'edit'],
  [/^\s*(delete|изтрий|löschen|избриши)/i, 'delete'],
  [/^\s*(import|импорт|importieren|увези)/i, 'import'],
  [/^\s*(export|експорт|exportieren|извези)/i, 'export'],
]

/**
 * Whether this grant may do what a button so labelled does on a page of this feature. A qualified action counts as
 * its own (`movements.create:transfer` makes a movement). Import is the feature's own `import` where the catalogue has
 * one, else a create (an import makes documents). Export is the feature's own `export` where the catalogue has one;
 * elsewhere it re-renders what the page already shows, and FR-27 has no rule for it.
 */
function mayPress(grant: Grant, feature: string, label: string): boolean {
  if (grant.all) return true
  const action = ACTION_OF.find(([re]) => re.test(label))?.[1]
  if (!action) return true
  const holds = (cap: string) => [...grant.caps].some(c => c === cap || c.startsWith(`${cap}:`))
  const creates = () => holds(`${feature}.create`) || holds(`${feature}.edit`)
  if (action === 'create' || action === 'edit') return creates()
  if (action === 'delete') return holds(`${feature}.delete`)
  if (action === 'import') return isCapability(`${feature}.import`) ? has(grant, `${feature}.import`) : creates()
  return isCapability(`${feature}.export`) ? has(grant, `${feature}.export`) : true
}

/** What the page shows once it has loaded: the gated controls shown, and the write buttons no gate covers. */
async function readPage(page: Page): Promise<{ gated: string[]; writes: string[]; notAvailable: boolean }> {
  return page.evaluate((writeSource) => {
    const write = new RegExp(writeSource, 'i')
    const visible = (e: Element) => {
      const el = e as HTMLElement
      if (!el.isConnected || el.closest('[data-cap-hidden]')) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
    }
    const gated = [...document.querySelectorAll('[data-cap]:not([data-cap-hidden])')]
      .filter(visible)
      .map(e => e.getAttribute('data-cap') ?? '')
    // The page's own content: not the top bar, the side menu or a menu that is not open.
    const main = document.querySelector('.v-main') ?? document.body
    const writes = [...main.querySelectorAll('button, a.v-btn, [role="button"]')]
      .filter(e => visible(e) && !e.closest('[data-cap]') && !e.closest('.v-navigation-drawer, .v-app-bar, .v-overlay:not(.v-overlay--active)'))
      .map(e => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(t => t && write.test(t))
    return { gated, writes: [...new Set(writes)], notAvailable: !!document.querySelector('[data-testid="not-available"]') }
  }, WRITE.source)
}

/** Load a page as the role, and what it said on the way: 403s and uncaught errors. */
async function visit(page: Page, path: string): Promise<{ refused: string[]; errors: string[]; landed: string }> {
  const refused: string[] = []
  const errors: string[] = []
  const onResponse = (r: any) => {
    if (r.status() === 403 && r.url().includes('/api/')) refused.push(`${r.request().method()} ${new URL(r.url()).pathname.replace(/\/org\/[0-9a-f]{24}/, '/org/:orgId')}`)
  }
  const onError = (e: Error) => errors.push(e.message.slice(0, 160))
  page.on('response', onResponse)
  page.on('pageerror', onError)
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
    await page.waitForTimeout(300)
  } finally {
    page.off('response', onResponse)
    page.off('pageerror', onError)
  }
  return { refused, errors, landed: new URL(page.url()).pathname }
}

test.beforeAll(async () => {
  admin = await apiLogin(ORG, ADMIN, ADMIN_PASSWORD)
  await liveGrant(admin)
  const roles = await api(admin, 'GET', '/roles')
  expect(roles.status, JSON.stringify(roles.json)).toBe(200)
  const builtin = (roles.json.roles ?? []).filter((r: any) => r.isBuiltin)
  expect(builtin.length, 'the built-in roles (FR-27.3)').toBeGreaterThanOrEqual(10)
  for (const r of builtin) {
    const key = String(r.templateKey ?? r.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const w: Walker = { key, name: r.name, roleId: String(r.id ?? r._id), username: `walkroles-${key}-${STAMP}` }
    const created = await api(admin, 'POST', '/user', { email: `${w.username}@walk.invalid`, username: w.username, password: PASSWORD, firstName: 'Walk', lastName: key, role: 'member' })
    expect(created.status, `user ${key}: ${JSON.stringify(created.json)}`).toBeLessThan(300)
    w.id = String(created.json?.user?._id ?? created.json?.user?.id)
    const given = await api(admin, 'PUT', `/user/${w.id}`, { roleId: w.roleId })
    expect(given.status, `role to ${key}: ${JSON.stringify(given.json)}`).toBeLessThan(300)
    walkers.push(w)
  }
})

test('every built-in role, every page it opens, and a sample of those it does not', async ({ browser }) => {
  test.setTimeout(90 * 60_000)
  const pages = Object.keys(PAGE_ACCESS)
  for (const w of walkers) {
    const session = await apiLogin(ORG, w.username, PASSWORD)
    const grant = await liveGrant(session)
    const opens = pages.filter(p => canOpen(p, grant))
    const refusedPages = pages.filter(p => !canOpen(p, grant))
    const sample = refusedPages.filter((_, i) => i % Math.max(1, Math.ceil(refusedPages.length / REFUSED_SAMPLE)) === 0).slice(0, REFUSED_SAMPLE)

    const context = await browser.newContext()
    const page = await context.newPage()
    await loginForApp(page, ORG, w.username, PASSWORD)
    const before = findings.length
    const note = (pageId: string, kind: string, detail: string) => findings.push({ role: w.name, page: pageId, kind, detail })

    for (const pageId of opens) {
      const { refused, errors } = await visit(page, pageId)
      for (const r of refused) note(pageId, '403 on load', r)
      for (const e of errors) note(pageId, 'page error', e)
      const seen = await readPage(page)
      if (seen.notAvailable) note(pageId, '"Not available" on a page the role opens', '')
      for (const caps of seen.gated) {
        const known = caps.split(/\s+/).filter(isCapability) as CapabilityId[]
        if (known.length && !can(grant, known) && !pageId.startsWith('/settings/roles')) note(pageId, 'gated control shown', caps)
      }
      const feature = featureOf(pageId)
      for (const label of seen.writes) if (!mayPress(grant, feature, label)) note(pageId, 'write control without its action', `"${label}" (${feature})`)
    }

    let sentAway = 0
    for (const pageId of sample) {
      const { errors, landed } = await visit(page, pageId)
      for (const e of errors) note(pageId, 'page error (not opened)', e)
      const seen = await readPage(page)
      const target = pageId.split('?')[0].replace(/\/+$/, '')
      if (seen.notAvailable || landed.replace(/\/+$/, '') !== target) sentAway++
      else note(pageId, 'opened though the role does not open it', `landed on ${landed}`)
    }

    summary.push({
      role: w.name,
      'pages it opens': String(opens.length),
      'not opened (sampled)': `${sample.length} of ${refusedPages.length}, sent away: ${sentAway}`,
      findings: String(findings.length - before),
    })
    await context.close()
  }
  writeEvidence()
  expect(findings, 'see test-results/walk-roles.md').toEqual([])
})

test.afterAll(async () => {
  if (!admin) return
  for (const w of walkers) if (w.id) await api(admin, 'DELETE', `/user/${w.id}`)
  const left = await api(admin, 'GET', '/user?size=500')
  const active = (left.json?.users ?? []).filter((u: any) => String(u.username ?? '').startsWith('walkroles-') && u.isActive !== false).length
  summary.push({ role: 'cleanup', 'pages it opens': `walk users still active: ${active}` })
  writeEvidence()
})

function writeEvidence(): void {
  const table = (rows: Record<string, string>[]) => {
    if (!rows.length) return ['(none)']
    const columns = [...new Set(rows.flatMap(r => Object.keys(r)))]
    return [
      `| ${columns.join(' | ')} |`,
      `|${columns.map(() => '---').join('|')}|`,
      ...rows.map(r => `| ${columns.map(c => (r[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
    ]
  }
  const md = [
    `FR-27 acceptance 4 walk on ${API}, build ${process.env.WALK_BUILD ?? 'not given (WALK_BUILD)'}, org \`${ORG}\`, ${new Date().toISOString()}`,
    '',
    ...table(summary),
    '',
    '### Findings',
    '',
    ...table(findings.map(f => ({ role: f.role, page: f.page, kind: f.kind, detail: f.detail }))),
  ].join('\n')
  const dir = join(process.cwd(), 'test-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'walk-roles.md'), md + '\n')
  console.log(`\n${md}\n`)
}
