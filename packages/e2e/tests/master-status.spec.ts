import { test, expect } from '@playwright/test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { master, masterSignIn } from './helpers/master'

/**
 * FR-20.98, FR-20.50 — a master's own status page (`/settings/server`, `scripts/master-stack.ts`).
 *
 * On the server itself, for the org's admins, offline above all: what the supervisor last wrote of
 * itself (`state/status.json`), what this database says of the org, and the trader's Прил. 32 fields
 * ready to copy. Here the supervisor's file is the stack's, in its shape (`status_file.rs`); the VM
 * lanes are where a real supervisor writes it. A supervisor that stopped writing is called out: the
 * page must never present an old status as the server's present.
 */
test.skip(!master.url, 'no master to run against: run packages/e2e/scripts/master-stack.ts')

const statusFile = process.env.E2E_MASTER_STATUS_FILE || ''
const supto = process.env.E2E_MASTER_SUPTO || ''

test.describe('a master\'s status page', () => {
  test('the supervisor fresh, the org homed here, and Прил. 32 ready to copy', async ({ page }) => {
    await masterSignIn(page)
    await page.goto('/settings/server', { waitUntil: 'domcontentloaded' })
    const machine = page.locator('[data-test="server-machine"]')
    await expect(machine).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-test="server-stale"]')).toHaveCount(0)
    await expect(page.locator('[data-test="server-supto"]')).toHaveText(supto)
    await expect(machine).toContainText('0.0.0-e2e')
    await expect(machine).toContainText('mongod: running')
    // The org is written here, and the till paired at setup is counted ("1 online of 1").
    const org = page.locator('[data-test="server-org"]')
    await expect(org).toContainText('On this server')
    // ⚠ No `\b`: the next label's text follows the digit with no space ("…of 1Fiscal devices").
    await expect(org).toContainText(/online of 1(?!\d)/)
    const pril32 = page.locator('[data-test="server-pril32"]')
    await expect(pril32).toContainText(master.lanUrl)
    await expect(pril32).toContainText('MongoDB')
    await expect(pril32).toContainText(supto)
    await expect(page.locator('[data-test="pril32-copy"]')).toBeEnabled()
  })

  test('a supervisor that stopped writing its status is said to have', async ({ page }) => {
    const fresh = readFileSync(statusFile, 'utf8')
    writeFileSync(`${statusFile}.frozen`, '')
    try {
      writeFileSync(statusFile, JSON.stringify({ ...JSON.parse(fresh), writtenAt: new Date(Date.now() - 10 * 60_000).toISOString() }))
      await masterSignIn(page)
      await page.goto('/settings/server', { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-test="server-stale"]')).toBeVisible({ timeout: 15000 })
    } finally {
      writeFileSync(statusFile, JSON.stringify({ ...JSON.parse(fresh), writtenAt: new Date().toISOString() }))
      rmSync(`${statusFile}.frozen`, { force: true })
    }
  })
})
