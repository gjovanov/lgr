import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loginForApp } from './helpers/login'
import { apiLogin, type ApiSession } from './helpers/api'

/**
 * FR-27.11 acceptance 10 (#529) — price visibility per role, walked in the browser. The two stores' lists of FR-27.11.B
 * are built on roles, through the roles API (from the Seller's capabilities) and once through the role editor, given to
 * throwaway users, and walked over:
 *   - the Products grid and its cog;
 *   - an old `?sortBy=tier_3` URL;
 *   - the product form;
 *   - the stock tab;
 *   - the Select-price options and `/pricing/resolve`;
 *   - the API's own answers (by id, a hidden sort).
 * The Administrator's reads of the same article are the control.
 *
 * Opt-in, never in CI: its own project (`field-walk`), skipped unless WALK_ORG is set. The org must be on `roles`
 * (FR-27.11.B: enforced only there).
 *
 *   cd packages/e2e
 *   BASE_URL=<server> WALK_ORG=<org on roles> WALK_ADMIN=<admin> WALK_ADMIN_PASSWORD=... WALK_BUILD=<tag> \
 *     bunx playwright test --project=field-walk field-walk-fr27-11
 *
 * It writes a markdown table to `test-results/walk-fr27-11.md` before asserting, so a failing walk keeps its evidence.
 * ⚠ Only a demo org, never a customer's. The walk's users are deactivated, its roles deleted and its article
 * deactivated at the end.
 */

const ORG = process.env.WALK_ORG ?? ''
const ADMIN = process.env.WALK_ADMIN ?? 'admin'
const ADMIN_PASSWORD = process.env.WALK_ADMIN_PASSWORD ?? ''
const API = process.env.BASE_URL || 'http://localhost:4001'
const STAMP = Date.now().toString(36)
const PASSWORD = `Walk-2711-${STAMP}!`
const TIERS = ['Доставна цена', 'Цена на едро', 'Цена 0', 'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4', 'Цена 5', 'Цена 6', 'Цена 7', 'Цена 8', 'Цена 9', 'Цена 10']
const LEVEL = (name: string) => (name === 'Цена на едро' ? 'products.price:wholesale' : `products.price:${name.replace('Цена ', '')}`)

test.describe.configure({ mode: 'serial' })
test.skip(!ORG, 'set WALK_ORG (a demo org on `roles`) to run the FR-27.11 walk')

/** FR-27.11.B: what each store's Seller sees (cost figures, Цена на едро and Цена 0 hidden everywhere). */
interface List { key: string; store: string; visible: string[]; how: 'roles API' | 'role editor' }
const LISTS: List[] = [
  { key: 'pz-api', store: 'regal-pz', visible: ['Цена 1', 'Цена 2'], how: 'roles API' },
  { key: 'sf-api', store: 'regal-sf', visible: ['Цена 6', 'Цена 7'], how: 'roles API' },
  { key: 'pz-editor', store: 'regal-pz', visible: ['Цена 1', 'Цена 2'], how: 'role editor' },
]

interface Walker extends List { username: string; id?: string; roleId?: string }
const walkers: Walker[] = LISTS.map(l => ({ ...l, username: `walk2711-${l.key}-${STAMP}` }))
const rows: Record<string, string>[] = []
let admin: ApiSession
let productId = ''
const sku = `WALK-2711-${STAMP}`

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

const tierNamesOf = (p: any): string[] => (p?.priceTiers ?? []).map((t: any) => t.name)
const priceTierHeaders = (headers: string[]) => headers.filter(h => TIERS.includes(h))

/** No figure gated on the cost figures is on the page (FR-27.7's `data-cap`, FR-27.11.D). */
async function costFiguresShown(page: Page): Promise<number> {
  return page.locator('[data-cap~="products.costs"]:not([data-cap-hidden])').count()
}

/** The Seller's capabilities with one store's levels: every price level but the visible ones, and the costs, go. */
function storeCaps(sellerCaps: string[], visible: string[]): string[] {
  const hidden = new Set(['products.costs', ...TIERS.filter(n => n !== 'Доставна цена' && !visible.includes(n)).map(LEVEL)])
  return [...new Set([...sellerCaps.filter(c => !hidden.has(c)), 'products.price:selling', 'products.price:other', ...visible.map(LEVEL)])]
}

/** The same list made by hand in the editor: Products at View, and its "Prices it may see" ticks. */
async function roleThroughEditor(page: Page, name: string, visible: string[]): Promise<string> {
  await page.goto('/settings/roles')
  await page.getByTestId('role-new').click()
  await page.getByTestId('role-new-name').locator('input').fill(name)
  await page.getByTestId('role-new-save').click()
  await page.waitForURL(/\/settings\/roles\/[0-9a-f]{24}/)
  const roleId = page.url().split('/').pop()!
  await page.locator('[data-cap="products:view"]').check({ force: true })
  for (const cap of ['products.price:selling', 'products.price:other', ...visible.map(LEVEL)]) {
    await page.locator(`[data-cap="${cap}"] input`).check({ force: true })
  }
  await page.getByTestId('role-save').click()
  await page.waitForLoadState('networkidle')
  return roleId
}

test.beforeAll(async ({ browser }) => {
  admin = await apiLogin(ORG, ADMIN, ADMIN_PASSWORD)
  const me = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${admin.token}` } }).then(r => r.json())
  expect(me.access, `${ORG} must be on \`roles\` (FR-27.11.B is enforced only there)`).toBeTruthy()

  const roles = await api(admin, 'GET', '/roles')
  const seller = (roles.json.roles ?? []).find((r: any) => r.templateKey === 'seller')
  expect(seller, 'the built-in Seller role').toBeTruthy()

  const product = await api(admin, 'POST', '/warehouse/product', {
    sku, name: `Walk FR-27.11 ${STAMP}`, category: 'Общи', type: 'goods', unit: 'pcs', purchasePrice: 9, sellingPrice: 20,
    priceTiers: TIERS.map((name, i) => ({ name, percent: 10 * i, finalPrice: 10 + i })),
  })
  expect(product.status, JSON.stringify(product.json)).toBeLessThan(300)
  productId = String(product.json.product?._id ?? product.json.product?.id)

  const context = await browser.newContext()
  const page = await context.newPage()
  await loginForApp(page, ORG, ADMIN, ADMIN_PASSWORD)
  for (const w of walkers) {
    const name = `Walk ${w.store} Seller (${w.how}) ${STAMP}`
    if (w.how === 'roles API') {
      const made = await api(admin, 'POST', '/roles', { name, caps: storeCaps(seller.caps, w.visible) })
      expect(made.status, `role ${w.key}: ${JSON.stringify(made.json)}`).toBeLessThan(300)
      w.roleId = made.json.role.id
    } else {
      w.roleId = await roleThroughEditor(page, name, w.visible)
    }
    const created = await api(admin, 'POST', '/user', { email: `${w.username}@walk.invalid`, username: w.username, password: PASSWORD, firstName: 'Walk', lastName: w.key, role: 'member' })
    expect(created.status, `user ${w.key}: ${JSON.stringify(created.json)}`).toBeLessThan(300)
    w.id = String(created.json?.user?._id ?? created.json?.user?.id)
    const given = await api(admin, 'PUT', `/user/${w.id}`, { roleId: w.roleId })
    expect(given.status, `role to ${w.key}: ${JSON.stringify(given.json)}`).toBeLessThan(300)
  }
  await context.close()
})

test("each store's list, over the surfaces FR-27.11 names", async ({ browser }) => {
  for (const w of walkers) {
    const session = await apiLogin(ORG, w.username, PASSWORD)
    const byId = await api(session, 'GET', `/warehouse/product/${productId}`)
    const hiddenSort = await api(session, 'GET', '/warehouse/product?sortBy=tier_3')
    const options = await api(session, 'GET', `/pricing/options?productId=${productId}&all=true`)

    const context = await browser.newContext()
    const page = await context.newPage()
    await loginForApp(page, ORG, w.username, PASSWORD)

    await page.goto(`/inventory/products?q=${encodeURIComponent(sku)}`)
    await page.waitForLoadState('networkidle')
    const gridHeaders = (await page.locator('thead th').allInnerTexts()).map(s => s.trim())
    const gridCosts = await costFiguresShown(page)
    await page.locator('button:has(.mdi-cog)').first().click()
    const cog = (await page.locator('.v-overlay--active .v-list-item-title').allInnerTexts()).map(s => s.trim())
    await page.keyboard.press('Escape')

    // What the list ASKS for: the address bar keeps the old key until the list next writes it; the list must not.
    const listSorts: string[] = []
    const onRequest = (r: { url(): string }) => {
      const u = new URL(r.url())
      if (u.pathname.endsWith('/warehouse/product')) listSorts.push(u.searchParams.get('sortBy') ?? '(none)')
    }
    page.on('request', onRequest)
    await page.goto('/inventory/products?sortBy=tier_3')
    await page.waitForLoadState('networkidle')
    page.off('request', onRequest)
    const sortAfter = listSorts.at(-1) ?? '(no request)'
    const sortError = await page.getByText('Sorting by a price', { exact: false }).count()

    // The Pricing tab, where the slots are (`URL_TO_INTERNAL`: `/pricing`).
    await page.goto(`/inventory/products/${productId}/pricing`)
    await page.waitForLoadState('networkidle')
    const formTiers = (await page.locator('table input').evaluateAll(els => els.map(e => (e as HTMLInputElement).value))).filter(v => TIERS.includes(v))
    const formCosts = await costFiguresShown(page)

    await page.goto(`/inventory/products/${productId}/stock`)
    await page.waitForLoadState('networkidle')
    const stockCosts = await costFiguresShown(page)
    await context.close()

    rows.push({
      user: w.key,
      list: `${w.store} (${w.how}): ${w.visible.join(', ')}`,
      'API by id: tiers / purchasePrice': `${tierNamesOf(byId.json?.product).join(', ')} / ${'purchasePrice' in (byId.json?.product ?? {}) ? 'sent' : 'absent'}`,
      'API sortBy=tier_3': `${hiddenSort.status} ${hiddenSort.json?.code ?? ''}`.trim(),
      'Select-price options': (options.json?.options ?? []).map((o: any) => o.name).join(', '),
      'grid tier columns': priceTierHeaders(gridHeaders).join(', ') || '—',
      'cog tier columns': priceTierHeaders(cog).join(', ') || '—',
      'old ?sortBy=tier_3: the list asks for': `${sortAfter}${sortError ? ' (error shown)' : ''}`,
      'form tiers': formTiers.join(', ') || '—',
      'cost figures shown (grid / form / stock)': `${gridCosts} / ${formCosts} / ${stockCosts}`,
    })
  }
  const control = await api(admin, 'GET', `/warehouse/product/${productId}`)
  rows.push({ user: 'admin (control)', list: 'every level', 'API by id: tiers / purchasePrice': `${tierNamesOf(control.json?.product).length} tiers / ${'purchasePrice' in (control.json?.product ?? {}) ? 'sent' : 'absent'}`, 'API sortBy=tier_3': String((await api(admin, 'GET', '/warehouse/product?sortBy=tier_3')).status) })
  writeEvidence()

  for (const w of walkers) {
    const r = rows.find(x => x.user === w.key)!
    expect(r['API by id: tiers / purchasePrice'], w.key).toBe(`${w.visible.join(', ')} / absent`)
    expect(r['API sortBy=tier_3'], w.key).toBe('403 capability_required')
    expect(r['Select-price options'].split(', ').filter(n => TIERS.includes(n)), w.key).toEqual(w.visible)
    expect(r['grid tier columns'].split(', ').every(n => w.visible.includes(n) || n === '—'), w.key).toBe(true)
    expect(r['cog tier columns'].split(', ').filter(n => n !== '—').sort(), w.key).toEqual([...w.visible].sort())
    expect(r['old ?sortBy=tier_3: the list asks for'], w.key).not.toContain('tier_3')
    expect(r['form tiers'], w.key).toBe(w.visible.join(', '))
    expect(r['cost figures shown (grid / form / stock)'], w.key).toBe('0 / 0 / 0')
  }
  expect(rows.at(-1)!['API by id: tiers / purchasePrice']).toBe(`${TIERS.length} tiers / sent`)
  expect(rows.at(-1)!['API sortBy=tier_3']).toBe('200')
})

test.afterAll(async () => {
  if (!admin) return
  for (const w of walkers) if (w.id) await api(admin, 'DELETE', `/user/${w.id}`)
  for (const w of walkers) if (w.roleId) await api(admin, 'DELETE', `/roles/${w.roleId}`)
  if (productId) await api(admin, 'DELETE', `/warehouse/product/${productId}`)
  const left = await api(admin, 'GET', '/user?size=500')
  const active = (left.json?.users ?? []).filter((u: any) => String(u.username ?? '').startsWith('walk2711-') && u.isActive !== false).length
  rows.push({ user: 'cleanup', list: `walk users still active: ${active}` })
  writeEvidence()
})

function writeEvidence(): void {
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))]
  const md = [
    `FR-27.11 walk on ${API}, build ${process.env.WALK_BUILD ?? 'not given (WALK_BUILD)'}, org \`${ORG}\`, ${new Date().toISOString()}`,
    '',
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${columns.map(c => (r[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n')
  const dir = join(process.cwd(), 'test-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'walk-fr27-11.md'), md + '\n')
  console.log(`\n${md}\n`)
}
