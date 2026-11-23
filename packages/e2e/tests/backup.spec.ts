/**
 * `admin/backup` — the FR-13.27 operator screen (gjovanov/lgr#31 P2).
 *
 * ⚠ #31 recorded backup as "not worth an e2e until the Phase 4 operator screen lands". It has
 * landed — `web/src/modules/portal/views/admin/BackupView.vue`, routed at `admin/backup`, shipped with
 * the object-storage work. So this spec is writable now, and the issue's note is stale.
 *
 * What it covers is the half of `backup.store.ts` that its own header warns about: "any
 * signed-in user can type `/admin/backup` and this store will happily call every endpoint".
 * The screen is presentation; the server's allow-list is the control. A spec that only drove
 * a configured sys-admin would test the easy path and miss the one that matters.
 *
 * `BACKUP_SYS_ADMINS` is unset on a normal dev machine, so the seeded admin is deliberately
 * NOT a backup administrator here — which is exactly the state the banner exists for. An org's
 * own admin makes and downloads its backups; restoring one is what takes the allow-list.
 */
import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/admin/backup', { waitUntil: 'networkidle' })
})

test('renders the screen and its history table', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /backup & restore/i })).toBeVisible()
  // One line for a system administrator, another for the org's own admin: both are legitimate
  // deployments, and a spec that demands one of them is a spec people delete.
  await expect(page.getByTestId('backup-subtitle')).toHaveText(/system-administrator area|make a backup of this organisation/i)

  await expect(page.getByText(/create a backup now/i)).toBeVisible()
  await expect(page.getByText(/^backups$/i).first()).toBeVisible()
})

test('the org’s own admin is told what is theirs, and makes a backup', async ({ page }) => {
  const note = page.getByTestId('backup-org-admin-note')

  // Skipped rather than failed when the machine DOES configure a backup admin (see above).
  test.skip(!(await note.isVisible().catch(() => false)), 'BACKUP_SYS_ADMINS is configured here')

  await expect(note).toContainText(/you can make and download backups/i)
  // Two distinct reasons, and conflating them costs an operator an afternoon: nobody is
  // configured on this server, versus you personally are not on the list.
  await expect(note).toContainText(/no backup administrator is configured|not on the server/i)

  // What goes in a bundle is a system administrator's choice: an org admin's holds the records.
  await expect(page.getByRole('combobox', { name: /contents/i })).toHaveCount(0)

  const create = page.getByTestId('backup-create')
  await expect(create).toBeEnabled()
  const before = await page.getByText(/no off-site copy/i).count()
  await create.click()

  // The bundle lands in the list, marked as kept on this server only. ⚠ Or this organisation has
  // used its day's allowance, which a re-run on the same database does: then the screen must say
  // THAT, in its own words, and nothing else counts as passing.
  await expect(async () => {
    const limited = await page.getByTestId('backup-error').isVisible()
    if (limited) {
      await expect(page.getByTestId('backup-error')).toContainText(/limit of \d+ backups in 24 hours/i)
      return
    }
    expect(await page.getByText(/no off-site copy/i).count()).toBeGreaterThan(before)
  }).toPass({ timeout: 45_000 })
})

test('the navigation offers the screen to the org’s own admin', async ({ page }) => {
  // It used to be offered only to a system administrator, so an org admin reached it by typing the URL.
  await expect(page.getByTestId('nav-backup')).toBeVisible()
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

test('restore is offered only to a backup administrator, and the page says why', async ({ page }) => {
  // ⚠ Rewritten 2026-10-28. This expected the restore section on screen, but since FR-13 Phase 4
  // (2026-09-10) it renders only for a sys-admin (`BackupView.vue`, `v-if="store.sysAdmin"`), fail
  // closed — and, as the header says, the seeded admin is deliberately NOT one here. So the test
  // asked for a section the page correctly hides. What a NON-sys-admin must see: the restore
  // surface absent, and the banner that explains the 403s (the server's allow-list is the control).
  await expect(page.getByText(/you cannot use the restore functions on this screen/i)).toBeVisible()
  await expect(page.getByText(/restore from a bundle/i)).toHaveCount(0)
  await expect(page.getByText(/a restore writes to live data/i)).toHaveCount(0)
})
