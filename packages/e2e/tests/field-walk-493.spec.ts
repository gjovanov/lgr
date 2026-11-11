import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loginForApp } from './helpers/login'
import { apiLogin, type ApiSession } from './helpers/api'

/**
 * #493 acceptance — the walk on a DEPLOYED build, as evidence for the issue: the Seller and the Sales Consultant,
 * each made both ways (created with the role, and created as a member then role-changed), over items 1 to 5, and the
 * throwaway users dropped after.
 *
 * Opt-in, never in CI: its own project, and it skips unless WALK_ORG is set.
 *
 *   cd packages/e2e
 *   BASE_URL=https://lgrai.app WALK_ORG=<demo-org-slug> WALK_ADMIN=<admin username> WALK_ADMIN_PASSWORD=... \
 *     WALK_BUILD=<the tag the deploy printed> bunx playwright test --project=field-walk
 *
 * It prints a markdown table to paste on #493, and writes it to `test-results/walk-493.md`. Assertions run after
 * the table is written, so a failing walk still leaves its evidence.
 *
 * ⚠ Only ever a demo org, never a customer's (FR-26 §6). The users are deactivated at the end, the only removal the
 * API has, and the walk reports how many of them are still active (0).
 */

const ORG = process.env.WALK_ORG ?? ''
const ADMIN = process.env.WALK_ADMIN ?? 'admin'
const ADMIN_PASSWORD = process.env.WALK_ADMIN_PASSWORD ?? ''
const API = process.env.BASE_URL || 'http://localhost:4001'
const PASSWORD = `Walk-493-${Date.now().toString(36)}!`
const STAMP = Date.now().toString(36)

test.describe.configure({ mode: 'serial' })
test.skip(!ORG, 'set WALK_ORG (a demo org) to run the #493 walk')

interface Walker { key: string; role: 'seller' | 'sales_consultant'; how: 'created with the role' | 'member, then role changed'; username: string; id?: string }
const walkers: Walker[] = [
  { key: 'seller-direct', role: 'seller', how: 'created with the role', username: `walk493-seller-a-${STAMP}` },
  { key: 'seller-changed', role: 'seller', how: 'member, then role changed', username: `walk493-seller-b-${STAMP}` },
  { key: 'consultant-direct', role: 'sales_consultant', how: 'created with the role', username: `walk493-consultant-a-${STAMP}` },
  { key: 'consultant-changed', role: 'sales_consultant', how: 'member, then role changed', username: `walk493-consultant-b-${STAMP}` },
]

const rows: Record<string, string>[] = []
let admin: ApiSession
let buildTag = ''

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

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
const path = (page: Page) => new URL(page.url()).pathname

async function landingOf(page: Page, from: string): Promise<string> {
  await page.goto(from)
  await page.waitForLoadState('networkidle')
  return path(page)
}

test.beforeAll(async () => {
  admin = await apiLogin(ORG, ADMIN, ADMIN_PASSWORD)
  // The deploy prints its tag; /api/health says only that the API is up.
  buildTag = process.env.WALK_BUILD ?? 'not given (WALK_BUILD)'
  for (const w of walkers) {
    const created = await api(admin, 'POST', '/user', {
      email: `${w.username}@walk.invalid`, username: w.username, password: PASSWORD, firstName: 'Walk', lastName: w.key,
      role: w.how === 'created with the role' ? w.role : 'member',
    })
    expect(created.status, `create ${w.key}: ${JSON.stringify(created.json)}`).toBeLessThan(300)
    w.id = String(created.json?.user?._id ?? created.json?.user?.id)
    if (w.how === 'member, then role changed') {
      const changed = await api(admin, 'PUT', `/user/${w.id}`, { role: w.role })
      expect(changed.status, `role change ${w.key}`).toBeLessThan(300)
    }
  }
})

test('items 1-5 for each user, as the deployed build answers them', async ({ browser }) => {
  // Four users over a deployed build, each signed in and walked page by page: minutes, not Playwright's 30 s.
  test.setTimeout(15 * 60_000)
  for (const w of walkers) {
    const session = await apiLogin(ORG, w.username, PASSWORD)
    const claims = claimsOf(session.token)
    const summary = await api(session, 'GET', '/invoices/summary?direction=outgoing&type=invoice')
    // A body the route's schema takes, so the answer is the controller's permission check (`devices.edit`): an empty
    // one is refused by the schema first (422), whoever asks. Its TCP target, 0.0.0.0, is refused under every policy
    // after that check (400), so even a session the check let through would create nothing.
    const deviceWrite = await api(session, 'POST', '/fiscal/device', {
      deviceNumber: 'WALK4930', name: 'walk #493 probe', manufacturer: 'eltrade', connectionType: 'tcp',
      connectionParams: { ip: '0.0.0.0', tcpPort: 9100 }, warehouseId: '000000000000000000000000',
    })

    const context = await browser.newContext()
    const page = await context.newPage()
    await loginForApp(page, ORG, w.username, PASSWORD)
    const signIn = path(page)
    const landings: Record<string, string> = {}
    for (const from of ['/', '/apps', '/dashboard', '/settings/users', '/admin/audit-log', '/orgs']) landings[from] = await landingOf(page, from)

    await page.goto('/invoicing/invoices')
    await page.waitForLoadState('networkidle')
    const strip = await page.getByText('Outstanding', { exact: true }).count()
    const importButton = await page.getByRole('button', { name: 'Import', exact: true }).count()

    await page.getByTestId('org-switcher').click()
    const menu = page.locator('.v-overlay--active')
    await expect(menu).toBeVisible()
    // The switcher loads the session's orgs when it opens: count once they are there.
    await menu.getByTestId('org-switcher-org').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined)
    const orgRows = await menu.getByTestId('org-switcher-org').count()
    const newOrg = await menu.getByText('New organization', { exact: true }).count()
    const allOrgs = await menu.getByText('All organizations', { exact: true }).count()
    await page.keyboard.press('Escape')

    await page.goto('/invoicing/configuration/devices')
    await page.waitForLoadState('networkidle')
    // The page's own New device (a link to the new-device form), not the top bar's „+ Нов", which has the same icon.
    const newDevice = await page.locator('a[href*="/configuration/devices/new"]').count()
    await context.close()

    rows.push({
      user: w.key,
      how: w.how,
      'claims (role, areas)': `${claims.role}, ${JSON.stringify(claims.areas ?? null)}`,
      'item 1: New device / POST fiscal/device': `${newDevice} / ${deviceWrite.status}`,
      'item 2: strip / GET invoices/summary': `${strip} / ${summary.status} ${summary.json?.code ?? ''}`.trim(),
      'item 3: sign-in, /, /apps, /dashboard, /settings/users, /admin/audit-log': [signIn, landings['/'], landings['/apps'], landings['/dashboard'], landings['/settings/users'], landings['/admin/audit-log']].join(', '),
      'item 4: org rows / New org / All orgs / /orgs →': `${orgRows} / ${newOrg} / ${allOrgs} / ${landings['/orgs']}`,
      'item 5: Import button': String(importButton),
    })
  }
  // Every other role keeps the strip: the admin still reads the summary.
  rows.push({ user: 'admin (control)', how: '', 'item 2: strip / GET invoices/summary': `- / ${(await api(admin, 'GET', '/invoices/summary?direction=outgoing&type=invoice')).status}` })

  writeEvidence()

  for (const r of rows.filter(r => r.how)) {
    expect(r['claims (role, areas)'], r.user).toMatch(/^(seller, \[\]|sales_consultant, \["orders"\])$/)
    expect(r['item 1: New device / POST fiscal/device'], r.user).toBe('0 / 403')
    expect(r['item 2: strip / GET invoices/summary'], r.user).toBe('0 / 403 capability_required')
    expect(r['item 3: sign-in, /, /apps, /dashboard, /settings/users, /admin/audit-log'].split(', ').every(p => p === '/inventory/products'), r.user).toBe(true)
    expect(r['item 4: org rows / New org / All orgs / /orgs →'], r.user).toBe('1 / 0 / 0 / /inventory/products')
    expect(r['item 5: Import button'], r.user).toBe('0')
  }
  expect(rows.at(-1)!['item 2: strip / GET invoices/summary']).toBe('- / 200')
})

test.afterAll(async () => {
  if (!admin) return
  for (const w of walkers) if (w.id) await api(admin, 'DELETE', `/user/${w.id}`)
  const left = await api(admin, 'GET', '/user?size=500')
  const active = (left.json?.users ?? []).filter((u: any) => String(u.username ?? '').startsWith('walk493-')).length
  rows.push({ user: 'cleanup', how: '', note: `walk users still active: ${active}` })
  writeEvidence()
})

function writeEvidence(): void {
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))]
  const md = [
    `Walk on ${API}, build ${buildTag}, org \`${ORG}\`, ${new Date().toISOString()}`,
    '',
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${columns.map(c => (r[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n')
  const dir = join(process.cwd(), 'test-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'walk-493.md'), md + '\n')
  console.log(`\n${md}\n`)
}
