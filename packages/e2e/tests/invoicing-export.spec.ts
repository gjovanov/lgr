import { test, expect, type Page, type Download } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * E2E coverage for the Export dialog across all 6 invoicing list pages
 * plus the single-object export from a details page.
 *
 * The tests don't inspect the downloaded bytes — Playwright's `page.waitForEvent('download')`
 * is enough to verify the click triggered a browser-initiated file download with a
 * content-disposition response.
 */

const LIST_PAGES: Array<{ name: string; path: string }> = [
  { name: 'sales invoices', path: '/trade/sales-invoices' },
  { name: 'proforma invoices', path: '/trade/proforma-invoices' },
  { name: 'credit notes', path: '/trade/credit-notes' },
  { name: 'debit notes', path: '/trade/debit-notes' },
  { name: 'cash sales', path: '/trade/cash-sales' },
  { name: 'purchase invoices', path: '/trade/purchase-invoices' },
]

async function openExportDialog(page: Page) {
  const trigger = page.getByRole('button', { name: /^export$/i }).first()
  await expect(trigger).toBeVisible({ timeout: 10000 })
  await trigger.click()
  // Dialog: the ExportDialog card has a Download button — that's the easiest stable signal
  await expect(page.locator('.v-overlay--active .v-card')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i })).toBeVisible()
}

async function clickDownloadAndWait(page: Page): Promise<Download> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i }).click(),
  ])
  return download
}

for (const { name, path } of LIST_PAGES) {
  test.describe(`Export — ${name}`, () => {
    test(`opens export dialog and downloads XLSX compact (${name})`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(path)
      await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

      await openExportDialog(page)
      // Defaults are xlsx + compact — just click Download.
      const dl = await clickDownloadAndWait(page)
      expect(dl.suggestedFilename()).toMatch(/\.xlsx$/i)
      // Verify real bytes: XLSX is a ZIP, magic bytes 'PK' (0x50 0x4b)
      const stream = await dl.createReadStream()
      if (stream) {
        const chunk = await new Promise<Buffer>((resolve) => {
          stream.once('data', (c: Buffer) => resolve(c))
        })
        expect(chunk[0]).toBe(0x50)
        expect(chunk[1]).toBe(0x4b)
      }
    })

    test(`downloads PDF detailed (${name})`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(path)
      await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

      await openExportDialog(page)
      await page.getByRole('radio', { name: /pdf/i }).click()
      await page.getByRole('radio', { name: /detailed/i }).click()

      // Capture the API response to assert status (200 on success; 503 if Chromium deps missing)
      const responsePromise = page.waitForResponse(
        (r) => r.url().includes('/invoicing/export/list') && r.request().method() === 'POST',
        { timeout: 30000 },
      )
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null)
      await page.locator('.v-overlay--active').getByRole('button', { name: /^download$/i }).click()

      const response = await responsePromise
      // Must never be raw 500 — controller catches PDF failures and returns 503
      expect(response.status()).not.toBe(500)

      if (response.status() === 200) {
        const dl = await downloadPromise
        expect(dl?.suggestedFilename()).toMatch(/\.pdf$/i)
        const stream = await dl!.createReadStream()
        if (stream) {
          const chunk = await new Promise<Buffer>((resolve) => {
            stream.once('data', (c: Buffer) => resolve(c))
          })
          // PDF magic: %PDF
          expect(Array.from(chunk.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46])
        }
      } else {
        // Graceful degradation: 503 with structured message
        expect([403, 404, 503]).toContain(response.status())
        const body = await response.json().catch(() => ({}))
        expect(body.message).toBeTruthy()
      }
    })
  })
}

test.describe('Export — single invoice from details', () => {
  test('opens invoice details and downloads XLSX', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/sales-invoices')
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

    // Click first number cell to open details
    const firstLink = page.locator('.v-data-table a, .v-data-table [role="link"]').first()
    if (!(await firstLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No invoices in fixture to open details page')
      return
    }
    await firstLink.click()
    await expect(page.getByRole('heading', { name: /edit invoice/i })).toBeVisible({ timeout: 10000 })

    await openExportDialog(page)
    await page.getByRole('radio', { name: /excel/i }).click()
    const dl = await clickDownloadAndWait(page)
    expect(dl.suggestedFilename()).toMatch(/\.xlsx$/i)
  })
})

test.describe('Status chip — history popup', () => {
  test('clicking a status chip opens timeline dialog', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/sales-invoices')
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

    const chip = page.locator('.v-data-table .v-chip').first()
    if (!(await chip.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No status chips in fixture')
      return
    }
    await chip.click()
    // StatusChip dialog title comes from i18n "Status history"
    await expect(page.getByText(/status history/i)).toBeVisible({ timeout: 5000 })
    // Timeline entries render as v-timeline-item
    const items = page.locator('.v-timeline-item')
    expect(await items.count()).toBeGreaterThan(0)
  })
})
