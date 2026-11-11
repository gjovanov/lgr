import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EDITOR_FEATURES, beyondLevel, isCapability, levelOf, levelsOf, type CapabilityId, type Grant } from '../../config/src/access'
import { loginForApp } from './helpers/login'
import { apiLogin, type ApiSession } from './helpers/api'

/**
 * FR-27 acceptance 3 (#529): from a blank role, in the editor, with no code, the Seller and the Sales Consultant pass
 * the FR-26 §2.1 table and #493 items 1 to 5.
 *
 * For each of the two, a blank role is made in Settings → Roles & access and given, by its radios and ticks alone, the
 * level and the extras the built-in role holds on each feature. Saved, it must hold exactly the built-in role's
 * capabilities. Then a user with it, and one with the built-in role (the control), are walked over what
 * `roles.spec.ts` asks of the two roles:
 *   - the portal is no place of theirs: /apps, /dashboard, /settings/users and /orgs land on Products (#493 items 3, 4);
 *   - the app switcher has Inventory and Invoicing, and no Portal;
 *   - the invoices list has no totals and no Import (#493 items 2, 5);
 *   - the invoicing menu: no incoming documents and no payments; Orders for the Sales Consultant only;
 *   - the inventory menu: Products and Categories, Warehouses and the movement documents, no Create, no Export;
 *   - the movement form offers Transfer only, and its list has no Import (#493 item 5);
 *   - Devices: no New Device (#493 item 1).
 *
 * Opt-in, never in CI: the `field-walk` project, skipped unless WALK_ORG is set. The org must be on `roles`.
 *
 *   cd packages/e2e
 *   BASE_URL=<server> WALK_ORG=<org on roles> WALK_ADMIN=<admin> WALK_ADMIN_PASSWORD=... WALK_BUILD=<tag> \
 *     bunx playwright test --project=field-walk field-walk-blank-roles
 *
 * English labels (the org's users read the UI in English). It writes `test-results/walk-blank-roles.md` before
 * asserting. ⚠ Only a demo org, never a customer's. Its users and roles are deleted at the end.
 */

const ORG = process.env.WALK_ORG ?? ''
const ADMIN = process.env.WALK_ADMIN ?? 'admin'
const ADMIN_PASSWORD = process.env.WALK_ADMIN_PASSWORD ?? ''
const API = process.env.BASE_URL || 'http://localhost:4001'
const STAMP = Date.now().toString(36)
const PASSWORD = `Walk-Blank-${STAMP}!`

test.describe.configure({ mode: 'serial' })
test.skip(!ORG, 'set WALK_ORG (a demo org on `roles`) to run the blank-roles walk')

type Key = 'seller' | 'sales_consultant'
interface Walker { key: Key; how: 'editor' | 'built-in'; roleId: string; username: string; id?: string }

const builtin: Record<Key, { id: string; caps: string[] }> = {} as any
const made: Record<Key, string> = {} as any
const walkers: Walker[] = []
const rows: Record<string, string>[] = []
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

const grantOf = (caps: string[]): Grant => ({ caps: new Set(caps.filter(isCapability) as CapabilityId[]) })

/** A blank role, given in the editor the built-in one's level and extras on every feature. */
async function buildInEditor(page: Page, name: string, target: Grant): Promise<string> {
  await page.goto('/settings/roles')
  await page.getByTestId('role-new').click()
  await page.getByTestId('role-new-name').locator('input').fill(name)
  await page.getByTestId('role-new-save').click()
  await page.waitForURL(/\/settings\/roles\/[0-9a-f]{24}/)
  const roleId = page.url().split('/').pop()!
  for (const f of EDITOR_FEATURES) {
    const level = levelOf(f, target)
    if (level !== 'none') await page.locator(`[data-cap="${f.id}:${level}"]`).check({ force: true })
    // The ticks a blank role's editor shows: the feature's listed extras. What the role holds beyond its levels
    // otherwise comes with what is ticked (`withImplied`, on Save); the comparison below says if it did not.
    for (const cap of beyondLevel(f, target)) {
      if (levelsOf(f).extras.includes(cap)) await page.locator(`[data-cap="${cap}"] input`).check({ force: true })
    }
  }
  await page.getByTestId('role-save').click()
  await page.waitForLoadState('networkidle')
  return roleId
}

async function menuTexts(page: Page, group: RegExp): Promise<string[]> {
  await page.locator('.top-menu-inline').getByRole('button', { name: group }).click()
  const items = page.locator('.v-overlay--active .v-list-item')
  await expect(items.first()).toBeVisible()
  const texts = (await items.allInnerTexts()).map(t => t.trim())
  await page.keyboard.press('Escape')
  return texts
}

const topMenu = async (page: Page) => (await page.locator('.top-menu-inline').getByRole('button').allInnerTexts()).map(t => t.trim())

/** FR-26 §2.1 and #493 items 1 to 5, as `roles.spec.ts` asks them: each check's answer, `ok` or what it saw. */
async function walk(page: Page, key: Key): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const check = async (name: string, fn: () => Promise<string | true>) => {
    try {
      const r = await fn()
      out[name] = r === true ? 'ok' : r
    } catch (e: any) {
      out[name] = `failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`
    }
  }

  await check('portal → Products (#493 3, 4)', async () => {
    const off: string[] = []
    for (const path of ['/apps', '/dashboard', '/settings/users', '/orgs']) {
      await page.goto(path)
      await page.waitForURL(/\/inventory\/products/, { timeout: 15_000 }).catch(() => off.push(`${path} → ${new URL(page.url()).pathname}`))
    }
    return off.length ? off.join(', ') : true
  })
  await check('switcher: Inventory, Invoicing', async () => {
    await page.locator('button:has(.mdi-apps)').first().click()
    const tiles = page.locator('.v-overlay--active .app-tile')
    await expect(tiles.first()).toBeVisible()
    const names = (await tiles.allInnerTexts()).map(t => t.trim()).sort()
    const portal = await page.locator('.v-overlay--active').getByText('Portal', { exact: true }).count()
    await page.keyboard.press('Escape')
    return names.join(',') === 'Inventory,Invoicing' && !portal ? true : `${names.join(', ')}${portal ? ', Portal' : ''}`
  })
  await check('invoices: no totals, no Import (#493 2, 5)', async () => {
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.top-menu-inline')).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')
    const totals = await page.getByText('Outstanding', { exact: true }).count()
    const imports = await page.getByRole('button', { name: 'Import', exact: true }).count()
    return !totals && !imports ? true : `totals ${totals}, Import ${imports}`
  })
  await check('invoicing menu', async () => {
    const groups = (await topMenu(page)).join('|')
    if (/incoming|payments/i.test(groups)) return `has ${groups}`
    if (key === 'sales_consultant') return /orders/i.test(groups) ? true : `no Orders: ${groups}`
    if (/orders/i.test(groups)) return `has Orders: ${groups}`
    const config = await menuTexts(page, /Configuration/)
    return config.join(',') === 'Contacts,Devices' ? true : `Configuration: ${config.join(', ')}`
  })
  await check('inventory menu, read-only', async () => {
    await page.goto('/inventory/products')
    await expect(page.locator('.top-menu-inline')).toBeVisible({ timeout: 15_000 })
    const products = await menuTexts(page, /^Products$/)
    const warehouse = await menuTexts(page, /^Warehouse$/)
    const create = await page.getByRole('link', { name: /create/i }).count()
    const exp = await page.getByRole('button', { name: /^export$/i }).count()
    const ok = products.join(',') === 'Products,Categories' && warehouse.join(',') === 'Warehouses,Stock Movement Documents' && !create && !exp
    return ok ? true : `Products: ${products.join(', ')}; Warehouse: ${warehouse.join(', ')}; Create ${create}; Export ${exp}`
  })
  await check('movements: Transfer only, no Import (#493 5)', async () => {
    await page.goto('/inventory/movements')
    await expect(page.getByRole('link', { name: /new stock movement/i })).toBeVisible({ timeout: 15_000 })
    const imports = await page.getByRole('button', { name: /^import$/i }).count()
    await page.goto('/inventory/movements/new')
    await expect(page.getByRole('combobox', { name: /type/i }).first()).toBeVisible({ timeout: 15_000 })
    await page.locator('.v-select').first().locator('.v-field').click()
    const options = page.locator('.v-overlay--active .v-list-item')
    await expect(options.first()).toBeVisible()
    const types = (await options.allInnerTexts()).map(t => t.trim())
    await page.keyboard.press('Escape')
    return types.join(',') === 'Transfer' && !imports ? true : `types: ${types.join(', ')}; Import ${imports}`
  })
  await check('devices: no New Device (#493 1)', async () => {
    await page.goto('/invoicing/configuration/devices')
    await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')
    const n = await page.getByRole('link', { name: /New Device/i }).count()
    return n ? `New Device ${n}` : true
  })
  return out
}

test.beforeAll(async ({ browser }) => {
  admin = await apiLogin(ORG, ADMIN, ADMIN_PASSWORD)
  const me = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${admin.token}` } }).then(r => r.json())
  expect(me.access, `${ORG} must be on \`roles\``).toBeTruthy()
  const roles = await api(admin, 'GET', '/roles')
  for (const key of ['seller', 'sales_consultant'] as const) {
    const r = (roles.json.roles ?? []).find((x: any) => x.isBuiltin && x.templateKey === key)
    expect(r, `the built-in ${key}`).toBeTruthy()
    builtin[key] = { id: String(r.id ?? r._id), caps: r.caps }
  }

  const context = await browser.newContext()
  const page = await context.newPage()
  await loginForApp(page, ORG, ADMIN, ADMIN_PASSWORD)
  for (const key of ['seller', 'sales_consultant'] as const) {
    made[key] = await buildInEditor(page, `Walk blank ${key} ${STAMP}`, grantOf(builtin[key].caps))
  }
  await context.close()

  for (const key of ['seller', 'sales_consultant'] as const) {
    for (const how of ['editor', 'built-in'] as const) {
      const w: Walker = { key, how, roleId: how === 'editor' ? made[key] : builtin[key].id, username: `walkblank-${key.replace('_', '-')}-${how === 'editor' ? 'ed' : 'bi'}-${STAMP}` }
      const created = await api(admin, 'POST', '/user', { email: `${w.username}@walk.invalid`, username: w.username, password: PASSWORD, firstName: 'Walk', lastName: `${key} ${how}`, role: 'member' })
      expect(created.status, `user ${w.username}: ${JSON.stringify(created.json)}`).toBeLessThan(300)
      w.id = String(created.json?.user?._id ?? created.json?.user?.id)
      const given = await api(admin, 'PUT', `/user/${w.id}`, { roleId: w.roleId })
      expect(given.status, `role to ${w.username}: ${JSON.stringify(given.json)}`).toBeLessThan(300)
      walkers.push(w)
    }
  }
})

test('the two roles built from blank in the editor are the built-in ones, and pass FR-26 §2.1 and #493 1-5', async ({ browser }) => {
  test.setTimeout(20 * 60_000)
  for (const key of ['seller', 'sales_consultant'] as const) {
    const role = await api(admin, 'GET', `/roles/${made[key]}`)
    const caps: string[] = role.json?.role?.caps ?? []
    const want = new Set(builtin[key].caps)
    const got = new Set(caps)
    const missing = [...want].filter(c => !got.has(c))
    const extra = [...got].filter(c => !want.has(c))
    rows.push({ role: key, how: 'editor: capabilities', result: !missing.length && !extra.length ? `the built-in's ${want.size}` : `missing ${missing.join(', ') || '-'}; extra ${extra.join(', ') || '-'}` })
  }
  for (const w of walkers) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await loginForApp(page, ORG, w.username, PASSWORD)
    rows.push({ role: w.key, how: w.how, ...(await walk(page, w.key)) })
    await context.close()
  }
  writeEvidence()
  for (const r of rows) {
    if (r.how === 'editor: capabilities') expect(r.result, `${r.role}: the editor's role`).toMatch(/^the built-in's/)
    else for (const [k, v] of Object.entries(r)) if (!['role', 'how'].includes(k)) expect(v, `${r.role} (${r.how}): ${k}`).toBe('ok')
  }
})

test.afterAll(async () => {
  if (!admin) return
  for (const w of walkers) if (w.id) await api(admin, 'DELETE', `/user/${w.id}`)
  for (const key of Object.keys(made) as Key[]) await api(admin, 'DELETE', `/roles/${made[key]}`)
  const left = await api(admin, 'GET', '/user?size=500')
  const active = (left.json?.users ?? []).filter((u: any) => String(u.username ?? '').startsWith('walkblank-') && u.isActive !== false).length
  rows.push({ role: 'cleanup', how: `walk users still active: ${active}` })
  writeEvidence()
})

function writeEvidence(): void {
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))]
  const md = [
    `FR-27 acceptance 3 walk on ${API}, build ${process.env.WALK_BUILD ?? 'not given (WALK_BUILD)'}, org \`${ORG}\`, ${new Date().toISOString()}`,
    '',
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${columns.map(c => (r[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n')
  const dir = join(process.cwd(), 'test-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'walk-blank-roles.md'), md + '\n')
  console.log(`\n${md}\n`)
}
