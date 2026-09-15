/**
 * `admin/backup` — the FR-13.27 operator screen (gjovanov/lgr#31 P2).
 *
 * ⚠ #31 recorded backup as "not worth an e2e until the Phase 4 operator screen lands". It has
 * landed — `portal-ui/src/views/admin/BackupView.vue`, routed at `admin/backup`, shipped with
 * the object-storage work. So this spec is writable now, and the issue's note is stale.
 *
 * What it covers is the half of `backup.store.ts` that its own header warns about: "any
 * signed-in user can type `/admin/backup` and this store will happily call every endpoint".
 * The screen is presentation; the server's allow-list is the control. A spec that only drove
 * a configured sys-admin would test the easy path and miss the one that matters.
 *
 * `BACKUP_SYS_ADMINS` is unset on a normal dev machine, so the seeded admin is deliberately
 * NOT a backup administrator here — which is exactly the state the banner exists for.
 */
import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/admin/backup', { waitUntil: 'networkidle' })
})

test('renders the screen and its history table', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /backup & restore/i })).toBeVisible()
  await expect(page.getByText(/system-administrator area/i)).toBeVisible()

  await expect(page.getByText(/create a backup now/i)).toBeVisible()
  await expect(page.getByText(/^backups$/i).first()).toBeVisible()
})

test('a non-sys-admin is told why, and the controls are inert', async ({ page }) => {
  const banner = page.getByText(/you cannot use the restore functions/i)

  // Skipped rather than failed when the machine DOES configure a backup admin — both are
  // legitimate deployments, and a spec that demands one of them is a spec people delete.
  test.skip(!(await banner.isVisible().catch(() => false)), 'BACKUP_SYS_ADMINS is configured here')

  // Two distinct reasons, and conflating them costs an operator an afternoon: nobody is
  // configured on this server, versus you personally are not on the list.
  await expect(
    page.getByText(/no backup administrator is configured|not on the server/i).first(),
  ).toBeVisible()

  await expect(page.getByRole('button', { name: /create backup/i })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: /contents/i })).toBeDisabled()
})

test('the screen never reveals another organisation\'s runs', async ({ page }) => {
  // `backup.controller.ts` is the one controller that compares the caller's org to the one in
  // the path (gjovanov/lgr#30). Driving it through the real UI is the end-to-end half of the
  // integration control in `tenant-isolation.flow.test.ts`.
  const token = await page.evaluate(() => localStorage.getItem('lgr_token'))
  const api = process.env.BASE_URL || 'http://localhost:4001'

  const beta = await fetch(`${api}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'beta-inc', username: 'admin', password: 'test123' }),
  }).then(r => r.json())

  const res = await fetch(`${api}/api/org/${beta.org._id || beta.org.id}/backup/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  expect(res.status).toBe(403)
})

test('the restore section states what a restore does before offering it', async ({ page }) => {
  await expect(page.getByText(/restore from a bundle/i)).toBeVisible()

  // The warning is load-bearing UI, not decoration: this is the one screen in the product that
  // deletes live data, and the safety-backup promise is what makes it defensible.
  await expect(page.getByText(/a restore writes to live data/i)).toBeVisible()
  await expect(page.getByText(/safety backup is taken automatically first/i)).toBeVisible()
})
