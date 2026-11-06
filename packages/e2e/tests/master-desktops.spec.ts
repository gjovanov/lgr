import { test, expect } from '@playwright/test'
import { master, masterSignIn } from './helpers/master'

/**
 * FR-20.29 — pairing a till with a master, from the Desktops page (`scripts/master-stack.ts`).
 *
 * On a master a pairing code names the master's LAN address, whatever address the admin is using,
 * and carries the fingerprint of the master's own CA, which the till pins. A code typed by hand
 * carries none, so the page shows the CA's six words beside it for the person to compare with the
 * ones the till shows (`desktop.service.ts#enrollmentTarget`).
 */
test.skip(!master.url, 'no master to run against: run packages/e2e/scripts/master-stack.ts')

test.describe('a master\'s Desktops page', () => {
  test('a pairing code names the LAN and pins the CA, with its six words beside it', async ({ page }) => {
    await masterSignIn(page)
    await page.goto('/settings/desktops', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /register a desktop/i }).click()
    const words = page.locator('[data-test="fingerprint-words"]')
    await expect(words).toBeVisible({ timeout: 15000 })
    await expect(words).toHaveText(master.words)
    expect(master.words.split(' ')).toHaveLength(6)
    // The deep link, for a till that opens it: the LAN address and the fingerprint, never the
    // address this browser came in by.
    // By role: the label also names the field's copy button.
    const link = page.getByRole('textbox', { name: /open this link on that machine/i })
    await expect(link).toHaveValue(new RegExp(`^lgr://enroll\\?server=${encodeURIComponent(master.lanUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}&code=`))
    await expect(link).toHaveValue(new RegExp(`&fp=${encodeURIComponent(master.fingerprint).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  })

  test('the till paired at setup is listed, and active', async ({ page }) => {
    await masterSignIn(page)
    await page.goto('/settings/desktops', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('E2E till', { exact: true })).toBeVisible({ timeout: 15000 })
  })
})
